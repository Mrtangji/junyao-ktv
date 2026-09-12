// ============ 歌手批量下载（学习 lx-music-desktop「歌手批量下载」） ============
// 流程：粘贴歌手名单（每行一个）→ 逐个歌手到平台搜索并翻页 → 歌名过滤词清洗
//   （现场/伴奏/翻唱/DJ 等噪声，同 LX 默认词表）→ 歌手名匹配过滤 → 时长区间过滤 →
//   「只收无损」音质过滤 → 本地已有跳过 → 逐首下载入库（下载失败自动换平台找同名歌
//   续下，换源链见 lxmusic.resolveMusicUrlWithFallback）。
// 对齐 lx 版（src/renderer/store/singerBatch.ts）的几处做法：
//   · 多音源：src='all' 时 kw/wy/tx/kg 逐家搜完再合并（按歌名+歌手跨源去重）
//   · sqOnly：按平台音质标注（boardsdk 统一解析出的 types）跳过没有无损的歌
//   · autoPage：可只搜首页（快速模式）
//   · 音源级节流：同一平台两次请求之间留最小间隔，平台间 300ms、歌手间 1000ms
// 暂停 / 断点续传（LX 没有，KTV 侧新增）：
//   · pause() 置暂停标记 + abort 在途请求（正在下的一首留到继续时重下），
//     并把任务进度（歌手名单 / 配置 / 当前歌手剩余歌曲 / 统计）落到
//     DATA_DIR/singer-batch-job.json；
//   · resume() 内存里还挂着的任务直接放行（hot）；进程重启 / 主循环已退出时
//     从快照冷启动（cold），接着断点继续；
//   · 意外异常（网络中断、平台抽风、连续多首失败）自动转入暂停并保留快照，
//     不会把剩下的歌直接记成失败丢掉；
//   · stop() 才是真正放弃，同时删除快照。
// 状态经 /api/singer-batch/status 轮询。
'use strict';

const fs = require('fs');
const path = require('path');
const lxmusic = require('./lxmusic');
const boardsdk = require('./boardsdk');
const { firstSinger, singerCount } = require('./singers');

/** 默认歌名过滤词（同 LX singerBatch，逗号分隔） */
const DEFAULT_FILTER_WORDS = [
  // 现场/演出类
  '现场', 'live', '演唱会', '音乐会', '不插电', 'Unplugged',
  // 官方宣传类
  '官方', 'Official', '官方MV', '官方版', '官方视频', '官方音频', 'Lyric Video', 'Audio',
  // 音质标注类
  'HD', 'HQ', 'SQ', '无损', '母带', 'Hi-Res', 'FLAC', 'APE', 'WAV', '320kbps',
  // 多曲拼接（歌名里用 + 把几首歌串起来的，多为串烧/合集，不是单曲。
  // 注意别加 & / ＆：那是合唱标记（如"周杰伦＆袁咏琳"），会误杀正常对唱）
  '+',
  // 清晰度类
  '4K', '1080P', '720P', '2K', '超清', '高清', '标清', '原画',
  // 试听/片段类
  '试听', '试听版', '片段', 'Preview', 'Clip', '30秒', '60秒', '15秒',
  // 伴奏/KTV类
  '伴奏', '伴唱', '卡拉OK', 'KTV版', 'KTV', 'Karaoke', '消音', '去人声', '无人声', '纯伴奏', 'Instrumental', 'Inst', 'KalaOK', 'OK版', '原伴分离', '人声移除', '干声', 'Vocal', 'Backing Track', 'Minus One',
  // 翻唱类
  '翻唱', 'Cover', '清唱', 'Acoustic', 'Acappella', '阿卡贝拉',
  // 合集/串烧类
  '合集', '精选', '串烧', 'Mashup', 'Megamix', 'Remix', 'DJ', 'DJ版', '慢摇', '车载', '劲爆', '提神',
  // 铃声类
  '铃声', '手机铃声', '微信铃声', '彩铃', '通知音',
  // 乐器/纯音乐类
  '八音盒', '钢琴版', '吉他版', '古筝', '二胡', '小提琴', '纯音乐',
  // AI 合成类
  'AI合成', 'AI孙燕姿', 'AI周杰伦', 'AI邓丽君', 'AI林俊杰', 'Suno', 'Udio', 'RVC', 'SoVITS', 'GPT-SoVITS', 'AI翻唱', 'AI换声', 'AI音色克隆', '虚拟歌手', '初音未来', '洛天依', 'Vocaloid', 'CeVIO', 'SynthV', 'AI Cover',
  // 语言节目类
  '有声小说', '相声', '小品', '脱口秀', '评书', '快板', '二人转', '京剧', '昆曲', '越剧', '黄梅戏', '评剧', '豫剧', '粤剧', '川剧', '秦腔', '皮影戏', '木偶戏',
  // 平台/KTV 厂商类（后 10 个是与 lx 版对齐后补上的：KTV 点歌系统品牌水印歌名）
  '酷狗', '网易云', 'QQ音乐', '咪咕', '全民K歌', '唱吧', '天籁K歌', 'K米',
  '麦颂', '雷石', '视易', '星网视易', '阳光视翰', '海媚', '音创', '巨嗨', '雷客', '音王',
  // 字幕/版本类
  '完整版', '全歌词版', '带歌词', '双字幕', '大字幕', 'KTV字幕',
  // 短视频平台类
  '抖音', '快手', '小红书', 'TikTok', 'Reels', 'Shorts', '微视', '视频号', '切片', '卡点', '踩点',
  // 榜单类
  '抖音热歌', '热门', '榜单', 'TOP100', '流行榜', '飙升榜', '新歌榜',
].join(',');

