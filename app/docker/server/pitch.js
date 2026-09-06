const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const log = require('./logger');

// ---------- 唱歌评分：参考音高曲线提取 ----------
//
// 原理（业界 KTV 评分的通用做法，参考 Agora 歌词评分组件 / 各类 karaoke-score 实现）：
//   1) 服务端离线提取「原唱音轨」（audio_tracks 里的第 0 条）的音高随时间变化的曲线；
//   2) 播放时前端实时检测演唱者麦克风音高（同样的 MPM 算法）；
//   3) 按播放时间对齐两条曲线，逐帧比较音分/半音偏差 => 逐行/整曲得分。
//
// 音高检测算法：McLeod Pitch Method (MPM)——真唱评分领域最常用的成熟算法之一
//   （npm 的 pitchy 库即其参考实现）。为避免在离线局域网环境引入额外前端依赖，
//   这里按其论文实现一个自包含版本，服务端与前端使用同一份算法逻辑。
//
// 曲线缓存：与 HLS 转码缓存同理，按需生成一次后落盘复用。放在独立目录
//   DATA_DIR/pitchcache，不参与 HLS 缓存的每日清理（音高曲线提取比转码更耗时，
//   且文件极小，无清理必要）。源文件被替换（mtime 变化）时自动失效重建。

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const PITCH_DIR = process.env.PITCH_CACHE_DIR || path.join(DATA_DIR, 'pitchcache');

// 分析参数：8kHz 单声道足够覆盖人声（C2~C6 ≈ 65~1050Hz），
// 窗口 1024 点 = 128ms（低频下限 ~62Hz），步长 512 点 = 64ms。
const SR = 8000;
const WIN = 1024;
const HOP = 512;
const INTERVAL = HOP / SR; // 0.064s
const MIN_FREQ = 65, MAX_FREQ = 1050;
const CLARITY_MIN = 0.9; // MPM clarity 阈值，低于此视为未发声（呼吸/伴奏残留）

// 同一首歌同一时间只允许一个提取任务在跑（多个客户端同时请求时复用）。
const building = new Map(); // song_id -> Promise

// ---------- McLeod Pitch Method ----------
// 输入一帧采样（Float32Array），输出 { freq, clarity } 或 null（无周期性）。
// 实现步骤与论文一致：
//   1) NSDF（正态化平方差函数）: 2*Σx[i]x[i+τ] / Σ(x[i]²+x[i+τ]²)
//   2) 找第一个负过零点之后的全部正峰（key maximum）
//   3) 取峰值最高者，若高于 k*最高峰(k=0.9) 的更早峰也参与候选，取最早者
//      ——这一步是 MPM 区别于朴素 ACF 的关键，能稳定避开半频/倍频错误
//   4) 抛物线插值细化峰位
function mpmDetect(frame) {
  const W = frame.length;
  const nsdf = new Float32Array(W);
  for (let tau = 0; tau < W; tau++) {
    let acf = 0, div = 0;
    for (let i = 0; i < W - tau; i++) {
      const a = frame[i], b = frame[i + tau];
      acf += a * b;
      div += a * a + b * b;
    }
    nsdf[tau] = div > 0 ? 2 * acf / div : 0;
  }

  // 找第一个负过零点（τ=0 处 NSDF 恒为 1，先跳过前几个点）
  let tauStart = 0;
  while (tauStart < W && nsdf[tauStart] > 0) tauStart++;
  while (tauStart < W && nsdf[tauStart] <= 0) tauStart++;
  if (tauStart >= W) return null;

  // 收集正峰（key maxima：局部极大且值 > 0）
  let maxVal = -1;
  const peaks = [];
  for (let tau = tauStart; tau < W - 1; tau++) {
    const v = nsdf[tau];
    if (v > 0 && v >= nsdf[tau - 1] && v >= nsdf[tau + 1]) {
      peaks.push([tau, v]);
      if (v > maxVal) maxVal = v;
    }
    // 已经远离正区间即可停止，节省时间
    if (tau > tauStart + 1 && v <= 0 && nsdf[tau - 1] <= 0 && nsdf[tau + 1] <= 0) break;
  }
  if (!peaks.length || maxVal < 0.5) return null;

  // MPM 峰选择：取第一个 >= 0.9*maxVal 的峰（兼顾基音周期与最早性）
  const threshold = 0.9 * maxVal;
  let chosen = peaks[peaks.length - 1];
  for (const [tau, v] of peaks) {
    if (v >= threshold) { chosen = [tau, v]; break; }
  }

  // 抛物线插值细化峰位置
  const [tau0, v0] = chosen;
  const vl = nsdf[tau0 - 1] || 0, vr = nsdf[tau0 + 1] || 0;
  const denom = 2 * (2 * v0 - vl - vr);
  const shift = denom !== 0 ? (vr - vl) / denom : 0;
  const tauExact = tau0 + shift;

  const freq = SR / tauExact;
  if (freq < MIN_FREQ || freq > MAX_FREQ) return null;
  return { freq, clarity: v0 };
}

