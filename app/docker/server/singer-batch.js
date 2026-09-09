// ============ 歌手批量下载（学习 lx-music-desktop「歌手批量下载」） ============
// 流程：粘贴歌手名单（每行一个）→ 逐个歌手到四平台（kw/wy/tx/kg）搜索并翻页 →
//   歌名过滤词清洗（现场/伴奏/翻唱/DJ等噪声，同 LX 默认词表）→ 歌手名匹配过滤 →
//   时长区间过滤（各平台搜索结果都带时长，麦动 muse.db 无时长列故不在此列）→
//   本地已有跳过 → 逐首下载入库（下载失败自动换平台找同名歌续下，换源链见
//   lxmusic.resolveMusicUrlWithFallback）。
// 进度放内存（与 LX 行为一致，不做断点续传），状态经 /api/singer-batch/status 轮询。
'use strict';

const lxmusic = require('./lxmusic');
const boardsdk = require('./boardsdk');

/** 默认歌名过滤词（同 LX singerBatch，逗号分隔） */
const DEFAULT_FILTER_WORDS = [
  // 现场/演出类
  '现场', 'live', '演唱会', '音乐会', '不插电', 'Unplugged',
  // 官方宣传类
  '官方', 'Official', '官方MV', '官方版', '官方视频', '官方音频', 'Lyric Video', 'Audio',
  // 音质标注类
  'HD', 'HQ', 'SQ', '无损', '母带', 'Hi-Res', 'FLAC', 'APE', 'WAV', '320kbps',
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
  // 平台/厂商类
  '酷狗', '网易云', 'QQ音乐', '咪咕', '全民K歌', '唱吧', '天籁K歌', 'K米',
  // 字幕/版本类
  '完整版', '全歌词版', '带歌词', '双字幕', '大字幕', 'KTV字幕',
  // 短视频平台类
  '抖音', '快手', '小红书', 'TikTok', 'Reels', 'Shorts', '微视', '视频号', '切片', '卡点', '踩点',
  // 榜单类
  '抖音热歌', '热门', '榜单', 'TOP100', '流行榜', '飙升榜', '新歌榜',
].join(',');

const delay = (ms) => new Promise(r => setTimeout(r, ms));
const PAGE_LIMIT = 30;
const MAX_PAGES = 15;          // 每个歌手最多翻页数（防异常 total 卡死）
const SINGER_GAP_MS = 800;     // 歌手之间间隔
const SONG_GAP_MS = 300;       // 每首下载之间间隔（对平台友好）

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
  fallback: 0,          // 换平台成功数
  lastError: '',
  failedList: [],       // [{name, singer, src, reason}] 上限 500
};
let stopFlag = false;

function status() { return { ...state }; }

function stopSingerBatch() { if (state.running) stopFlag = true; }

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
  return s.includes(wanted) || wanted.includes(s.split('、')[0]);
}

async function downloadOne(song, format) {
  // 取歌词（附属信息，失败不挡下载）
  let lrcText = null;
  try { lrcText = await boardsdk.lyricText(song.src, song); } catch (e) { lrcText = null; }
  return lxmusic.downloadSong({
    songmid: song.songmid, name: song.name, singer: song.singer, pic: song.pic || null,
    source: song.src, format, lrcText,
  });
}

// 换平台找同名歌续下：按 [其它三个平台] 顺序，搜索歌名过滤歌手+歌名匹配，取第一个下载成功
async function downloadViaOtherSources(song, format, excludeSrc) {
  for (const s of boardsdk.SOURCES.map(x => x.id)) {
    if (s === excludeSrc || stopFlag) continue;
    try {
      const r = await boardsdk.search(s, song.name, 1, 30);
      const cand = (r.list || []).find(m =>
        titleMatch(m.name, song.name) && singerMatch(m.singer, song.singer.split('、')[0]));
      if (!cand) continue;
      await downloadOne(cand, format);
      return s;
    } catch (e) { /* 下一个平台 */ }
  }
  return null;
}