/** 视为"无损"的音质标识（boardsdk 四个平台统一解析成 types 里的值） */
const LOSSLESS_TYPES = ['flac', 'flac24bit', 'ape', 'wav', 'hires'];

const delay = (ms) => new Promise(r => setTimeout(r, ms));
const PAGE_LIMIT = 30;
const MAX_PAGES = 15;             // 每个歌手最多翻页数（防异常 total 卡死）
const SINGER_GAP_MS = 1000;       // 歌手之间间隔（对齐 lx 的 1000ms）
const SONG_GAP_MS = 300;          // 每首下载之间间隔（对平台友好）
// 中转音源限流（"block ip"）退避序列：撞限流后等待冷却再自动重试同一首，
// 三轮退完仍被限才走 autoPause。等待期间暂停/停止可随时打断（每秒检查）。
const BLOCK_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];
const SOURCE_GAP_MS = 300;        // 多平台模式下，换平台搜索前的缓冲
const SOURCE_MIN_GAP_MS = 350;    // 同一音源两次请求的最小间隔（音源级节流）

/** 任务快照（断点续传）落盘位置；连不上磁盘时只影响续传，不影响正常下载 */
const DATA_DIR = process.env.DATA_DIR || '/data';
const JOB_FILE = path.join(DATA_DIR, 'singer-batch-job.json');
const JOB_VERSION = 1;
// 进度落盘节流。快照是"整份名单 + 进度"一起写（名单可能上万行、150KB+），
// 每首歌都写等于一天几百 MB 的磁盘写入，对 NAS 不友好，所以放宽到 20 秒一次。
// 断点精度变粗不会造成重复下载：续传时从"当前歌手"重新开始，已经下过的那几首
// 会被 findLocalSong（本地已有）直接跳过，只是多几次本地查库。
// 暂停 / 停止 / 歌手切换 / 任务异常这些关键点仍然立即落盘，不受节流影响。
const SAVE_THROTTLE_MS = 20000;
const AUTO_PAUSE_AFTER_FAILS = 5; // 连续失败多少首后自动暂停（多半是断网/被平台限流）

// "本地已有跳过"的口径按任务格式区分——库里已有的其它版本不应挡住本次下载：
//   · flac 任务：只认已有 .flac（TS/MV 是视频、MP3 是有损，都不算"已有无损"，
//     否则库里有 MV 或 MP3 的歌永远补不上 FLAC 版）
//   · mp3 任务：.mp3 或 .flac 都算（无损文件转出的 MP3 需求已满足），MV 不算
//   · mv 任务：只认视频行（media_type='video'，含 .ts/.mp4 等），音频版不算
// 点唱接口（/api/lx/queue 等）不传 filter，保持老口径：任何版本都算已有（能播就行）。
const LOCAL_FILTERS = {
  flac: { exts: ['flac'] },
  mp3: { exts: ['mp3', 'flac'] },
  mv: { mediaTypes: ['video'] },
};

/** 全部平台（多音源模式）——顺序即优先级：先命中先入库，后到的同名歌由本地查重跳过 */
const ALL_SOURCES = boardsdk.SOURCES.map(s => s.id);

// 音源级节流（对齐 lx sourceRateLimiter 的"最小请求间隔"语义）：
// 同平台两次请求之间至少隔 SOURCE_MIN_GAP_MS，避免节奏过快被平台限流/封 IP。
const srcLastAt = new Map();
async function srcThrottle(srcId) {
  const wait = (srcLastAt.get(srcId) || 0) + SOURCE_MIN_GAP_MS - Date.now();
  if (wait > 0) await delay(wait);
  srcLastAt.set(srcId, Date.now());
}

// 用户点「停止」时抛出的标记错误（__stopped=true），下载链路各层都会识别并向上冒泡，
// 主循环据此干净地中断，而不会把"被停止"记成一首失败。
// 「暂停」复用同一条中断链路（同样 abort 在途请求），靠 pauseFlag 与 stopFlag 区分：
// 暂停引起的中断不计失败，当前这首歌留到继续时重下。
const stopError = () => Object.assign(new Error('__SB_STOPPED__'), { __stopped: true });

