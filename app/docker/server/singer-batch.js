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
// 进度放内存（与 LX 行为一致，不做断点续传），状态经 /api/singer-batch/status 轮询。
'use strict';

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
const SOURCE_GAP_MS = 300;        // 多平台模式下，换平台搜索前的缓冲
const SOURCE_MIN_GAP_MS = 350;    // 同一音源两次请求的最小间隔（音源级节流）

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
const stopError = () => Object.assign(new Error('__SB_STOPPED__'), { __stopped: true });

const state = {
  running: false,
  phase: 'idle',        // idle | running | done
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
};
let stopFlag = false;
let sbAbort = null;   // 当前批量任务的 AbortController，stop 时 abort 以中断在途 http 请求

function status() { return { ...state }; }

function stopSingerBatch() {
  if (state.running) {
    stopFlag = true;
    state.stopping = true;
    state.message = '⏹ 正在停止：正在中断在途的取链/下载请求…';
    // 交给 lxmusic 的取消令牌：连音源脚本内部、内置源内部发起的 http 请求都会被就地断开，
    // 而不是等各自超时（脚本请求 30s、下载流 25s、歌词 15s…）才停下来。
    if (sbAbort) sbAbort.abort();
  }
}

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

async function downloadOne(song, format, sqOnly) {
  if (stopFlag) throw stopError();
  // 取歌词（附属信息，失败不挡下载）
  let lrcText = null;
  try { lrcText = await boardsdk.lyricText(song.src, song); } catch (e) { lrcText = null; }
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
    if (stopFlag) return null;
    try {
      const r = await boardsdk.search(s, song.name, 1, 30);
      if (stopFlag) return null;
      const cand = (r.list || []).find(m =>
        titleMatch(m.name, song.name) && singerMatch(m.singer, lead) &&
        !(sqOnly && typesSayNoLossless(m)) &&
        !(maxSingers > 0 && singerCount(m.singer) > maxSingers));
      if (!cand) continue;
      if (stopFlag) return null;
      await downloadOne(cand, format, sqOnly);
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
    if (stopFlag) break;
    await srcThrottle(srcId);
    if (stopFlag) break;
    const r = await boardsdk.search(srcId, name, page, PAGE_LIMIT);
    total = r.total || total;
    for (const m of r.list || []) {
      if (!m.songmid || !m.name) continue;
      if (collected.has(m.songmid)) continue;
      // 歌名过滤词
      if (opts.filterRegs.some(reg => reg.test(m.name))) continue;
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
    if (stopFlag) break;
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
  // 所有平台都失败（且不是用户停止）→ 让上层按"搜索失败"记账
  if (!okSources && targets.length > 1) throw new Error('全部平台搜索失败');
  return [...merged.values()];
}

async function start(opts = {}) {
  if (state.running) return { ok: false, error: '已有批量任务在运行' };
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
  const filterRegs = buildFilterRegs(filterWords);
  // 时长区间单位是「分钟」（界面也按分钟填；0 = 不限），支持小数（如 0.5 = 30 秒）。
  // 平台返回的 duration 是秒，这里换算成秒后再比较。
  const minDur = Math.max(0, Math.round((parseFloat(opts.minDur) || 0) * 60));
  const maxDur = Math.max(0, Math.round((parseFloat(opts.maxDur) || 0) * 60));
  const preferLossless = format === 'flac';

  stopFlag = false;
  sbAbort = new AbortController();   // 本任务的中断令牌，stop 时 abort
  lxmusic.setCancelSignal(sbAbort.signal);   // 让脚本内/内置源内的请求也能被掐断
  Object.assign(state, {
    running: true, phase: 'running', message: '', singersTotal: names.length, singersDone: 0,
    current: '', collected: 0, done: 0, failed: 0, skipped: 0, noLossless: 0, fallback: 0, lastError: '',
    failedList: [], stopping: false, sources: src === 'all' ? [...ALL_SOURCES] : [src], sqOnly, maxSingers,
  });

  void (async () => {
    try {
      for (const name of names) {
        if (stopFlag) break;
        state.current = name;
        state.message = `正在收集「${name}」（${state.singersDone + 1}/${names.length}）`;
        let songs = [];
        try { songs = await collectSinger(name, src, { filterRegs, minDur, maxDur, sqOnly, autoPage, preferLossless, maxSingers }); }
        catch (e) {
          if (e && e.__stopped) break;   // 收集过程中被停止：不算搜索失败，直接收工
          state.lastError = `「${name}」搜索失败: ${e.message}`;
          state.singersDone++;
          continue;
        }
        if (stopFlag && !songs.length) break;
        state.collected = songs.length;
        let doneThis = 0;
        for (const song of songs) {
          if (stopFlag) break;
          state.message = `${stopFlag ? '⏹ 正在停止… ' : ''}「${name}」${doneThis + 1}/${songs.length} 下载中：${song.name} - ${song.singer}`;
          // 本地已有 → 跳过
          if (lxmusic.findLocalSong(song.name, song.singer)) { state.skipped++; continue; }
          try {
            await downloadOne(song, format, sqOnly);
            state.done++; doneThis++;
          } catch (e) {
            if (e && e.__stopped) break;   // 用户点了停止，干净中断整批
            // 换平台续下（自动换源）
            try {
              const via = await downloadViaOtherSources(song, format, song.src, sqOnly, maxSingers);
              if (via) { state.done++; state.fallback++; }
              else throw e;
            } catch (e2) {
              if (e2 && e2.__stopped) break;   // 换源过程中被停止
              if (e2 && e2.__noLossless) {
                // 只收无损模式：四平台都只给到有损 → 不算失败，单独计数
                state.noLossless++;
                state.lastError = `${song.name}：无无损资源，已跳过`;
              } else {
                state.failed++;
                const reason = String((e2 && e2.message) || e2).slice(0, 200);
                state.lastError = `${song.name}: ${reason}`;
                if (state.failedList.length < 500) state.failedList.push({ name: song.name, singer: song.singer, src: song.src, reason });
              }
            }
          }
          await delay(SONG_GAP_MS);
        }
        state.singersDone++;
        if (!stopFlag) await delay(SINGER_GAP_MS);
      }
      state.phase = 'done';
      state.running = false;
      state.stopping = false;
      const tail = (state.fallback > 0 ? `、换源 ${state.fallback}` : '') + `、跳过 ${state.skipped}` +
        (state.noLossless ? `、无无损 ${state.noLossless}` : '') + `、失败 ${state.failed}`;
      state.message = stopFlag
        ? `已停止：完成 ${state.singersDone}/${state.singersTotal} 个歌手，下载 ${state.done}${tail}`
        : `完成：${state.singersTotal} 个歌手，下载 ${state.done}${tail}`;
    } catch (e) {
      state.phase = 'done';
      state.running = false;
      state.stopping = false;
      state.lastError = String((e && e.message) || e);
      state.message = '批量任务异常终止: ' + state.lastError;
    } finally {
      // 必须解除取消令牌：它是模块级的，留着会让之后所有请求（含电视端搜索）
      // 只要一创建就被判定为"已停止"而立刻失败。
      lxmusic.setCancelSignal(null);
      sbAbort = null;
    }
  })();

  return { ok: true };
}

module.exports = {
  start, stop: stopSingerBatch, status, DEFAULT_FILTER_WORDS, ALL_SOURCES,
  // 测试用内部函数（保持真实逻辑，便于不联网地断言收集/筛选规则）
  _internals: { collectSinger, collectFromSource, hasLossless, typesSayNoLossless, buildFilterRegs },
};
