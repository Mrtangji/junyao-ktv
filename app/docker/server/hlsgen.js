const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const log = require('./logger');

// Bug 根本修复（原唱/伴唱切换会从头播放 + 拖进度条失效）：
// 旧方案在切换音轨时用 ffmpeg 现场把整段视频重新封装成一个新的 MP4 流吐给
// <video>，这个新响应体没有 Content-Length/Range 支持（长度未知），所以：
//   1) 切音轨 = 换了一个全新的、不可寻址的流 => 只能从头播放；
//   2) 切完音轨后拖进度条 = 在一个不支持 Range 的流上 seek => 同样只能从头。
// 新方案：把每首歌预先/按需转成 HLS（m3u8 + .ts 分片）。视频轨和每一条音频轨
// 各自独立切片、独立成一份 media playlist，再通过一份 master.m3u8 用
// #EXT-X-MEDIA 把所有音频轨声明成同一个 AUDIO group，与视频轨绑定。
// 前端用 hls.js 加载 master.m3u8 后，切换音轨只是 hls.audioTrack = 0/1 —
// hls.js 只会重新拉取音频分片，视频分片、播放位置完全不受影响；HLS 的分片
// 天然可寻址，拖进度条对任意音轨都正常工作。
//
// 单音轨文件兼容：master.m3u8 里只声明 1 条音频轨，hls.js/播放器行为等价于
// 普通单音轨 HLS 播放，不影响现有的"声道型"(单音轨里左右声道分别是伴唱/原唱)
// Web Audio 分离逻辑——那部分是在解码后的音频节点上做的，跟视频用什么方式
// 加载无关，继续保留在前端。
//
// 本次改动（首次点歌卡顿修复）解决两个问题：
//   1) 转码是纯 CPU 软件编码(libx264)，一首歌要转好几十秒到几分钟，点歌人
//      在这段时间里点开播放器只会一直转圈；现在优先用 VAAPI 硬件编解码，
//      在有核显/独显的机器上大幅缩短转码耗时，且运行时自动探测硬件是否
//      可用、不可用就自动回退到 libx264，不会因为某台机器没有 GPU 而直接
//      放弃转码或者报错。
//   2) 就算硬件转码，一首完整 MV 转完也需要一点时间；旧实现是"整首歌转完
//      -> 一次性 rename 上线 -> 才响应 master.m3u8"，本质上是阻塞式的，
//      用户点下去之后必须等整首歌转码完成才能看到画面。现在改成渐进式：
//      master.m3u8 一旦知道音轨数量就立刻可以生成并返回（不依赖转码是否
//      完成）；video/audioN 的分片使用 HLS "event" 播放列表类型，让 ffmpeg
//      一边转码一边持续追加分片和刷新子播放列表；分片/子播放列表的 HTTP
//      请求如果撞上"这一片还没转出来"，服务端会短暂轮询等待它出现再响应，
//      而不是直接 404 或者等全曲转完，从而做到"随出随播"。

const HLS_DIR = process.env.HLS_DIR || '/data/hls';
const SEGMENT_TIME = 6; // 秒，只是切片建议值，ffmpeg 仍会在最近的关键帧处切割

// ---------- VAAPI 硬件加速探测 ----------
const VAAPI_DEVICE = process.env.VAAPI_DEVICE || '/dev/dri/renderD128';

// 三态缓存：null=还没测过，true/false=测过的结果。避免每首歌都重新探测一次
// （探测本身要真跑一次 ffmpeg，没必要每次都做）。
let vaapiState = null;