const state = {
  running: false,
  phase: 'idle',        // idle | running | paused | done
  paused: false,        // 当前处于"已暂停、可继续"
  resumable: false,     // 存在可继续的任务（暂停中 / 上次意外中断留下的快照）
  pausedReason: '',     // 暂停原因（用户暂停 / 意外中断 / 连续失败…）
  message: '',
  singersTotal: 0,
  singersDone: 0,
  current: '',          // 当前处理的歌手
  collected: 0,         // 入队歌曲数
  done: 0,
  failed: 0,
  skipped: 0,           // 本地已有
  noLossless: 0,        // 只收无损模式下：四平台都没有无损，主动跳过
  fallback: 0,          // 换平台成功数
  lastError: '',
  failedList: [],       // [{name, singer, src, reason}] 上限 500
  stopping: false,      // 已请求停止、尚在收尾（前端可显示"正在停止…"）
  sources: [],          // 本次任务的搜索平台
  sqOnly: false,        // 本次任务是否「只收无损」
  maxSingers: 2,        // 本次任务的合唱人数上限（0=不限）
  pendingSongs: 0,      // 当前歌手还剩多少首没下（暂停/续传时看这个）
  remainingSingers: 0,  // 还剩多少个歌手没处理完（含当前）
};
let stopFlag = false;
let pauseFlag = false;
let sbAbort = null;       // 当前批量任务的 AbortController，stop/pause 时 abort 以中断在途 http 请求
let loopRunning = false;  // 主循环是否还在内存里跑着（暂停时它挂在 pausePoint 上，仍算在跑）
let currentJob = null;    // 当前任务快照（与 JOB_FILE 同步）
let saveTimer = null;     // 进度落盘节流定时器
let pauseWaiters = [];    // 暂停时在这里排队的 await（继续/停止时统一放行）

function status() { return { ...state }; }

// ---------- 暂停 / 继续 原语 ----------

/** 暂停检查点：已暂停就挂在这里，直到 resume()/stop() 放行 */
function pausePoint() {
  if (!pauseFlag) return Promise.resolve();
  return new Promise(res => pauseWaiters.push(res));
}
function releasePauseWaiters() {
  const ws = pauseWaiters;
  pauseWaiters = [];
  for (const w of ws) { try { w(); } catch (e) {} }
}

// ---------- 任务快照（断点续传） ----------

function syncPending(job) {
  const j = job || currentJob;
  if (!j) { state.pendingSongs = 0; state.remainingSingers = 0; return; }
  state.pendingSongs = Array.isArray(j.pendingSongs) ? j.pendingSongs.length : 0;
  state.remainingSingers = Math.max(0, (j.names || []).length - (j.singerIndex || 0));
}

function saveJob() {
  if (!currentJob) return;
  currentJob.savedAt = new Date().toISOString();
  syncPending(currentJob);
  try {
    const tmp = JOB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(currentJob), 'utf8');
    fs.renameSync(tmp, JOB_FILE);   // 原子替换，避免写一半被读到坏 JSON
  } catch (e) {
    console.error('[SB] 保存任务快照失败（不影响下载）:', e.message);
  }
}
function saveJobSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveJob(); }, SAVE_THROTTLE_MS);
  if (saveTimer.unref) saveTimer.unref();
}
function clearJob() {
  currentJob = null;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try { if (fs.existsSync(JOB_FILE)) fs.unlinkSync(JOB_FILE); } catch (e) {}
}
function loadJob() {
  try {
    if (!fs.existsSync(JOB_FILE)) return null;
    const j = JSON.parse(fs.readFileSync(JOB_FILE, 'utf8'));
    if (!j || j.v !== JOB_VERSION || !Array.isArray(j.names) || !j.names.length) return null;
    return j;
  } catch (e) {
    console.error('[SB] 读取任务快照失败:', e.message);
    return null;
  }
}
const isJobPending = (j) => !!j && ((j.singerIndex || 0) < j.names.length || (j.pendingSongs || []).length > 0);

// 统计双写：内存 state 给前端看，job.stats 给续传用
function bump(job, key, n = 1) {
  state[key] = (state[key] || 0) + n;
  if (job && job.stats) job.stats[key] = (job.stats[key] || 0) + n;
}

// ---------- 过滤 / 匹配 ----------

// 解析过滤词：逗号（中英文）、顿号、竖线分隔；纯英文数字词用词边界匹配（live 不误杀 Oliver），
// 中文等直接子串匹配（同 LX 实现）
function buildFilterRegs(words) {
  const escapeReg = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(words || '')
    .split(/[,，、|]/)
    .map(w => w.trim())
    .filter((w, i, arr) => w && arr.indexOf(w) === i)
    .map(w => /^[a-z0-9]+$/i.test(w) ? new RegExp(`\\b${escapeReg(w)}\\b`, 'i') : new RegExp(escapeReg(w), 'i'));
}