function hzToMidi(hz) {
  return 69 + 12 * Math.log2(hz / 440);
}

// ---------- ffmpeg 提取 PCM ----------
// 与 hlsgen.js 同款思路：从第 0 条音轨（原唱）解码为 8kHz 单声道 f32le 裸 PCM，
// 从 stdout 分块读取，避免先把整首歌解成 wav 文件占磁盘。
function extractPCM(filepath) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-loglevel', 'error',
      '-i', filepath,
      '-map', '0:a:0',
      '-vn', '-ac', '1', '-ar', String(SR),
      '-acodec', 'pcm_f32le',
      '-f', 'f32le', '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const chunks = [];
    let errBuf = '';
    ff.stdout.on('data', d => chunks.push(d));
    ff.stderr.on('data', d => {
      errBuf += d.toString();
      if (errBuf.length > 2000) errBuf = errBuf.slice(-2000);
    });
    ff.on('error', reject);
    ff.on('close', code => {
      if (code !== 0) return reject(new Error(`ffmpeg exit ${code}: ${errBuf}`));
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const pcm = new Float32Array(Math.floor(total / 4));
      let off = 0;
      for (const c of chunks) {
        const f = new Float32Array(c.buffer, c.byteOffset, Math.floor(c.length / 4));
        pcm.set(f, off);
        off += f.length;
      }
      resolve(pcm);
    });
  });
}

// ---------- 曲线后处理 ----------
// 1) 中值平滑(3点)去孤立的倍频/半频毛刺；2) 切分音符段（稳定的音高区段），
// 供前端画「音块 + 游标」（参考 Agora 评分组件的交互范式）。
function buildSegments(midiArr) {
  const segs = [];
  const MIN_SEG_FRAMES = 3; // 至少 ~192ms 才算一个可唱音符
  let cur = null;
  for (let i = 0; i < midiArr.length; i++) {
    const m = midiArr[i];
    if (m > 0) {
      if (cur && Math.abs(m - cur.midi) < 0.6) {
        cur.end = i;
        cur.sum += m; cur.n++;
      } else {
        if (cur && cur.end - cur.start + 1 >= MIN_SEG_FRAMES) {
          segs.push({ t: cur.start * INTERVAL, d: (cur.end - cur.start + 1) * INTERVAL, m: +(cur.sum / cur.n).toFixed(1) });
        }
        cur = { start: i, end: i, midi: m, sum: m, n: 1 };
      }
    } else {
      if (cur && cur.end - cur.start + 1 >= MIN_SEG_FRAMES) {
        segs.push({ t: cur.start * INTERVAL, d: (cur.end - cur.start + 1) * INTERVAL, m: +(cur.sum / cur.n).toFixed(1) });
      }
      cur = null;
    }
  }
  if (cur && cur.end - cur.start + 1 >= MIN_SEG_FRAMES) {
    segs.push({ t: cur.start * INTERVAL, d: (cur.end - cur.start + 1) * INTERVAL, m: +(cur.sum / cur.n).toFixed(1) });
  }
  // 相邻段音高几乎相同则合并（MPM 在长音里的微小抖动会被切成多段）
  const merged = [];
  for (const s of segs) {
    const prev = merged[merged.length - 1];
    if (prev && Math.abs(prev.m - s.m) < 0.6 && Math.abs(s.t - (prev.t + prev.d)) < INTERVAL * 2) {
      prev.d = s.t + s.d - prev.t;
      prev.m = +((prev.m + s.m) / 2).toFixed(1);
    } else merged.push(s);
  }
  return merged;
}