// 只做"设备文件存在"这一层检测还不够——文件存在但驱动装错/权限不对/容器没
// 映射成功时，真正调用 h264_vaapi 编码会直接失败。所以这里额外做一次最小
// 成本的真实编码自检（1x1 帧、编码 1 帧），确保后续所有歌曲都能直接复用
// 一个可靠的判断结果，而不是每首歌自己去试错。
async function detectVAAPI() {
  if (vaapiState !== null) return vaapiState;

  log.info('VAAPI', `开始探测核显硬件加速，渲染节点: ${VAAPI_DEVICE}`);

  if (!fs.existsSync(VAAPI_DEVICE)) {
    log.warn('VAAPI', `未检测到渲染节点 ${VAAPI_DEVICE}（宿主机可能没有核显，或安装/升级时 devices 段落被自动裁掉）—— 核显调用: 失败，本次运行全程使用软件编码 (libx264)`);
    vaapiState = false;
    return false;
  }
  log.info('VAAPI', `渲染节点 ${VAAPI_DEVICE} 存在，开始做最小成本的真实编码自检（1x1帧/1帧 h264_vaapi 编码）`);

  // 顺带把 vainfo 的驱动摘要打进日志，出问题时（比如装错驱动/权限不对）一眼就能看出来，
  // 这一步失败不影响后续判断，只是尽力而为的诊断信息。
  try {
    const info = execFileSync('vainfo', { timeout: 8000 }).toString();
    const driverLine = info.split('\n').find(l => l.includes('Driver version')) || info.split('\n')[0];
    log.info('VAAPI', `vainfo 驱动信息: ${(driverLine || '').trim()}`);
  } catch (e) {
    log.warn('VAAPI', `vainfo 诊断执行失败（不影响后续判断）: ${e.message.split('\n')[0]}`);
  }

  const t0 = Date.now();
  try {
    await runFFmpeg([
      '-loglevel', 'error',
      '-init_hw_device', `vaapi=va:${VAAPI_DEVICE}`,
      '-filter_hw_device', 'va',
      '-f', 'lavfi', '-i', 'color=black:size=64x64:rate=1',
      '-frames:v', '1',
      '-vf', 'format=nv12,hwupload',
      '-c:v', 'h264_vaapi',
      '-f', 'null', '-',
    ]);
    log.info('VAAPI', `核显调用: 成功，自检耗时 ${Date.now() - t0}ms —— 后续转码将优先使用 h264_vaapi 硬件编解码`);
    vaapiState = true;
  } catch (e) {
    log.warn('VAAPI', `核显调用: 失败，自检未通过（耗时 ${Date.now() - t0}ms），原因: ${e.message.split('\n').pop()} —— 回退到软件编码 (libx264)`);
    vaapiState = false;
  }
  return vaapiState;
}

// 同一首歌同一时间只允许一个生成任务在跑，避免并发请求把 ffmpeg 打架
const building = new Map();   // song_id -> Promise（整首歌全部轨道转码完成）
const buildErrors = new Map(); // song_id -> Error（最近一次转码失败原因）

// ---------- 转码进程跟踪 / 取消 ----------
// 为什么需要：ensureHLS 是"渐进式"的——它把整首歌（视频轨 + 每条音频轨，最多
// 三条 ffmpeg 同时跑）丢到后台异步转完，且从不记录 ffmpeg 的 PID。后果是：
// 即使看电视的人已经把电视端/安卓端全关掉，服务端仍会把这首歌从头转到尾
// （一首 MV 要几分钟），KTV 场景下等于"总有一个核在转码"，CPU 长期降不下来。
//
// 这里做的两件事：
//   runningProcs —— 按歌曲 id 登记在跑的 ffmpeg 子进程，便于精确 kill；
//   canceledIds  —— "这首歌已被要求停止转码"的标记。单纯 kill 进程不够：
//                   被 kill 的 ffmpeg 退出码非 0，会走 Tier 降级逻辑又去起下
//                   一个 ffmpeg，等于换个姿势继续转。所以每层降级前都先查这个
//                   标记，一旦被取消就立刻整体抛出，不再尝试后续编码方案。
// 取消是"粘性"的：标记会一直保留到这首歌下一次被重新请求（ensureHLS 开头清除），
// 避免在途的旧 build 任务被唤醒后继续写文件。
const runningProcs = new Map(); // song_id(String) -> Set<ChildProcess>
const canceledIds = new Set();  // song_id(String)

function procKey(id) {
  return id === undefined || id === null ? null : String(id);
}
function isCanceled(id) {
  const k = procKey(id);
  return k !== null && canceledIds.has(k);
}
function canceledError() {
  return Object.assign(new Error('转码已取消（客户端已全部离线，服务端停止后台播放/转码）'), { code: 'CANCELED' });
}
function trackProc(id, child) {
  const k = procKey(id);
  if (k === null) return () => {};
  let set = runningProcs.get(k);
  if (!set) { set = new Set(); runningProcs.set(k, set); }
  set.add(child);
  return () => {
    const s = runningProcs.get(k);
    if (!s) return;
    s.delete(child);
    if (!s.size) runningProcs.delete(k);
  };
}

// 取消某一首歌的全部在途转码进程（不删 building 里的 Promise——让它自己走到
// finally 里清理，避免和"取消后紧接着又来了新请求"之间产生竞态而互相踩踏）。
function cancelSong(id) {
  const k = procKey(id);
  if (k === null) return 0;
  canceledIds.add(k);
  // 防御：取消标记会在 ensureHLS 重新请求时被清除，但为了绝对不让它在
  // "批量删除歌曲"这类场景下无限增长，超过上限就丢弃最早的标记。
  if (canceledIds.size > 512) canceledIds.delete(canceledIds.values().next().value);
  const set = runningProcs.get(k);
  let killed = 0;
  if (set) {
    for (const p of set) {
      try { p.kill('SIGKILL'); killed++; } catch (e) { /* 进程可能已自行退出 */ }
    }
    runningProcs.delete(k);
  }
  return killed;
}