const normTitle = (s) => String(s || '').toLowerCase().replace(/[\s()（）[\]【】_·.,，。!！?？'’"“”\-–—]/g, '');

// 歌名近似匹配（换平台找同名歌用）：去符号后相等或一方包含另一方
function titleMatch(a, b) {
  const na = normTitle(a), nb = normTitle(b);
  if (!na || !nb) return false;
  return na === nb || (na.length >= 4 && nb.includes(na)) || (nb.length >= 4 && na.includes(nb));
}

function singerMatch(songSinger, wanted) {
  if (!wanted) return true;
  const s = String(songSinger || '');
  if (!s) return false;
  return s.includes(wanted) || wanted.includes(firstSinger(s));
}

// 平台音质标注里是否含无损。types 为空数组表示"平台没标注"（不能据此判定无无损）
const hasLossless = (types) =>
  Array.isArray(types) && types.some(t => LOSSLESS_TYPES.includes(String(t).toLowerCase()));
const typesSayNoLossless = (m) => Array.isArray(m.types) && m.types.length > 0 && !hasLossless(m.types);
// 跨源去重键：歌名 + 首位歌手（同一首歌在多家平台的 id 完全不互通，只能按名字判重）
const dupKey = (m) => normTitle(m.name) + '|' + firstSinger(m.singer).toLowerCase();

// 可打断的等待：限流冷却期间用户点暂停/停止要能立即响应（轮询标志位）
async function backoffDelay(ms) {
  const step = 1000;
  for (let left = ms; left > 0; left -= step) {
    if (stopFlag || pauseFlag) throw stopError();
    await delay(Math.min(step, left));
  }
}

// 带限流退避的下载：block ip 不计入失败，按 1min→5min→15min 冷却后自动重试
// 同一首；三轮仍被限则抛给上层走 autoPause（见主循环 catch）。
async function downloadWithBlockBackoff(song, opts) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await downloadOne(song, opts.format, opts.sqOnly);
    } catch (e) {
      if (e && e.__stopped) throw e;
      if (attempt < BLOCK_BACKOFF_MS.length && /block ip/i.test(String((e && e.message) || e))) {
        state.message = `⏳ 音源限流（block ip），${Math.round(BLOCK_BACKOFF_MS[attempt] / 60000)} 分钟后自动重试：${song.name}`;
        await backoffDelay(BLOCK_BACKOFF_MS[attempt]);
        continue;
      }
      throw e;
    }
  }
}

async function downloadOne(song, format, sqOnly) {
  if (stopFlag || pauseFlag) throw stopError();
  // 取歌词（附属信息，失败不挡下载）
  let lrcText = null;
  try { lrcText = await boardsdk.lyricText(song.src, song); } catch (e) { lrcText = null; }
  if (stopFlag || pauseFlag) throw stopError();
  return lxmusic.downloadSong({
    songmid: song.songmid, name: song.name, singer: song.singer, pic: song.pic || null,
    source: song.src, format, lrcText, sqOnly,
    signal: sbAbort ? sbAbort.signal : null,
    // 平台换链必需字段：kg 的 FileHash、tx 的数字 songId/strMediaMid 等
    info: { hash: song.hash, songId: song.songId, strMediaMid: song.strMediaMid, albumAudioId: song.albumAudioId, duration: song.duration, types: song.types },
  });
}

// 换平台找同名歌续下：按 [其它三个平台] 顺序，搜索歌名过滤歌手+歌名匹配，取第一个下载成功。
// 只收无损模式下，媒体库明确标注无无损的候选直接跳过（省一次下载）。
async function downloadViaOtherSources(song, format, excludeSrc, sqOnly, maxSingers) {
  const lead = firstSinger(song.singer);
  for (const s of ALL_SOURCES) {
    if (s === excludeSrc) continue;
    if (stopFlag || pauseFlag) return null;
    try {
      const r = await boardsdk.search(s, song.name, 1, 30);
      if (stopFlag || pauseFlag) return null;
      const cand = (r.list || []).find(m =>
        titleMatch(m.name, song.name) && singerMatch(m.singer, lead) &&
        !(sqOnly && typesSayNoLossless(m)) &&
        !(maxSingers > 0 && singerCount(m.singer) > maxSingers));
      if (!cand) continue;
      if (stopFlag || pauseFlag) return null;
      await downloadWithBlockBackoff(cand, { format, sqOnly });
      return s;
    } catch (e) { if (e && e.__stopped) throw e; /* 下一个平台 */ }
  }
  return null;
}

// 单平台收集：翻页搜索 → 过滤（词/歌手/时长/音质）→ 按 songmid 去重
async function collectFromSource(name, srcId, opts) {
  const collected = new Map();
  let total = 0;
  const maxPage = opts.autoPage ? MAX_PAGES : 1;
  for (let page = 1; page <= maxPage; page++) {
    if (stopFlag || pauseFlag) break;   // 暂停时尽快收手：残留结果会被上层丢弃并重来
    await srcThrottle(srcId);
    if (stopFlag || pauseFlag) break;
    const r = await boardsdk.search(srcId, name, page, PAGE_LIMIT);
    total = r.total || total;
    for (const m of r.list || []) {
      if (!m.songmid || !m.name) continue;
      if (collected.has(m.songmid)) continue;
      // 歌名过滤词
      if (opts.filterRegs.some(reg => reg.test(m.name))) continue;
      // 逗号/加号拼接的歌名多为串烧、评论合集类杂项。',' 本身是过滤词分隔符、
      // 进不了词表，这里按标点直接判（'+' 词表里也有，双保险）。
      if (/[+,，＋]/.test(m.name)) continue;
      // 歌手匹配（搜索结果里不含该歌手的多为相关歌/翻唱/误匹配）
      if (!singerMatch(m.singer, name)) continue;
      // 时长区间（0 = 不限；平台无时长数据的歌不过滤）
      if (m.duration > 0) {
        if (opts.minDur > 0 && m.duration < opts.minDur) continue;
        if (opts.maxDur > 0 && m.duration > opts.maxDur) continue;
      }
      // 合唱人数限制（同 lx 的 download.maxSingerCount）：超过上限视为大合唱，跳过
      if (opts.maxSingers > 0 && singerCount(m.singer) > opts.maxSingers) continue;
      // 只收无损：平台明确标注了音质、且其中没有无损 → 跳过。
      // 未标注（types 为空）的不在这里跳过，改为下载时兜底判定，避免误杀。
      if (opts.sqOnly && typesSayNoLossless(m)) continue;
      collected.set(String(m.songmid), m);
    }
    state.message = `正在收集「${name}」${opts.multi ? `（${srcId}）` : ''}：第 ${page} 页，已收集 ${collected.size} 首`;
    // 没有下一页了
    if (r.list && r.list.length < PAGE_LIMIT) break;
    if (total && page * PAGE_LIMIT >= total) break;
    await delay(250);
  }
  return [...collected.values()];
}