async function collectSinger(name, src, opts) {
  const collected = new Map();
  let total = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (stopFlag) break;
    const r = await boardsdk.search(src, name, page, PAGE_LIMIT);
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
      collected.set(String(m.songmid), m);
    }
    state.collected = collected.size; // 实时刷新
    state.message = `正在收集「${name}」：第 ${page} 页，已收集 ${collected.size} 首`;
    // 没有下一页了
    if (r.list && r.list.length < PAGE_LIMIT) break;
    if (total && page * PAGE_LIMIT >= total) break;
    await delay(250);
  }
  return [...collected.values()];
}

async function start(opts = {}) {
  if (state.running) return { ok: false, error: '已有批量任务在运行' };
  const names = String(opts.text || '').split(/\r?\n/).map(s => s.trim()).filter((s, i, arr) => s && arr.indexOf(s) === i);
  if (!names.length) return { ok: false, error: '歌手名单为空' };
  const src = boardsdk.isValidSource(opts.src) ? opts.src : 'kw';
  const format = opts.format === 'mv' ? 'mv' : 'mp3';
  const useFilter = opts.useFilter !== false;
  const filterWords = useFilter ? (opts.filterWords || DEFAULT_FILTER_WORDS) : '';
  const filterRegs = buildFilterRegs(filterWords);
  const minDur = Math.max(0, parseInt(opts.minDur) || 0);
  const maxDur = Math.max(0, parseInt(opts.maxDur) || 0);

  stopFlag = false;
  Object.assign(state, {
    running: true, phase: 'running', message: '', singersTotal: names.length, singersDone: 0,
    current: '', collected: 0, done: 0, failed: 0, skipped: 0, fallback: 0, lastError: '',
    failedList: [],
  });

  void (async () => {
    try {
      for (const name of names) {
        if (stopFlag) break;
        state.current = name;
        state.message = `正在收集「${name}」（${state.singersDone + 1}/${names.length}）`;
        let songs = [];
        try { songs = await collectSinger(name, src, { filterRegs, minDur, maxDur }); }
        catch (e) {
          state.lastError = `「${name}」搜索失败: ${e.message}`;
          state.singersDone++;
          continue;
        }
        if (stopFlag && !songs.length) break;
        state.collected = songs.length;
        let doneThis = 0;
        for (const song of songs) {
          if (stopFlag) break;
          state.message = `「${name}」${doneThis + 1}/${songs.length} 下载中：${song.name} - ${song.singer}`;
          // 本地已有 → 跳过
          if (lxmusic.findLocalSong(song.name, song.singer)) { state.skipped++; continue; }
          try {
            await downloadOne(song, format);
            state.done++; doneThis++;
          } catch (e) {
            // 换平台续下（自动换源）
            try {
              const via = await downloadViaOtherSources(song, format, src);
              if (via) { state.done++; state.fallback++; }
              else throw e;
            } catch (e2) {
              state.failed++;
              const reason = String((e2 && e2.message) || e2).slice(0, 200);
              state.lastError = `${song.name}: ${reason}`;
              if (state.failedList.length < 500) state.failedList.push({ name: song.name, singer: song.singer, src: song.src, reason });
            }
          }
          await delay(SONG_GAP_MS);
        }
        state.singersDone++;
        if (!stopFlag) await delay(SINGER_GAP_MS);
      }
      state.phase = 'done';
      state.running = false;
      state.message = stopFlag
        ? `已停止：完成 ${state.singersDone}/${state.singersTotal} 个歌手，下载 ${state.done}、换源 ${state.fallback}、跳过 ${state.skipped}、失败 ${state.failed}`
        : `完成：${state.singersTotal} 个歌手，下载 ${state.done}（换源成功 ${state.fallback}）、跳过 ${state.skipped}、失败 ${state.failed}`;
    } catch (e) {
      state.phase = 'done';
      state.running = false;
      state.lastError = String((e && e.message) || e);
      state.message = '批量任务异常终止: ' + state.lastError;
    }
  })();

  return { ok: true };
}

module.exports = { start, stop: stopSingerBatch, status, DEFAULT_FILTER_WORDS };