// 取消当前所有在途转码。返回被取消的歌曲 id 数组，供调用方打日志/回传。
function cancelAllActive() {
  const ids = new Set([...runningProcs.keys()]);
  // building 里的任务可能刚好卡在"即将起下一个 ffmpeg"的间隙，一起标记取消，
  // 这样它下一层降级前就会自己退出。
  for (const k of building.keys()) ids.add(String(k));
  const list = [...ids];
  for (const id of list) cancelSong(id);
  return list;
}

// 当前还有几首歌在跑 ffmpeg（用于日志/状态接口展示）
function activeTranscodes() {
  return runningProcs.size;
}

// 清掉某首歌的"已取消"标记：客户端重新请求播放时，允许重新开始转码。
function clearCanceled(id) {
  const k = procKey(id);
  if (k !== null) canceledIds.delete(k);
}

function outDir(id) {
  return path.join(HLS_DIR, String(id));
}
function masterPath(id) {
  return path.join(outDir(id), 'master.m3u8');
}
function completeMarkerPath(id) {
  return path.join(outDir(id), '.complete');
}

// "新鲜"指的是这首歌之前已经完整转码成功过，且源文件之后没有被替换过，
// 可以直接复用，不需要重新转码。用一个 .complete 标记文件的 mtime 来判断，
// 而不是 master.m3u8 —— 因为现在 master.m3u8 在转码刚开始时就会写出来，
// 它的存在不再代表"转码已完成"。
function isFresh(id, srcPath) {
  const marker = completeMarkerPath(id);
  if (!fs.existsSync(marker)) return false;
  try {
    const srcStat = fs.statSync(srcPath);
    const outStat = fs.statSync(marker);
    // 源文件比已生成的 HLS 还新（比如换了同名文件），要求重新生成
    return outStat.mtimeMs >= srcStat.mtimeMs;
  } catch (e) {
    return false;
  }
}

// 判断源编码是否可以直接 -c copy 进 MPEG-TS 且能被浏览器/hls.js 解码。
// 注意：不能只靠 ffmpeg 的退出码判断"copy 是否安全"——实测对 VP8/Opus 这类
// 编码执行 -c copy 进 TS，ffmpeg 退出码是 0（不报错），但产出的是无法解码的
// 垃圾流(ffprobe 显示 codec_name=bin_data)，播放器只会一直黑屏/无声，且此时
// 完全没有异常可捕获来触发回退。所以必须提前用 ffprobe 探测编码，只有明确
// 在白名单里的编码才走 copy，其余一律直接转码，保证任何源格式最终都能出片。
const SAFE_VIDEO_CODECS = new Set(['h264']);
const SAFE_AUDIO_CODECS = new Set(['aac']);
// 确实需要重新编码时，画质/音质一律按"不降品质"配置：
//  - h264_vaapi 不指定质量参数会用编码器默认值（码率偏低，1080p 会明显发糊），
//    这里显式给恒定 QP 22（≈ libx264 crf 22），与软件编码质量对齐。老版本
//    ffmpeg 不认这个参数会直接报错，外层 Tier 结构会自动降级，最坏也只是回到
//    原来的默认质量，不会导致出不了片。
//  - AAC 音轨码率由 192k 提到 320k（原值属于被迫降质），AAC 320k 已是透明级。
//    源音轨本身是 aac 的走 -c copy 零损失，根本不会走到这一步。
const VAAPI_QUALITY = ['-qp', '22'];
const AUDIO_BITRATE = '320k';

function probeCodecName(filepath, selector) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error',
      '-select_streams', selector,
      '-show_entries', 'stream=codec_name',
      '-of', 'csv=p=0',
      filepath,
    ], { timeout: 15000 }).toString().trim();
    return out.split('\n')[0].trim().toLowerCase();
  } catch (e) {
    return ''; // 探测失败时按"未知编码"处理，走转码这条更保险的路径
  }
}