// 多平台/单平台收集：src='all' 时逐家搜完合并，按「歌名+歌手」跨源去重；
// 无损模式下同一首歌优先保留平台标注有无损的那条（下载更可能直接拿到 FLAC）。
async function collectSinger(name, src, opts) {
  const targets = src === 'all' ? ALL_SOURCES : [src];
  const merged = new Map();
  let okSources = 0;
  for (let i = 0; i < targets.length; i++) {
    if (stopFlag || pauseFlag) break;
    const srcId = targets[i];
    let songs = [];
    try { songs = await collectFromSource(name, srcId, { ...opts, multi: targets.length > 1 }); }
    catch (e) {
      if (e && e.__stopped) throw e;
      // 多平台模式下某一家接口抽风不影响其它平台，继续下一家
      if (targets.length === 1) throw e;
      state.lastError = `「${name}」在 ${srcId} 搜索失败：${e.message}`;
      continue;
    }
    for (const m of songs) {
      const k = dupKey(m);
      const prev = merged.get(k);
      if (!prev) { merged.set(k, m); continue; }
      if (opts.preferLossless && hasLossless(m.types) && !hasLossless(prev.types)) merged.set(k, m);
    }
    okSources++;
    state.collected = merged.size;
    state.message = targets.length > 1
      ? `正在收集「${name}」：${srcId} 完成，已合并 ${merged.size} 首（${okSources}/${targets.length} 个平台）`
      : `正在收集「${name}」：已收集 ${merged.size} 首`;
    if (i < targets.length - 1) await delay(SOURCE_GAP_MS);
  }
  // 中途被暂停/停止：把已有的部分结果交回去，由上层决定丢弃重来
  if (stopFlag || pauseFlag) return [...merged.values()];
  // 所有平台都失败（且不是用户停止）→ 让上层按"搜索失败"记账
  if (!okSources && targets.length > 1) throw new Error('全部平台搜索失败');
  return [...merged.values()];
}

// ---------- 主循环（可暂停 / 可续传） ----------