// ---------- 主流程：懒计算 + 落盘缓存 ----------
function cachePath(id) { return path.join(PITCH_DIR, `${id}.json`); }

async function computeCurve(song) {
  const { id, filepath } = song;
  const t0 = Date.now();
  const pcm = await extractPCM(filepath);
  if (pcm.length < WIN) throw new Error('音频太短或解码为空');

  const frames = Math.floor((pcm.length - WIN) / HOP) + 1;
  const midi = new Array(frames).fill(-1);
  const frame = new Float32Array(WIN);
  for (let f = 0; f < frames; f++) {
    frame.set(pcm.subarray(f * HOP, f * HOP + WIN));
    // RMS 门限：整帧接近静音直接跳过，省一次 MPM
    let rms = 0;
    for (let i = 0; i < WIN; i++) rms += frame[i] * frame[i];
    if (Math.sqrt(rms / WIN) > 0.005) {
      const r = mpmDetect(frame);
      if (r) midi[f] = +hzToMidi(r.freq).toFixed(1);
    }
  }

  // 3 点中值平滑：只平滑有声帧，消除孤立倍频毛刺
  for (let i = 1; i < frames - 1; i++) {
    if (midi[i] > 0 && midi[i - 1] > 0 && midi[i + 1] > 0) {
      const a = midi[i - 1], b = midi[i], c = midi[i + 1];
      midi[i] = +[a, b, c].sort((x, y) => x - y)[1].toFixed(1);
    }
  }

  const segments = buildSegments(midi);
  const out = {
    interval: INTERVAL,
    midi,
    segments,
    duration: +(pcm.length / SR).toFixed(2),
  };
  fs.mkdirSync(PITCH_DIR, { recursive: true });
  const tmp = cachePath(id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out));
  fs.renameSync(tmp, cachePath(id));
  log.info('PITCH', `[歌曲 id=${id}] 参考音高曲线完成：${frames} 帧 / ${segments.length} 个音符段，耗时 ${Date.now() - t0}ms`);
  return out;
}

async function getPitchCurve(song) {
  const { id, filepath } = song;
  const cp = cachePath(id);
  try {
    const st = fs.statSync(cp);
    const src = fs.statSync(filepath);
    if (st.mtimeMs >= src.mtimeMs) {
      return JSON.parse(fs.readFileSync(cp, 'utf8'));
    }
    log.info('PITCH', `[歌曲 id=${id}] 源文件已更新，参考音高缓存失效，重新提取`);
  } catch (e) { /* 无缓存，走计算 */ }

  if (building.has(id)) return building.get(id);
  const p = computeCurve(song).catch(e => {
    log.error('PITCH', `[歌曲 id=${id}] 音高曲线提取失败: ${e.message.split('\n')[0]}`);
    building.delete(id);
    throw e;
  }).finally(() => { /* 保留 promise 引用由 catch 清理 */ });
  building.set(id, p);
  p.then(() => building.delete(id)).catch(() => {});
  return p;
}

module.exports = { getPitchCurve, PITCH_DIR, INTERVAL, mpmDetect };