// songId 可选：传入时会把这个 ffmpeg 子进程登记到 runningProcs，便于"客户端
// 全部离线时"按歌曲精确 kill；被取消后所有 ffmpeg 调用都会以 CANCELED 结束，
// 上层据此停止 Tier 降级（不再换个编码方案接着转）。
function runFFmpeg(args, songId) {
  return new Promise((resolve, reject) => {
    if (isCanceled(songId)) return reject(canceledError());
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const untrack = trackProc(songId, ff);
    let errBuf = '';
    ff.stderr.on('data', d => {
      errBuf += d.toString();
      if (errBuf.length > 4000) errBuf = errBuf.slice(-4000);
    });
    ff.on('close', code => {
      untrack();
      if (isCanceled(songId)) return reject(canceledError());
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${errBuf}`));
    });
    ff.on('error', err => { untrack(); reject(err); });
  });
}

// hls_playlist_type 用 "event" 而不是 "vod"：
// "vod" 类型下 ffmpeg 会把整份播放列表攒在内存里，直到整个输入转码完毕才
// 一次性写出 .m3u8 文件——也就是说子播放列表文件在转码 100% 完成之前根本
// 不存在，播放器（hls.js）自然拿不到任何东西，这正是"卡住"的根源之一。
// "event" 类型会随着每一个分片产出持续增量刷新 .m3u8 文件，播放器可以在
// 转码只完成一小部分时就开始拉取已经就绪的分片播放，等追上转码进度后
// 继续边转边播；ffmpeg 在整个输入转码结束时会照常在文件末尾写入
// #EXT-X-ENDLIST，播放器据此知道后面不会再有新分片了。
function hlsOutArgs(segPattern, playlistPath) {
  return [
    '-f', 'hls',
    '-hls_time', String(SEGMENT_TIME),
    '-hls_playlist_type', 'event',
    '-hls_flags', 'independent_segments+temp_file',
    '-hls_segment_filename', segPattern,
    playlistPath,
  ];
}

// 视频轨：只有源编码是 h264 时才 -c copy 直拷贝（零转码，几乎无延迟）。
// 其余编码需要重新编码为 H.264 时，优先尝试 VAAPI 硬件转码：
//   Tier 1：解码 + 编码整条链路都走硬件（-hwaccel vaapi），效率最高，
//           但要求源视频编码本身能被 VAAPI 硬件解码器支持；
//   Tier 2：源编码硬件解不了时，退一步用软件解码、只在编码这一步用
//           h264_vaapi 硬件编码（hwupload 把软解出来的帧送上 GPU），
//           兼容性更好，依然能吃到硬件编码的加速；
//   Tier 3：以上都不行（没有 VAAPI/驱动异常/这台机器压根没有核显独显）
//           时，回退到纯软件的 libx264，保证任何机器最终都能出片。
async function buildVideoRendition(filepath, dir, songTag, songId) {
  const common = ['-loglevel', 'error', '-y', '-i', filepath, '-map', '0:v:0', '-an'];
  const out = hlsOutArgs(path.join(dir, 'video_%04d.ts'), path.join(dir, 'video.m3u8'));
  const codec = probeCodecName(filepath, 'v:0');
  const t0 = Date.now();
  if (isCanceled(songId)) throw canceledError();

  log.info('TRANSCODE', `${songTag} 视频轨: 源编码=${codec || '未知'}`);

  if (SAFE_VIDEO_CODECS.has(codec)) {
    try {
      await runFFmpeg([...common, '-c:v', 'copy', ...out], songId);
      log.info('TRANSCODE', `${songTag} 视频轨: 直接封装拷贝(copy)完成，耗时 ${Date.now() - t0}ms，未使用核显`);
      return;
    } catch (e) {
      if (isCanceled(songId)) throw canceledError();
      log.warn('TRANSCODE', `${songTag} 视频轨: h264 -c copy 仍失败，改为重新编码: ${e.message.split('\n').pop()}`);
    }
  }

  const useVaapi = await detectVAAPI();
  if (useVaapi) {
    // Tier 1：硬件解码 + 硬件编码
    const t1 = Date.now();
    try {
      await runFFmpeg([
        '-loglevel', 'error', '-y',
        '-hwaccel', 'vaapi', '-hwaccel_device', VAAPI_DEVICE, '-hwaccel_output_format', 'vaapi',
        '-i', filepath, '-map', '0:v:0', '-an',
        '-c:v', 'h264_vaapi', ...VAAPI_QUALITY,
        ...out,
      ], songId);
      log.info('TRANSCODE', `${songTag} 视频轨: 核显调用成功(Tier1 硬解+硬编 h264_vaapi)，耗时 ${Date.now() - t1}ms`);
      return;
    } catch (e) {
      if (isCanceled(songId)) throw canceledError();
      log.warn('TRANSCODE', `${songTag} 视频轨: 核显硬解+硬编失败(Tier1)，尝试软解+硬编(Tier2): ${e.message.split('\n').pop()}`);
    }

    // Tier 2：软件解码 + 硬件编码（兼容硬件解不了的源编码，仍用硬件编码加速）
    const t2 = Date.now();
    try {
      await runFFmpeg([
        ...common,
        '-vaapi_device', VAAPI_DEVICE,
        '-vf', 'format=nv12,hwupload',
        '-c:v', 'h264_vaapi', ...VAAPI_QUALITY,
        ...out,
      ], songId);
      log.info('TRANSCODE', `${songTag} 视频轨: 核显调用成功(Tier2 软解+硬编 h264_vaapi)，耗时 ${Date.now() - t2}ms`);
      return;
    } catch (e) {
      if (isCanceled(songId)) throw canceledError();
      log.warn('TRANSCODE', `${songTag} 视频轨: 核显调用失败(Tier2 软解+硬编)，回退到纯软件编码(Tier3 libx264): ${e.message.split('\n').pop()}`);
    }
  } else {
    log.info('TRANSCODE', `${songTag} 视频轨: 核显不可用，直接使用软件编码(Tier3 libx264)`);
  }

  // Tier 3：纯软件编码兜底
  const t3 = Date.now();
  await runFFmpeg([...common, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', ...out], songId);
  log.info('TRANSCODE', `${songTag} 视频轨: 软件编码(Tier3 libx264)完成，耗时 ${Date.now() - t3}ms，未使用核显`);
}

// 音频轨：只有源编码是 aac 时才 -c copy，其余编码（Opus/Vorbis/FLAC/AC3 等）
// 直接重新编码为 AAC。音频转码本身 CPU 消耗很低，没有必要也没有硬件通道，
// 继续用软件编码即可。
async function buildAudioRendition(filepath, dir, track, songTag, songId) {
  // 映射加尾缀 '?'：ffprobe 报告的音轨数可能多于 ffmpeg demux 实际认可的
  // （典型：MPEG-TS 里 codec 未知的流 ffprobe 会算作音频，ffmpeg 则丢弃），
  // 严格映射会直接 "Stream map '0:a:N' matches no streams" 失败；加 '?' 后
  // 不存在的流被忽略而不是整单失败。
  const common = ['-loglevel', 'error', '-y', '-i', filepath, '-map', `0:a:${track}?`, '-vn'];
  const out = hlsOutArgs(path.join(dir, `audio${track}_%04d.ts`), path.join(dir, `audio${track}.m3u8`));
  const codec = probeCodecName(filepath, `a:${track}`);
  const trackName = track === 0 ? '原唱' : track === 1 ? '伴唱' : `音轨${track}`;
  const t0 = Date.now();
  if (isCanceled(songId)) throw canceledError();
  log.info('TRANSCODE', `${songTag} 音轨${track}(${trackName}): 源编码=${codec || '未知'}`);
  if (SAFE_AUDIO_CODECS.has(codec)) {
    try {
      await runFFmpeg([...common, '-c:a', 'copy', ...out], songId);
      log.info('TRANSCODE', `${songTag} 音轨${track}(${trackName}): 直接封装拷贝(copy)完成，耗时 ${Date.now() - t0}ms`);
      return;
    } catch (e) {
      if (isCanceled(songId)) throw canceledError();
      log.warn('TRANSCODE', `${songTag} 音轨${track}(${trackName}): aac -c copy 仍失败，改为重新编码: ${e.message.split('\n').pop()}`);
    }
  }
  const t1 = Date.now();
  await runFFmpeg([...common, '-c:a', 'aac', '-b:a', AUDIO_BITRATE, ...out], songId);
  log.info('TRANSCODE', `${songTag} 音轨${track}(${trackName}): 软件编码(aac)完成，耗时 ${Date.now() - t1}ms`);
}

// 立即写出 master.m3u8——它只依赖"这首歌有几条音轨"这个已经存在于数据库里
// 的信息，跟视频/音频具体转码进度无关，所以不需要等任何 ffmpeg 进程完成
// 就可以先生成并让播放器拿到。播放器随后请求 video.m3u8 / audioN.m3u8 时，
// 如果对应分片还没转出来，由路由层(index.js)负责短暂等待，而不是在这里
// 阻塞。
function writeMasterPlaylist(dir, trackCount, mediaType = 'video') {
  const names = trackCount >= 2 ? ['原唱', '伴唱'] : ['原唱'];
  let m3u8 = '#EXTM3U\n#EXT-X-VERSION:6\n';
  for (let t = 0; t < trackCount; t++) {
    const name = names[t] || `音轨${t + 1}`;
    const isDefault = t === 0 ? 'YES' : 'NO';
    m3u8 += `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="${name}",DEFAULT=${isDefault},AUTOSELECT=${isDefault},URI="audio${t}.m3u8"\n`;
  }
  if (mediaType === 'audio') {
    // 纯音频 MP3 没有视频轨：用一个仅含 AUDIO group 的 master，
    // hls.js 会把音频分片挂到同一个 <video> 元素上，电视端仍可复用现有播放器。
    m3u8 += '#EXT-X-STREAM-INF:BANDWIDTH=256000,CODECS="mp4a.40.2",AUDIO="aud"\naudio0.m3u8\n';
  } else {
    m3u8 += '#EXT-X-STREAM-INF:BANDWIDTH=8000000,AUDIO="aud"\nvideo.m3u8\n';
  }
  fs.writeFileSync(path.join(dir, 'master.m3u8'), m3u8);
}

// 视频轨 + 每条音频轨的 ffmpeg 进程并发启动（Promise.all），而不是像旧版
// 那样排队一条条等——这样多条轨道是同时在产出分片的，进一步缩短"能看到第
// 一屏画面"所需的时间。全部轨道都转码成功后才写 .complete 标记；任何一条
// 失败都会被上层捕获记录，方便前端/路由层判断这首歌为什么迟迟出不了片。
// 实时探测有效音轨数（hlsgen 版）：只统计 codec_name 明确的音频流。数据库里
// 的 audio_tracks 是扫描时探测的，可能包含 ffprobe 认了、ffmpeg 却不认可的
// "未知编码"流（MPEG-TS 常见），照它映射会失败；转码前重新探一遍更可靠。
// 探测失败（文件损坏/格式不识别）回落 1，保证至少原唱轨尝试转码。
function probeAudioTrackCount(filepath) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error',
      '-analyzeduration', '10000000', '-probesize', '10000000',
      '-select_streams', 'a',
      '-show_entries', 'stream=codec_name',
      '-of', 'csv=p=0',
      filepath,
    ], { timeout: 20000 }).toString();
    const lines = out.split('\n').map(l => l.trim()).filter(l => l && !/^(unknown|n\/a)?$/i.test(l));
    return lines.length > 0 ? lines.length : 1;
  } catch (e) {
    return 1;
  }
}

async function buildHLS(song, dir) {
  const { filepath } = song;
  const songTag = `[歌曲 id=${song.id} "${song.title || song.filename}"]`;
  const t0 = Date.now();
  if (isCanceled(song.id)) throw canceledError();

  // 音轨数以现场探测为准（只认有编码名的流），探测不到再用数据库值兜底
  const trackCount = song.media_type === 'audio'
    ? 1
    : probeAudioTrackCount(filepath);

  log.info('TRANSCODE', `${songTag} 开始转码，共 ${trackCount} 条音轨（1=原唱${trackCount >= 2 ? ', 2=伴唱' : ''}）`);

  // 纯音频歌曲（当前为 MP3）没有视频流，不能调用 buildVideoRendition；
  // 只生成音频 HLS。视频歌曲则保持原有的“视频轨 + 音频轨并行”流程。
  const tasks = [];
  if (song.media_type !== 'audio') {
    tasks.push(buildVideoRendition(filepath, dir, songTag, song.id));
  }
  for (let t = 0; t < trackCount; t++) {
    tasks.push(buildAudioRendition(filepath, dir, t, songTag, song.id));
  }
  try {
    await Promise.all(tasks);
  } catch (e) {
    if (isCanceled(song.id)) {
      log.info('TRANSCODE', `${songTag} 转码已被取消（客户端离线/缓存清理），用时 ${Date.now() - t0}ms，已停止后续编码`);
      throw canceledError();
    }
    log.error('TRANSCODE', `${songTag} 转码失败，总耗时 ${Date.now() - t0}ms，原因: ${e.message.split('\n').pop()}`);
    throw e;
  }

  if (isCanceled(song.id)) throw canceledError();
  fs.writeFileSync(completeMarkerPath(song.id), String(Date.now()));
  log.info('TRANSCODE', `${songTag} 全部轨道转码完成，总耗时 ${Date.now() - t0}ms`);
}

async function ensureHLS(song) {
  const { id, filepath } = song;
  const songTag = `[歌曲 id=${id} "${song.title || song.filename}"]`;

  // 客户端（重新）请求播放 → 解除这首歌先前的"已取消"标记，允许重新开始转码。
  clearCanceled(id);

  if (isFresh(id, filepath)) {
    log.info('TRANSCODE', `${songTag} 命中已转码缓存，直接复用，不重新转码`);
    return masterPath(id);
  }

  if (building.has(id)) {
    log.info('TRANSCODE', `${songTag} 已有转码任务在后台进行中，本次请求直接复用该任务`);
  }

  if (!building.has(id)) {
    // 之前没有在跑的任务：清空旧目录（可能是上一次失败/源文件已替换留下的
    // 半成品），立刻写出 master.m3u8，然后把真正耗时的转码丢到后台异步跑，
    // 不在这里 await —— 这正是"渐进式"的关键：函数在转码真正开始产出任何
    // 一个分片之前就已经可以返回了。
    const dir = outDir(id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    // master 里引用的音轨数必须与 buildHLS 实际转的音轨数一致——都用"只认
    // 有效编码流"的现场探测值，避免 master 引用永远不会生成的 audioN.m3u8
    writeMasterPlaylist(dir, song.media_type === 'audio' ? 1 : probeAudioTrackCount(filepath), song.media_type || 'video');
    buildErrors.delete(id);

    // 注意：存进 building 的 Promise 绝不能是会 reject 的——Node 15+ 对未被
    // 接住的 promise rejection 默认按未捕获异常处理，直接把整个进程干崩
    // （实测：一条音轨映射失败的 ffmpeg 错误经 .catch 里 re-throw 后没人再
    // 接住，服务整体退出）。失败原因记进 buildErrors 即可，waitForFile 的
    // 轮询会查这张表把错误还给请求方；这里吞掉 rejection 不再往外抛。
    const p = buildHLS(song, dir)
      .catch(e => {
        // 因"客户端离线"主动取消的，不算转码失败：不写 buildErrors，否则
        // waitForFile 会把这次取消当成"转码失败"报给播放器。
        if (!isCanceled(id)) buildErrors.set(id, e);
      })
      .finally(() => building.delete(id));
    building.set(id, p);
    // 不 await —— 让转码在后台继续跑，函数立刻返回
  }

  return masterPath(id);
}

// 等待某个具体文件（子播放列表或分片）出现，供路由层在文件"还在转码中、
// 暂时不存在"时短暂轮询，而不是立刻 404 或者反过来等整首歌转完。
// 一旦文件出现就立刻 resolve，做到"随出随响应"。
// 正在等待分片出现的请求数（/api/diag 用：这类请求每 200ms 轮询一次，
// 如果异常情况下堆积，本身也会持续占一点 CPU，需要能看见）。
let pendingWaits = 0;
function pendingWaitCount() { return pendingWaits; }

// 当前登记在案的 ffmpeg 子进程 pid（供孤儿进程巡检比对，见 index.js）
function runningPids() {
  const pids = [];
  for (const set of runningProcs.values()) for (const p of set) if (p && p.pid) pids.push(p.pid);
  return pids;
}

function waitForFile(filepath, songId, { timeoutMs = 60000, intervalMs = 200 } = {}) {
  pendingWaits++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; pendingWaits--; fn(v); };
    const deadline = Date.now() + timeoutMs;
    (function poll() {
      if (fs.existsSync(filepath)) return done(resolve, filepath);
      if (buildErrors.has(songId)) {
        return done(reject, Object.assign(new Error('转码失败'), { cause: buildErrors.get(songId), code: 'BUILD_FAILED' }));
      }
      if (isCanceled(songId)) {
        return done(reject, Object.assign(new Error('转码已取消（客户端已离线，服务端已停止播放）'), { code: 'CANCELED' }));
      }
      if (Date.now() > deadline) {
        return done(reject, Object.assign(new Error('等待分片生成超时'), { code: 'TIMEOUT' }));
      }
      setTimeout(poll, intervalMs);
    })();
  });
}

function removeHLS(id) {
  // 先停掉这首歌在跑的转码进程，再删目录：否则会出现"ffmpeg 还在往这个目录
  // 写分片、目录却已经被删掉"的竞态（写失败报错 + 残留半成品）。
  cancelSong(id);
  fs.rmSync(outDir(id), { recursive: true, force: true });
  building.delete(id);
  buildErrors.delete(id);
  log.info('TRANSCODE', `[歌曲 id=${id}] 已清理 HLS 转码产物`);
}

// ---------- HLS 缓存每日清理 ----------
// HLS 转码产物（.ts 分片）只是一份可以随时重新生成的播放缓存，不是原始曲库
// 数据，但每首歌一旦转码过就会一直占着磁盘空间，曲库越大、播放过的歌越多，
// /data/hls 越滚越大，长期不清理会把 NAS 的存储空间越吃越紧。
// 之前唯一会清理这个目录的时机是 scanner.js 扫描时发现某首歌"源文件已不存在"
// 才触发的 removeHLS——也就是说只要源文件还在，哪怕这首歌几个月都没人点过，
// 它的 HLS 缓存也永远不会被回收。这里补一个独立于扫描的每日定时清理：
//   1) 孤儿目录：目录名（歌曲 id）在数据库里已经找不到对应记录——理论上
//      scanner.js 的清理逻辑会覆盖这种情况，但进程重启/异常退出等边界场景
//      可能让某次清理被跳过，这里作为兜底再兜一层。
//   2) 过期缓存：距离上一次转码完成（.complete 标记的 mtime）已经超过
//      HLS_CACHE_MAX_AGE_DAYS（默认 3 天）——这类歌曲源文件仍然存在、随时
//      可以点唱，只是最近点唱页面点这首歌就会照常触发 ensureHLS 重新生成，
//      对用户体验没有影响，只是把"不常被点的歌"占用的磁盘空间定期释放掉。
//      正在后台转码中的目录（building 里还有它，或者 .complete 还不存在）
//      一律跳过，避免清理逻辑跟正在写入的转码进程打架。
const HLS_CACHE_MAX_AGE_DAYS = Number(process.env.HLS_CACHE_MAX_AGE_DAYS) || 3;

function cleanupExpiredHLS(getValidSongIds) {
  if (!fs.existsSync(HLS_DIR)) return { scanned: 0, removed: 0 };

  let entries;
  try {
    entries = fs.readdirSync(HLS_DIR, { withFileTypes: true });
  } catch (e) {
    log.error('HLS_CLEAN', `读取 HLS 缓存目录失败，本次清理已跳过: ${e.message}`);
    return { scanned: 0, removed: 0 };
  }

  let validIds = null;
  try {
    validIds = getValidSongIds ? new Set(getValidSongIds()) : null;
  } catch (e) {
    log.warn('HLS_CLEAN', `获取有效曲目 id 列表失败，本次跳过孤儿目录清理，仅按过期时间清理: ${e.message}`);
  }

  const maxAgeMs = HLS_CACHE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let scanned = 0, removed = 0;

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue; // 只处理"数字目录名=歌曲id"这种规范产物，其它一律不动
    scanned++;
    const id = entry.name;

    if (building.has(id) || building.has(Number(id))) continue; // 正在转码中，跳过

    let reason = null;
    if (validIds && !validIds.has(Number(id)) && !validIds.has(id)) {
      reason = '对应歌曲已不在曲库中(孤儿缓存)';
    } else {
      const marker = completeMarkerPath(id);
      try {
        const st = fs.statSync(marker);
        if (now - st.mtimeMs > maxAgeMs) {
          reason = `距上次转码完成已超过 ${HLS_CACHE_MAX_AGE_DAYS} 天`;
        }
      } catch (e) {
        // .complete 不存在：要么转码还没完成过（不该在这里清），要么是一次
        // 半成品残留（上次转码中途异常退出），后者本身也该被清掉。用目录本身
        // 的 mtime 兜底判断是否"陈旧"，避免半成品目录永远留在磁盘上。
        try {
          const dirStat = fs.statSync(outDir(id));
          if (now - dirStat.mtimeMs > maxAgeMs) {
            reason = '半成品缓存目录长期未完成转码，判定为陈旧残留';
          }
        } catch (e2) { /* 目录本身都读不到，忽略，等下一轮再看 */ }
      }
    }

    if (reason) {
      try {
        fs.rmSync(outDir(id), { recursive: true, force: true });
        building.delete(id);
        buildErrors.delete(id);
        removed++;
        log.info('HLS_CLEAN', `[歌曲 id=${id}] 缓存已清理，原因: ${reason}`);
      } catch (e) {
        log.error('HLS_CLEAN', `[歌曲 id=${id}] 缓存清理失败: ${e.message}`);
      }
    }
  }

  log.info('HLS_CLEAN', `本次清理完成：共检查 ${scanned} 个缓存目录，清理 ${removed} 个`);
  return { scanned, removed };
}

// 每日定时任务：容器可能一次运行好几天甚至更久不重启，只在启动时清理一次
// 不够，这里用 setInterval 每 24 小时自动跑一次；应用刚启动时也顺带跑一次
// （延迟 5 分钟，避开启动初期的曲库全量扫描高峰，避免两个都要读写磁盘的
// 后台任务互相抢 IO）。定时器用 unref()，避免它阻止 Node 进程正常退出。
function scheduleHLSCleanup(getValidSongIds) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  setTimeout(() => cleanupExpiredHLS(getValidSongIds), 5 * 60 * 1000).unref();
  const timer = setInterval(() => cleanupExpiredHLS(getValidSongIds), DAY_MS);
  timer.unref();
  log.info('HLS_CLEAN', `HLS 缓存每日清理任务已注册，过期阈值 ${HLS_CACHE_MAX_AGE_DAYS} 天`);
}

if (!fs.existsSync(HLS_DIR)) fs.mkdirSync(HLS_DIR, { recursive: true });
// 启动时预热一次 VAAPI 自检，避免第一首点歌的用户额外多等这一次探测的耗时。
log.info('VAAPI', '服务启动，开始预热核显自检...');
detectVAAPI().then(ok => {
  log.info('VAAPI', `预热完成，核显硬件加速当前${ok ? '可用' : '不可用'}`);
}).catch(() => {});

module.exports = {
  ensureHLS, removeHLS, outDir, HLS_DIR, waitForFile, cleanupExpiredHLS, scheduleHLSCleanup,
  // 客户端全部离线时用来停止后台播放/转码（见 index.js 的在线检测）
  cancelSong, cancelAllActive, activeTranscodes, isCanceled,
  // 诊断用（/api/diag、孤儿 ffmpeg 巡检）
  pendingWaitCount, runningPids,
};