async function runJob(job) {
  loopRunning = true;
  const names = job.names;
  const opts = job.opts || {};
  const filterRegs = buildFilterRegs(opts.useFilter === false ? '' : (opts.filterWords || DEFAULT_FILTER_WORDS));
  const collectOpts = {
    filterRegs,
    minDur: opts.minDurSec || 0,
    maxDur: opts.maxDurSec || 0,
    sqOnly: !!opts.sqOnly,
    autoPage: opts.autoPage !== false,
    preferLossless: opts.format === 'flac',
    maxSingers: opts.maxSingers || 0,
  };
  let consecutiveFail = 0;
  try {
    while (job.singerIndex < names.length) {
      if (stopFlag) break;
      if (pauseFlag) { await pausePoint(); continue; }
      const i = job.singerIndex;
      const name = names[i];
      state.current = name;
      let songs = Array.isArray(job.pendingSongs) ? job.pendingSongs : [];
      job.pendingSongs = [];
      if (!songs.length) {
        state.message = `正在收集「${name}」（${i + 1}/${names.length}）`;
        try { songs = await collectSinger(name, opts.src, collectOpts); }
        catch (e) {
          if (e && e.__stopped) {
            if (stopFlag) break;
            // 暂停引起的中断：本次收集作废，resume 后重搜这个歌手
            await pausePoint();
            continue;
          }
          state.lastError = `「${name}」搜索失败: ${e.message}`;
          job.singerIndex = i + 1;
          state.singersDone++;
          syncPending(job); saveJobSoon();
          continue;
        }
        if (stopFlag) break;
        if (pauseFlag) { await pausePoint(); continue; }
      }
      state.collected = songs.length;
      // 逐首下载（k 不随暂停推进：被打断的这首留到继续时重下）
      let k = 0;
      while (k < songs.length) {
        if (stopFlag) break;
        if (pauseFlag) { await pausePoint(); continue; }
        if (consecutiveFail >= AUTO_PAUSE_AFTER_FAILS) {
          autoPause(`连续 ${consecutiveFail} 首下载失败（可能是网络中断或平台限流），已自动暂停`);
          continue;
        }
        const song = songs[k];
        // 记录断点：当前歌手 + 剩余待下（含这首）——暂停/意外都能从这里接着下
        job.singerIndex = i;
        job.pendingSongs = songs.slice(k);
        syncPending(job);
        saveJobSoon();
        // 本地已有 → 跳过（按任务格式限口径：FLAC 任务不被已有 MV/MP3 挡住，
        // 见 LOCAL_FILTERS 注释）
        if (lxmusic.findLocalSong(song.name, song.singer, LOCAL_FILTERS[opts.format])) {
          bump(job, 'skipped');
          k++; continue;
        }
        state.message = `「${name}」${k + 1}/${songs.length} 下载中：${song.name} - ${song.singer}`;
        try {
          await downloadWithBlockBackoff(song, opts);
          bump(job, 'done');
          consecutiveFail = 0;
        } catch (e) {
          if (e && e.__stopped) {
            if (stopFlag) break;
            state.message = '⏸ 已暂停，当前这首歌会在「继续下载」后重新下载';
            continue;   // 回循环顶部挂起
          }
          // 中转音源按 IP 限流（报 "block ip"）：它托管全部平台，换源重试也是同一
          // 个中转、只会白白多花搜索请求。立即自动暂停，等冷却窗口过去后用户点
          // 「继续下载」即可接上（当前这首歌下轮会重下）。
          if (/block ip/i.test(String((e && e.message) || e))) {
            state.lastError = `${song.name}：音源限流（block ip）`;
            autoPause('音源限流（block ip），等几分钟再点「继续下载」');
            continue;
          }
          // 换平台续下（自动换源）
          try {
            const via = await downloadViaOtherSources(song, opts.format, song.src, opts.sqOnly, opts.maxSingers || 0);
            if (via) { bump(job, 'done'); bump(job, 'fallback'); consecutiveFail = 0; }
            else throw e;
          } catch (e2) {
            if (e2 && e2.__stopped) {
              if (stopFlag) break;
              state.message = '⏸ 已暂停，当前这首歌会在「继续下载」后重新下载';
              continue;
            }
            if (e2 && e2.__noLossless) {
              // 只收无损模式：四平台都只给到有损 → 不算失败，单独计数
              bump(job, 'noLossless');
              state.lastError = `${song.name}：无无损资源，已跳过`;
            } else if (/block ip/i.test(String((e2 && e2.message) || e2))) {
              state.lastError = `${song.name}：音源限流（block ip）`;
              autoPause('音源限流（block ip），等几分钟再点「继续下载」');
              continue;
            } else {
              consecutiveFail++;
              bump(job, 'failed');
              const reason = String((e2 && e2.message) || e2).slice(0, 200);
              state.lastError = `${song.name}: ${reason}`;
              if (job.stats.failedList.length < 500) {
                job.stats.failedList.push({ name: song.name, singer: song.singer, src: song.src, reason });
              }
            }
          }
        }
        k++;
        await delay(SONG_GAP_MS);
      }
      if (stopFlag) break;
      job.singerIndex = i + 1;
      job.pendingSongs = [];
      state.singersDone++;
      syncPending(job);
      saveJob();
      if (!stopFlag) await delay(SINGER_GAP_MS);
    }
    if (stopFlag) finish('stopped');
    // 兜底：循环退出却仍处于暂停标记（正常路径不会到这儿，暂停是挂在检查点上不退出）
    else if (pauseFlag) autoPause(state.pausedReason || '已暂停', true);
    else finish('done');
  } catch (e) {
    if (stopFlag) { finish('stopped'); return; }
    // 意外异常：保留断点，转入暂停等用户继续，而不是把剩下的歌全丢掉
    state.lastError = String((e && e.message) || e);
    autoPause(`任务意外中断：${state.lastError}`, true);
  } finally {
    // 主循环真的退出了：必须解除取消令牌。它是模块级的，留着会让之后所有请求
    // （含电视端搜索、手动点歌下载）一创建就被判定为"已停止"而立刻失败。
    lxmusic.setCancelSignal(null);
    sbAbort = null;
    loopRunning = false;
  }
}

function finish(kind) {
  const tail = (state.fallback > 0 ? `、换源 ${state.fallback}` : '') + `、跳过 ${state.skipped}` +
    (state.noLossless ? `、无无损 ${state.noLossless}` : '') + `、失败 ${state.failed}`;
  state.phase = 'done';
  state.running = false;
  state.stopping = false;
  state.paused = false;
  state.resumable = false;
  state.pausedReason = '';
  state.pendingSongs = 0;
  state.remainingSingers = 0;
  state.message = kind === 'stopped'
    ? `已停止：完成 ${state.singersDone}/${state.singersTotal} 个歌手，下载 ${state.done}${tail}`
    : `完成：${state.singersTotal} 个歌手，下载 ${state.done}${tail}`;
  clearJob();
}

/** 转入暂停：cold=true 表示主循环已退出（意外异常），需要从快照冷启动才能继续 */
function autoPause(reason, cold) {
  pauseFlag = true;
  state.paused = true;
  state.phase = 'paused';
  state.resumable = true;
  state.pausedReason = reason;
  const pend = state.pendingSongs;
  state.message = `⏸ 已暂停：${reason}｜剩余 ${state.remainingSingers} 个歌手` +
    (pend ? `（当前歌手还有 ${pend} 首）` : '') + `，点「▶ 继续下载」从断点接着下`;
  if (currentJob) { currentJob.reason = reason; saveJob(); }
  if (cold) state.running = false;
}

// ---------- 对外接口 ----------

async function start(opts = {}) {
  if (state.running) {
    return { ok: false, error: state.paused ? '有任务已暂停在断点上，请先「继续下载」或「停止」' : '已有批量任务在运行' };
  }
  if (state.resumable) {
    return { ok: false, error: '还有未完成的任务可继续，请先「继续下载」或「停止」放弃它' };
  }
  const names = String(opts.text || '').split(/\r?\n/).map(s => s.trim()).filter((s, i, arr) => s && arr.indexOf(s) === i);
  if (!names.length) return { ok: false, error: '歌手名单为空' };
  // src='all' → 四平台合并搜索；否则单平台
  const src = opts.src === 'all' ? 'all' : (boardsdk.isValidSource(opts.src) ? opts.src : 'kw');
  // mp3（320K 有声）/ flac（无损优先，源无无损回落 MP3）/ mv（封面合成视频）
  // 默认无损优先（FLAC）：未指定或传了不认识的值都按 flac 处理，只有明确选 mp3/mv 才降级。
  const format = opts.format === 'mv' ? 'mv' : (opts.format === 'mp3' ? 'mp3' : 'flac');
  // 只收无损：只在无损格式下有意义（mp3/mv 模式本身就允许有损）
  const sqOnly = opts.sqOnly === true && format === 'flac';
  // 翻页开关：默认翻页收集，显式传 false 时只搜首页（快速模式）
  const autoPage = opts.autoPage !== false;
  // 合唱人数上限（同 lx 的 download.maxSingerCount，界面默认 2）：超过上限的歌视为大合唱，
  // 收集阶段直接跳过；0 = 不限。只作用于歌手批量下载，用户主动点播的单曲不受限制。
  const maxSingers = opts.maxSingers == null ? 2 : Math.max(0, parseInt(opts.maxSingers, 10) || 0);
  const useFilter = opts.useFilter !== false;
  const filterWords = useFilter ? (opts.filterWords || DEFAULT_FILTER_WORDS) : '';
  // 时长区间单位是「分钟」（界面也按分钟填；0 = 不限），支持小数（如 0.5 = 30 秒）。
  // 平台返回的 duration 是秒，这里换算成秒后再比较（快照里也存秒，续传口径一致）。
  const minDur = Math.max(0, Math.round((parseFloat(opts.minDur) || 0) * 60));
  const maxDur = Math.max(0, Math.round((parseFloat(opts.maxDur) || 0) * 60));

  const job = {
    v: JOB_VERSION,
    names,
    opts: { src, format, sqOnly, autoPage, maxSingers, useFilter, filterWords, minDurSec: minDur, maxDurSec: maxDur },
    singerIndex: 0,
    pendingSongs: [],
    stats: { done: 0, failed: 0, skipped: 0, noLossless: 0, fallback: 0, failedList: [] },
    reason: '',
    savedAt: '',
  };
  launch(job);
  return { ok: true };
}

/** 拉起主循环（新任务 / 断点续传共用） */
function launch(job) {
  if (loopRunning) throw new Error('已有批量任务在运行');
  stopFlag = false;
  pauseFlag = false;
  pauseWaiters = [];
  sbAbort = new AbortController();
  lxmusic.setCancelSignal(sbAbort.signal);   // 让脚本内/内置源内的请求也能被掐断
  currentJob = job;
  const o = job.opts || {};
  Object.assign(state, {
    running: true, phase: 'running', paused: false, resumable: false, pausedReason: '',
    message: '正在准备…',
    singersTotal: job.names.length, singersDone: job.singerIndex || 0,
    current: job.names[job.singerIndex] || '', collected: 0,
    done: job.stats.done, failed: job.stats.failed, skipped: job.stats.skipped,
    noLossless: job.stats.noLossless, fallback: job.stats.fallback,
    lastError: '', failedList: job.stats.failedList,
    stopping: false,
    sources: o.src === 'all' ? [...ALL_SOURCES] : [o.src || 'kw'],
    sqOnly: !!o.sqOnly, maxSingers: o.maxSingers == null ? 2 : o.maxSingers,
  });
  syncPending(job);
  saveJob();
  void runJob(job).catch(e => {
    console.error('[SB] runJob 未捕获异常:', e && e.message);
    if (!stopFlag) autoPause(`任务意外中断：${(e && e.message) || e}`, true);
  });
}

/** 暂停：断开在途请求并保存断点，当前这首歌会在继续时重下 */
function pauseSingerBatch() {
  if (!state.running) {
    return { ok: false, error: state.resumable ? '没有正在运行的任务（有可继续的任务）' : '当前没有运行中的任务' };
  }
  if (state.paused) return { ok: false, error: '任务已处于暂停状态' };
  pauseFlag = true;
  state.paused = true;
  state.phase = 'paused';
  state.resumable = true;
  state.stopping = false;
  state.pausedReason = '用户暂停';
  state.message = '⏸ 已暂停：进度已保存，点「▶ 继续下载」从断点接着下';
  if (currentJob) { currentJob.reason = '用户暂停'; saveJob(); }   // 立即落盘（不等节流）
  // 旧令牌 abort 只应杀死"此刻在途"的请求；模块级令牌必须立刻换成新的，
  // 否则暂停期间所有不显式传 signal 的请求（电视端搜索/点歌下载/诊断接口）
  // 都会因为令牌已中止而立刻失败 __SB_STOPPED__。批量自己的下一首歌不会
  // 借此"复活"——主循环挂在 pausePoint 上，恢复时 resume 会再换新令牌。
  if (sbAbort) {
    try { sbAbort.abort(); } catch (e) {}            // 断开在途请求，秒级停下
    sbAbort = new AbortController();
    lxmusic.setCancelSignal(sbAbort.signal);
  }
  return { ok: true };
}

/** 继续：内存里挂着的直接放行；主循环已退出（意外/重启）则从快照冷启动 */
function resumeSingerBatch() {
  if (!state.paused && !state.resumable) return { ok: false, error: '没有可继续的任务' };
  if (state.phase === 'running') return { ok: false, error: '任务正在运行中' };
  const hot = loopRunning;
  if (!hot) {
    // 冷恢复：主循环已退出（意外中断 / 服务重启后重新加载的快照）
    const job = currentJob || loadJob();
    if (!job) {
      state.resumable = false; state.paused = false; state.phase = 'idle';
      state.message = '';
      return { ok: false, error: '没有找到可继续的任务记录' };
    }
    if (!isJobPending(job)) {
      clearJob(); state.resumable = false; state.paused = false; state.phase = 'idle';
      return { ok: false, error: '任务已完成，无需继续' };
    }
    launch(job);
    return { ok: true, resumed: 'cold', remainingSingers: job.names.length - (job.singerIndex || 0) };
  }
  // 热恢复：主循环挂在暂停检查点上，换个新的中断令牌后放行
  pauseFlag = false;
  state.paused = false;
  state.resumable = false;
  state.phase = 'running';
  state.pausedReason = '';
  state.message = '▶ 已继续下载…';
  sbAbort = new AbortController();          // 旧令牌已被 pause 作废，必须换新的
  lxmusic.setCancelSignal(sbAbort.signal);
  releasePauseWaiters();
  return { ok: true, resumed: 'hot' };
}

/** 停止：真正放弃任务（内存 + 快照一起清） */
function stopSingerBatch() {
  if (!state.running && !state.resumable) return { ok: false, error: '当前没有运行中的任务' };
  const cold = !state.running;   // 只剩快照（上次意外中断留下的，未继续）
  stopFlag = true;
  pauseFlag = false;
  state.paused = false;
  state.resumable = false;
  state.pausedReason = '';
  releasePauseWaiters();
  if (sbAbort) { try { sbAbort.abort(); } catch (e) {} }
  if (cold) {
    clearJob();
    Object.assign(state, {
      phase: 'idle', running: false, stopping: false,
      pendingSongs: 0, remainingSingers: 0, message: '已放弃上次未完成的任务',
    });
    return { ok: true, discarded: true };
  }
  state.stopping = true;
  state.message = '⏹ 正在停止：正在中断在途的取链/下载请求…';
  return { ok: true };
}

// 启动时若发现上次留下的未完成任务，转成"已暂停"状态，等用户点继续
(function restoreJobOnBoot() {
  let job = null;
  try { job = loadJob(); } catch (e) { return; }
  if (!job) return;
  if (!isJobPending(job)) { clearJob(); return; }
  currentJob = job;
  const o = job.opts || {};
  Object.assign(state, {
    running: false, phase: 'paused', paused: true, resumable: true,
    singersTotal: job.names.length, singersDone: job.singerIndex || 0,
    current: job.names[job.singerIndex] || '', collected: 0,
    done: job.stats.done, failed: job.stats.failed, skipped: job.stats.skipped,
    noLossless: job.stats.noLossless, fallback: job.stats.fallback,
    lastError: (job.stats.failedList || []).length ? '' : '', failedList: job.stats.failedList,
    pausedReason: job.reason || '上次任务未完成',
    sources: o.src === 'all' ? [...ALL_SOURCES] : [o.src || 'kw'],
    sqOnly: !!o.sqOnly, maxSingers: o.maxSingers == null ? 2 : o.maxSingers,
  });
  syncPending(job);
  state.message = `⏸ 上次任务未完成（剩余 ${state.remainingSingers} 个歌手${state.pendingSongs ? `、当前歌手 ${state.pendingSongs} 首` : ''}）：` +
    `${job.reason || '服务重启'}，点「▶ 继续下载」从断点接着下`;
  console.log(`[SB] 发现未完成的歌手批量下载任务：剩余 ${state.remainingSingers} 个歌手待处理，等待「继续下载」`);
})();

module.exports = {
  start, stop: stopSingerBatch, pause: pauseSingerBatch, resume: resumeSingerBatch,
  status, DEFAULT_FILTER_WORDS, ALL_SOURCES,
  // 测试用内部函数（保持真实逻辑，便于不联网地断言收集/筛选规则）
  _internals: {
    collectSinger, collectFromSource, hasLossless, typesSayNoLossless, buildFilterRegs,
    buildJob: (opts, names) => ({
      v: JOB_VERSION, names: names || ['测试歌手'],
      opts: {
        src: opts && opts.src || 'kw', format: opts && opts.format || 'flac',
        sqOnly: !!(opts && opts.sqOnly), autoPage: !(opts && opts.autoPage === false),
        maxSingers: opts && opts.maxSingers != null ? opts.maxSingers : 2,
        useFilter: true, filterWords: DEFAULT_FILTER_WORDS,
        minDurSec: 0, maxDurSec: 0,
      },
      singerIndex: 0, pendingSongs: [],
      stats: { done: 0, failed: 0, skipped: 0, noLossless: 0, fallback: 0, failedList: [] },
      reason: '', savedAt: '',
    }),
    saveJob, loadJob, clearJob, syncPending, isJobPending, state, JOB_FILE,
  },
};
