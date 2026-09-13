const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const db = require('./db');
const { removeHLSSilent } = require('./hlsgen');
const { toPinyin, toPinyinInitial } = require('./pinyin');
const { detectLang } = require('./lang');
const dlcfg = require('./dlconfig');

// scan_stat：上次扫描时每个文件的 mtime/size（模块加载即建表——scanFile 单文件
// 入库在首次全量扫描之前就可能被调用，同样要登记）。文件内容只会在被写入时损坏
// （下载中断/拷贝半截），写完不再动的文件 ffprobe 结论不会变，所以"mtime+size
// 没变"的已入库文件可以安全跳过 ffprobe，大曲库重扫从几十分钟降到一两分钟。
db.exec('CREATE TABLE IF NOT EXISTS scan_stat (filename TEXT PRIMARY KEY, mtime_ms REAL NOT NULL, size INTEGER NOT NULL)');

// MV_DIR 仍是曲库主目录（MV/存量歌曲）；下载目录可配置后，配置的自定义目录
// 也纳入扫描（见 scanRoots）。导出别名保持旧引用（maidong.js 等）兼容。
const MV_DIR = dlcfg.MV_DIR;

// 扫描根目录列表：MV_DIR 恒在；MP3_DIR（环境变量，默认等于 MV_DIR）与 MV_DIR
// 互不包含时追加。若 MP3_DIR 就在 MV_DIR 里面（或反过来包含 MV_DIR），只扫
// MV_DIR 即可覆盖，避免同一文件以两个不同的相对路径重复入库。
function scanRoots() {
  const roots = [path.resolve(MV_DIR)];
  const p = dlcfg.getMp3Dir();
  const inMv = p === roots[0] || p.startsWith(roots[0] + path.sep);
  const coversMv = roots[0] === p || roots[0].startsWith(p + path.sep);
  if (!inMv && !coversMv) roots.push(p);
  return roots;
}
// 新增对 .mpg (MPEG-1/2 Program Stream) 格式的支持：曲库扫描环节只需要把
// 后缀加入白名单即可正常入库；实际播放走 hlsgen.js 的转码流程，非 h264
// 编码（.mpg 源文件常见的 mpeg1video/mpeg2video）会被 SAFE_VIDEO_CODECS
// 判定为不可直拷贝，自动走 VAAPI/libx264 转码分支，不需要针对该格式
// 额外改动转码逻辑。
// .ts（MPEG-TS）同理：麦动曲库的原生格式就是编号.ts，用户直接把 ts 文件放进
// /mv 即可入库播放（h264/ts 走直拷贝，其它编码自动转码）。
const VIDEO_EXT = ['.mp4', '.mkv', '.avi', '.flv', '.mov', '.webm', '.mpg', '.ts'];
// 音频白名单：除 MP3 外，无损（FLAC/WAV）与其它常见音频（M4A/AAC/OGG/Opus）一并入库。
// 媒体类型只决定播放走"纯音频 HLS"（hlsgen 对非 aac 编码一律重新编码为 aac），
// 因此这里放宽后缀不会影响播放兼容性；下载目录里混入的 .flac 无损文件也能直接扫到。
const AUDIO_EXT = ['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav'];
const MEDIA_EXT = new Set([...VIDEO_EXT, ...AUDIO_EXT]);

// hlsgen.js 生成的 HLS 播放缓存分片也是 .ts（video_0001.ts / audio0_0001.ts）。
// 缓存目录（HLS_DIR，一般在 /data/hls）不在曲库扫描根目录里，正常扫不到；但万一
// 有人把缓存挪进 /mv，或未来目录调整，这里按命名模式兜底跳过——麦动的编号文件名
// 是纯数字（如 0123456.ts），不会命中该模式，不受影响。
const HLS_SEGMENT_RE = /^(video|audio\d*)_\d{4}\.ts$/i;

// LRC 是与歌曲同名的旁车歌词文件，不作为歌曲入库；支持大小写后缀，
// 例如「周杰伦 - 晴天.mp3」对应「周杰伦 - 晴天.lrc」。
// 逐字歌词（LRCX，带 <mm:ss.xx> 逐字时间标签）用 .lrcx 后缀，优先于 .lrc 关联入库。
// 目录列表带 mtime 缓存：刷新阶段要给每个文件找同名 .lrc，一个歌手目录动辄
// 几百个文件，原实现每个文件都 readdirSync 一次；现在按目录 mtime 缓存——
// 目录没变直接复用，目录变了（用户后补了歌词）才重新 readdir。这样既省掉
// 绝大多数 readdir，又不会漏掉"先放歌、后补歌词"的场景。
const lrcDirCache = new Map(); // dir -> { mtimeMs, names }
function readDirCached(dir) {
  try {
    const st = fs.statSync(dir);
    const c = lrcDirCache.get(dir);
    if (c && Math.abs(c.mtimeMs - st.mtimeMs) < 2) return c.names;
    const names = fs.readdirSync(dir);
    lrcDirCache.set(dir, { mtimeMs: st.mtimeMs, names });
    return names;
  } catch (e) {
    return [];
  }
}
function findLyricsPath(filepath) {
  const dir = path.dirname(filepath);
  const stem = path.basename(filepath, path.extname(filepath));
  const names = readDirCached(dir);
  // 逐字歌词 .lrcx 优先于普通 .lrc（播放时优先逐字版）
  const lrcx = names.find(name => name.toLowerCase() === `${stem.toLowerCase()}.lrcx`);
  if (lrcx) return path.join(dir, lrcx);
  const exact = names.find(name => name.toLowerCase() === `${stem.toLowerCase()}.lrc`);
  return exact ? path.join(dir, exact) : null;
}

// 逐字歌词嗅探：读歌词内容看有没有 <mm:ss.xx> 行内逐字标签
// （kw lrcx 增强歌词即此格式）。LRC 文件只有几 KB，读一次成本可忽略。
function sniffLrcKaraoke(lyricsPath) {
  if (!lyricsPath) return 0;
  if (/\.lrcx$/i.test(lyricsPath)) return 1;
  try {
    return /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/.test(fs.readFileSync(lyricsPath, 'utf8')) ? 1 : 0;
  } catch (e) { return 0; }
}

// Bug修复：原唱/伴唱切换失效的根源——浏览器的 HTMLMediaElement.audioTracks
// 在本应用运行的浏览器内核里没有真正实现（对本地文件播放，长度恒为0），前端
// 永远无法知道一个 MV 到底有几条音轨，只能靠猜（猜错就把双音轨文件当单音轨/
// 声道型处理）。真正可靠的办法是在扫描曲库时用 ffprobe 直接读取音轨数量存入
// 数据库，播放时把这个数字告诉前端，播放器不用再猜。
// 一次性探测文件可解析性与音轨数：
//   valid        —— ffprobe 能否解析出有效流（false = 文件损坏/下载不完整，
//                    常见于网络下载中断的 .ts，播起来也是黑屏，扫描时直接跳过）
//   transient    —— 探测失败是暂时性的（超时/IO 抖动），文件本身可能没问题，
//                    本轮跳过但不清除已入库记录，下轮扫描再试
//   audioTracks  —— 有效音频流数量（只认 codec_name 明确的流；MPEG-TS 里
//                    ffprobe 可能把未知编码流也报成音频，ffmpeg demux 却不认，
//                    照单全收会让数据库音轨数虚高、转码映射失败）
function probeMedia(filepath) {
  const FFPROBE_ARGS = [
    '-v', 'error',
    '-analyzeduration', '10000000', '-probesize', '10000000',
    '-show_entries', 'stream=codec_type,codec_name',
    '-of', 'csv=p=0',
    filepath,
  ];
  try {
    const out = execFileSync('ffprobe', FFPROBE_ARGS, { timeout: 20000 }).toString();
    return parseProbeOut(out);
  } catch (e) {
    // 超时被 kill / 其它 IO 错误都按暂时性失败处理（下轮再试）；
    // 只有 ffprobe 正常退出但报 Invalid data 才判定文件本身坏掉
    const invalidData = /invalid data/i.test(String(e.stderr || ''));
    return { valid: false, transient: !invalidData, audioTracks: 1 };
  }
}

// ffprobe 的 csv 输出 → { valid, transient, audioTracks }。同步版（probeMedia）
// 与异步版（probeMediaAsync）共用同一套判定逻辑，避免两处维护出分歧。
function parseProbeOut(out) {
  const lines = out.split('\n').map(l => l.trim()).filter(l => l && l.includes(','));
  if (lines.length === 0) return { valid: false, transient: false, audioTracks: 1 };
  const audio = lines
    .filter(l => l.startsWith('audio,'))
    .map(l => l.slice('audio,'.length))
    .filter(c => c && !/^(unknown|n\/a)?$/i.test(c));
  return { valid: true, transient: false, audioTracks: Math.max(1, audio.length) };
}

// 异步版探测：全量扫描用。原来的 execFileSync 是同步的——一次只能跑一个 ffprobe，
// 大曲库（几万个文件 × ~150ms/个）扫描动辄半小时起步，其中绝大部分时间 CPU 都
// 在等 ffprobe 的 IO/NV 而不是在干活。改成 spawn + 并发池后，多个探测同时进行，
// 吞吐按并发数成倍提升（SCAN_CONCURRENCY，默认 4，NAS CPU 弱可以调小）。
// 判定逻辑与同步版完全一致（parseProbeOut），失败语义也一致：
// 非 Invalid data 的失败一律按"暂时性失败"处理，下轮重试。
function probeMediaAsync(filepath) {
  const FFPROBE_ARGS = [
    '-v', 'error',
    '-analyzeduration', '10000000', '-probesize', '10000000',
    '-show_entries', 'stream=codec_type,codec_name',
    '-of', 'csv=p=0',
    filepath,
  ];
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let out = '', err = '';
    let p;
    try {
      p = spawn('ffprobe', FFPROBE_ARGS, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      done({ valid: false, transient: true, audioTracks: 1 });
      return;
    }
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, 20000);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', () => { clearTimeout(timer); done({ valid: false, transient: true, audioTracks: 1 }); });
    p.on('close', () => {
      clearTimeout(timer);
      if (out.trim()) { done(parseProbeOut(out)); return; }
      const invalidData = /invalid data/i.test(err);
      done({ valid: false, transient: !invalidData, audioTracks: 1 });
    });
  });
}

function probeAudioTracks(filepath) {
  try {
    // 只统计 codec_name 明确的音频流：MPEG-TS 里 ffprobe 可能把未知编码的
    // 流也报成音频（ffmpeg demux 却不认），照单全收会让数据库音轨数虚高，
    // 转码映射这些不存在的轨时直接失败。加 analyzeduration/probesize 提高
    // 对大 TS 文件的探测成功率。
    const out = execFileSync('ffprobe', [
      '-v', 'error',
      '-analyzeduration', '10000000', '-probesize', '10000000',
      '-select_streams', 'a',
      '-show_entries', 'stream=codec_name',
      '-of', 'csv=p=0',
      filepath
    ], { timeout: 20000 }).toString();
    const count = out.split('\n').map(l => l.trim()).filter(l => l && !/^(unknown|n\/a)?$/i.test(l)).length;
    return count > 0 ? count : 1;
  } catch (e) {
    console.error('ffprobe 音轨检测失败(' + path.basename(filepath) + '):', e.message);
    return 1; // 探测失败时按单音轨处理，不影响正常播放，只是不启用切换
  }
}

// Bug2修复：排除"已缺失的文件"。
// 原实现只根据 readdir 返回的目录项类型（entry.isDirectory()/文件名后缀）来判断是否入库，
// 完全没有校验文件是否真的可读/真的存在。这在网络曲库（NAS/软链接）场景下会漏判两类
// "已缺失"的情况：
//   1) 断开的软链接：readdirSync 只看链接本身的类型，不会跟随链接去检查目标是否存在，
//      一个指向已删除源文件的死链接会被当成正常视频文件收录进曲库，点唱时才发现播放不了。
//   2) 子目录在遍历过程中变得不可访问（网络共享抖动/权限变化）：原来的 readdirSync 会直接
//      抛异常，导致整个 scanLibrary() 中途崩溃退出，后面"清理已不存在文件记录"的逻辑根本
//      没机会执行，已经真正丢失的文件反而没有被清理掉。
// 修复：用 fs.existsSync(full) 顺着链接校验目标真实存在性来过滤死链接；用 try/catch 包裹
// 每一层目录的读取，单个坏目录只跳过不中断整体扫描。
// 递归深度上限：极端异常目录结构（如自引用软链接）下的硬性兜底，防止无限递归。
const MAX_SCAN_DEPTH = 64;

// 递归遍历曲库目录。
// 严重 bug 修复（CPU 一直吃满约 1 个核、容器一启动就发生且"什么都没做"）：
// 原实现对"是否目录"用 fs.statSync(full).isDirectory() 判断，而 statSync 会
// **跟随符号链接**。当 NAS 共享里存在指向自身/上级目录的软链接（音乐共享极常见：
// "最近添加""全部歌曲"之类链接，或子目录链接回卷根）时，递归会永不终止——表现
// 为 scanLibrary() 在容器启动后陷入转圈，单线程 Node 持续建路径/stat，占满一个
// CPU 核且不会自己降下来。这里两重防护彻底杜绝：
//   1) visited 以 realpath 为键记录已进入过的真实目录，软链接环第二次到达即剪枝
//      （仍允许正常地跟随一次软链接进入外部真实目录，只是不再重复进入）;
//   2) 深度上限兜底，防止任何未预料的极端嵌套把栈/内存吃爆。
function listFilesRecursive(dir, visited, depth) {
  if (visited === undefined) visited = new Set();
  if (depth === undefined) depth = 0;
  let results = [];
  if (depth > MAX_SCAN_DEPTH) return results;
  if (!fs.existsSync(dir)) return results;
  let real;
  try { real = fs.realpathSync(dir); } catch (e) { real = path.resolve(dir); }
  if (visited.has(real)) return results; // 软链接环 / 重复目录：剪枝，不再进入
  visited.add(real);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    console.error('曲库目录读取失败，已跳过(' + dir + '):', e.message);
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    // 几十万文件的曲库里逐项 statSync（SMB 上每次 1-5ms）仅枚举就要十几分钟，
    // 而 readdir({withFileTypes}) 已经给了类型：目录/普通文件直接用 Dirent 判断，
    // 只有符号链接（必须 stat 验证目标是否存在，死链跳过）和通过了后缀过滤的
    // 媒体文件（需要 mtime/size 做"未变化跳过探测"）才真正 stat。
    // 非媒体的普通文件（lrc/封面/文本…）不 stat 直接略过。
    if (entry.isDirectory()) {
      results = results.concat(listFilesRecursive(full, visited, depth + 1));
      continue;
    }
    if (entry.isSymbolicLink()) {
      // statSync 跟随符号链接：目标不存在（断链/已删除）或 stat 失败时抛错，
      // 直接跳过；挂载点抖动导致的临时失败同样在此被忽略，不中断整体扫描。
      let st;
      try { st = fs.statSync(full); } catch (e) { continue; }
      if (st.isDirectory()) {
        results = results.concat(listFilesRecursive(full, visited, depth + 1));
      } else if (MEDIA_EXT.has(path.extname(entry.name).toLowerCase())
          && !HLS_SEGMENT_RE.test(entry.name)) {
        results.push({ f: full, mtimeMs: st.mtimeMs, size: st.size });
      }
      continue;
    }
    if (!entry.isFile()) continue;   // fifo/socket 等特殊文件忽略
    if (!MEDIA_EXT.has(path.extname(entry.name).toLowerCase())) continue;
    if (HLS_SEGMENT_RE.test(entry.name)) continue; // HLS 播放缓存分片，不是曲库
    let st;
    try { st = fs.statSync(full); } catch (e) { continue; }
    // 把 stat 结果（mtime/size）一并带出：主流程用它判断"文件自上次扫描后
    // 有没有变过"，没变就跳过 ffprobe——反正是同一个文件，结论不会变。
    results.push({ f: full, mtimeMs: st.mtimeMs, size: st.size });
  }
  return results;
}

// 文件名解析规则: "歌手 - 歌名.mp4" 或 "歌名.mp4"
function parseFilename(filename) {
  const base = path.basename(filename, path.extname(filename));
  const sepList = [' - ', '-', '_'];
  for (const sep of sepList) {
    if (base.includes(sep)) {
      const idx = base.indexOf(sep);
      const artist = base.slice(0, idx).trim();
      const title = base.slice(idx + sep.length).trim();
      if (artist && title) return { artist, title };
    }
  }
  return { artist: '未知歌手', title: base };
}

// 麦动编号文件适配：纯数字文件名（如 0123456.ts）是 muse.db 的歌曲编号，
// 按"歌手 - 歌名"解析只会得到"未知歌手 - 0123456"。本地 muse.db 已就绪时
// 按编号反查真实歌名/歌手入库；查不到（muse.db 未就绪/编号不存在）回落
// 普通文件名解析。lookupByNo 是同步的且只在编号文件上触发，不拖慢普通扫描。
const muse = require('./muse');
function parseSongMeta(f) {
  const base = path.basename(f, path.extname(f)).trim();
  if (/^\d+$/.test(base)) {
    const m = muse.lookupByNo(base);
    if (m) return { artist: m.artist || '未知歌手', title: m.title || base };
  }
  return parseFilename(f);
}

// 让出一次事件循环。ffprobe 探测本身用的是同步的 execFileSync，扫描期间没法
// 避免这一小段阻塞，但只要在处理完每一个文件后都让一次事件循环，HTTP/WS
// 请求就能在文件与文件之间的间隙被正常处理，不会排队等到整轮扫描结束——这也
// 是让新入库的曲目能立刻通过 /api/songs 查到、主界面列表随扫描进度逐步变长
// （而不是等全部扫描完才一次性出现）的关键。
function yieldToEventLoop() {
  return new Promise(resolve => setImmediate(resolve));
}

async function scanLibrary() {
  // Bug2修复（关键安全防护）：MV_DIR 根目录如果暂时挂载失败/不可访问，listFilesRecursive
  // 会静默返回空数组，若不加防护，后面"清理已不存在文件记录"的逻辑会把当前数据库里
  // 全部曲目都当成"已缺失"一次性删光，属于灾难性误删。这里明确区分"目录不存在/不可访问"
  // 和"目录存在但确实没有文件"两种情况，前者直接中止扫描，不触发清理。
  const roots = scanRoots();
  if (!fs.existsSync(roots[0])) {
    console.error('曲库目录不可访问，已跳过本次扫描以避免误删曲库:', roots[0]);
    return { total: 0, added: 0, removed: 0, error: 'MV_DIR_UNAVAILABLE' };
  }
  // MP3_DIR 配置成独立目录但暂时不可访问（NAS 掉线/挂载抖动）：同样中止扫描，
  // 否则该目录名下的已入库曲目会被"清理缺失文件"阶段当成已缺失误删。
  for (const r of roots.slice(1)) {
    if (!fs.existsSync(r)) {
      console.error('MP3 下载目录不可访问，已跳过本次扫描以避免误删曲库:', r);
      return { total: 0, added: 0, removed: 0, error: 'DOWNLOAD_DIR_UNAVAILABLE: ' + r };
    }
  }
  // 汇总所有根目录下的媒体文件；rel 相对各自根目录并统一成正斜杠（filename
  // 唯一键沿用相对路径，两个根下同名相对路径的极端情况由 ON CONFLICT DO
  // NOTHING 去重）。统一 '/' 是为了让下载入库后的按 filename 查库（见
  // lxmusic.js/maidong.js）在 Linux/Windows 上行为一致。listFilesRecursive
  // 已顺便 stat 过每个文件，mtime/size 一并带出，供"未变化跳过探测"用。
  const files = [];
  for (const root of roots) {
    for (const x of listFilesRecursive(root)) {
      files.push({ f: x.f, rel: path.relative(root, x.f).replace(/\\/g, '/'), mtimeMs: x.mtimeMs, size: x.size });
    }
  }
  // 枚举完成，登记总数；下面逐个探测时推进 processed（供 /api/diag 区分
  // "扫描在正常推进"与"扫描卡住不动"——这两个现象的处理方式完全不同）。
  scanState.files = files.length;
  scanState.processed = 0;
  const insert = db.prepare(`
    INSERT INTO songs (title, artist, filename, filepath, audio_tracks, media_type, lyrics_path, lrc_karaoke, pinyin, pinyin_initial, lang)
    VALUES (@title, @artist, @filename, @filepath, @audio_tracks, @media_type, @lyrics_path, @lrc_karaoke, @pinyin, @pinyin_initial, @lang)
    ON CONFLICT(filename) DO NOTHING
  `);
  const existing = db.prepare('SELECT filename FROM songs').all().map(r => r.filename);
  const existingSet = new Set(existing);

  // scan_stat 已在模块加载时建表（顶部注释说明"未变化跳过探测"的原理）。
  // 库里已有但没有建档的文件（升级后首扫 / 旧版本下载入库的歌）：**信任库记录、
  // 直接登记不探测** —— 它们当初入库时都通过了 ffprobe 验证，几十万首的曲库
  // 如果首扫还要全量探测要跑好几个小时，毫无必要。代价是"入库时没发现的坏文件
  // 少了一次复查机会"，而这类文件内容一变（mtime 变）就会照常复查，风险可控。
  const seenStat = new Map(db.prepare('SELECT filename, mtime_ms, size FROM scan_stat').all().map(r => [r.filename, r]));
  const upsertStat = db.prepare('INSERT INTO scan_stat (filename, mtime_ms, size) VALUES (?, ?, ?) ON CONFLICT(filename) DO UPDATE SET mtime_ms = excluded.mtime_ms, size = excluded.size');
  const statUnchanged = (x) => {
    const s = seenStat.get(x.rel);
    // mtime 容差 2ms：跨文件系统（SMB/NAS）回读时可能有精度抖动
    return !!s && s.size === x.size && Math.abs(s.mtime_ms - x.mtimeMs) < 2;
  };

  // 渐进式扫描 + 并发探测：探测完成的歌立即单独 INSERT，/api/songs 马上能查到，
  // 主界面列表随扫描推进逐步变长。探测本身改为并发池（SCAN_CONCURRENCY，默认 4）
  // ——原来串行 execFileSync 一次只能跑一个 ffprobe，几万文件 × ~150ms 扫一轮要
  // 半小时以上；并发后吞吐按并发数成倍提升。单个文件失败只记日志跳过，不影响
  // 其余文件（沿用"单条失败不影响整体"原则）。
  // 分类：
  //   toProbe    —— 必须探测的：新文件（入库）；已入库但 mtime/size 变了的 .ts
  //                 （网络下载的 ts 是坏文件重灾区，内容变过就复查一遍）。
  //   skip       —— mtime/size 没变的已入库文件：直接跳过，不 ffprobe。
  let added = 0;
  // 本轮判定为"文件本身坏掉"的相对路径：不入库；已入库的同名记录也会在
  // 清理阶段被一并移除（连同它的队列/收藏/历史引用）。
  const brokenRel = new Set();
  const toProbe = [];
  let doneCount = 0;
  for (const x of files) {
    if (!existingSet.has(x.rel)) { toProbe.push(x); continue; }   // 新文件：必须探测入库
    const s = seenStat.get(x.rel);
    if (s && statUnchanged(x)) {                                  // 库里有 + 没变：完全跳过
      doneCount++;
      scanState.processed = doneCount;
      continue;
    }
    if (s && path.extname(x.rel).toLowerCase() === '.ts') {       // 内容变过的 ts：复查一遍
      toProbe.push(x);
      continue;
    }
    // 剩下两种都不用探测（老逻辑对非 ts 的已入库文件本来就不复查）：
    //   · 库里有但没建档（升级首扫）→ 信任库记录，直接登记
    //   · 库里有、内容变了的非 ts → 刷新登记，下轮起走"没变跳过"通道
    upsertStat.run(x.rel, x.mtimeMs, x.size);
    doneCount++;
    scanState.processed = doneCount;
  }
  const CONCURRENCY = Math.max(1, Math.min(16, parseInt(process.env.SCAN_CONCURRENCY || '4', 10) || 4));
  let cursor = 0;
  const probeWorker = async () => {
    while (cursor < toProbe.length) {
      const x = toProbe[cursor++];
      const { f, rel, mtimeMs, size } = x;
      const res = await probeMediaAsync(f);
      if (!existingSet.has(rel)) {
        // 新文件：损坏/下载不完整的（ffprobe 报 Invalid data）直接跳过不入库
        // ——播起来也是黑屏。暂时性失败（超时/IO 抖动）同样跳过本轮，保留待下轮重试。
        if (!res.valid) {
          if (res.transient) {
            console.warn('曲库扫描-文件探测暂时失败，本轮跳过待下轮重试:', rel);
          } else {
            brokenRel.add(rel);
            console.warn('曲库扫描-文件无法解析（损坏或下载不完整），已跳过:', rel);
          }
        } else {
          try {
            const { artist, title } = parseSongMeta(f);
            const media_type = AUDIO_EXT.includes(path.extname(f).toLowerCase()) ? 'audio' : 'video';
            // 音轨数在探测可解析性时顺带拿到，避免二次 ffprobe；纯音频永远单音轨。
            const audio_tracks = media_type === 'audio' ? 1 : res.audioTracks;
            const lyrics = findLyricsPath(f);
            // 歌词路径存绝对路径：下载目录可配置后歌词文件不一定在 MV_DIR 下，相对路径
            // 表达不了跨目录引用（/lyrics/:id 接口同时兼容旧库存量的相对路径）。
            const lyrics_path = lyrics ? lyrics : null;
            const lrc_karaoke = sniffLrcKaraoke(lyrics_path);
            const r = insert.run({ title, artist, filename: rel, filepath: f, audio_tracks, media_type, lyrics_path, lrc_karaoke, pinyin: toPinyin(title), pinyin_initial: toPinyinInitial(title), lang: detectLang(title, artist) });
            if (r.changes > 0) added++;
            upsertStat.run(rel, mtimeMs, size);   // 探测通过才登记；失败的下轮重试
          } catch (e) {
            console.error('曲库扫描-新增文件入库失败(' + rel + '):', e.message);
          }
        }
      } else {
        // 已入库但内容变过的 .ts 复查：坏文件记入 brokenRel，清理阶段连同其记录
        // 一起移除。探测通过才刷新 stat 登记（暂时性失败下轮要再试）。
        if (!res.valid && !res.transient) {
          brokenRel.add(rel);
          console.warn('曲库扫描-已入库的 .ts 无法解析（损坏或下载不完整），将移除:', rel);
        } else if (res.valid) {
          upsertStat.run(rel, mtimeMs, size);
        }
      }
      doneCount++;
      scanState.processed = doneCount;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, toProbe.length) }, probeWorker));

  // 已存在曲目补齐/刷新媒体类型和同名 LRC 路径（升级后 MP3 与歌词立即可用）。
  // 只 UPDATE 与预期不一致的行：原来对全部文件无条件 UPDATE，几万个空 UPDATE
  // 是纯浪费的 WAL 写放大；歌词目录读取走 mtime 缓存（readDirCached），同一
  // 歌手目录只 readdir 一次，且后补的歌词（目录 mtime 变了）仍会被发现。
  try {
    const rows = db.prepare('SELECT filename, media_type, lyrics_path, lrc_karaoke FROM songs').all();
    const rowMap = new Map(rows.map(r => [r.filename, r]));
    const updMeta = db.prepare('UPDATE songs SET media_type = ?, lyrics_path = ?, lrc_karaoke = ? WHERE filename = ?');
    for (const x of files) {
      const type = AUDIO_EXT.includes(path.extname(x.f).toLowerCase()) ? 'audio' : 'video';
      const lrc = findLyricsPath(x.f);
      const lrcPath = lrc ? lrc : null;
      const row = rowMap.get(x.rel);
      if (!row) continue;
      // 逐字标记只嗅探一次（null=从未嗅探过，升级首扫补齐）；路径变化时重嗅
      if (row.media_type !== type || row.lyrics_path !== lrcPath || row.lrc_karaoke == null) {
        updMeta.run(type, lrcPath, sniffLrcKaraoke(lrcPath), x.rel);
      }
    }
  } catch (e) {
    console.error('歌曲媒体类型/LRC 路径补全失败:', e.message);
  }

  // 兼容旧版本升级：把之前没探测过(audio_tracks为空)的老曲目补一遍。同样逐条
  // 处理并让出事件循环，避免老曲目数量很多时这一步又变成新的阻塞点。
  try {
    const pending = db.prepare('SELECT id, filepath FROM songs WHERE audio_tracks IS NULL').all();
    const upd = db.prepare('UPDATE songs SET audio_tracks = ? WHERE id = ?');
    for (const row of pending) {
      try {
        upd.run(probeAudioTracks(row.filepath), row.id);
      } catch (e) {
        console.error('曲库扫描-音轨补全失败(id=' + row.id + '):', e.message);
      }
      await yieldToEventLoop();
    }
  } catch (e) {
    console.error('曲库扫描-音轨补全阶段失败:', e.message);
  }

  // 清理已不存在的文件记录 + 本轮探测出"文件本身坏掉"的记录（brokenRel，文件
  // 还在磁盘上但无法解析，留着只会让用户点歌时黑屏）。
  // 全部改成纯 SQL 集合运算：原来是 SELECT 全表后逐行 JS 比对、每行开一个事务
  // 跑 4 条 DELETE——曲库 20 万行时是 20 万个小事务，光 fsync 就要好几分钟。
  // 现在建临时表装本轮文件集，"NOT IN + IN"四条批量 DELETE 一个事务搞定，
  // SQLite 内部完成比对，毫秒级；HLS 缓存目录在事务外逐个删（文件系统操作），
  // 用静默版（否则几十万行日志会刷爆日志文件、拖慢收尾）。
  let removed = 0;
  try {
    db.exec('CREATE TEMP TABLE IF NOT EXISTS scan_cur (filename TEXT PRIMARY KEY)');
    db.exec('CREATE TEMP TABLE IF NOT EXISTS scan_missing (id INTEGER PRIMARY KEY)');
    const insCur = db.prepare('INSERT OR IGNORE INTO scan_cur(filename) VALUES (?)');
    const fillAndClean = db.transaction(() => {
      db.prepare('DELETE FROM scan_cur').run();
      db.prepare('DELETE FROM scan_missing').run();
      for (const x of files) {
        if (!brokenRel.has(x.rel)) insCur.run(x.rel);
      }
      db.prepare('INSERT INTO scan_missing(id) SELECT id FROM songs WHERE filename NOT IN (SELECT filename FROM scan_cur)').run();
      // queue 表对 songs.id 有真实的外键约束，但 /api/queue/next 只会把已播完的
      // 队列条目标记成 status='done'，从来不会真正从 queue 表删除——这些"done"的
      // 历史队列记录会一直留着引用 song_id，导致删 songs 时被外键约束挡住
      // (FOREIGN KEY constraint failed)。所以先清 queue/history/favorites 里
      // 指向这些歌的记录（含悬空引用），再删 songs 本身。
      db.prepare('DELETE FROM queue WHERE song_id IN (SELECT id FROM scan_missing)').run();
      db.prepare('DELETE FROM history WHERE song_id IN (SELECT id FROM scan_missing)').run();
      db.prepare('DELETE FROM favorites WHERE song_id IN (SELECT id FROM scan_missing)').run();
      db.prepare('DELETE FROM songs WHERE id IN (SELECT id FROM scan_missing)').run();
      // stat 登记同步清掉（已删除文件的行不再有意义）
      db.prepare('DELETE FROM scan_stat WHERE filename NOT IN (SELECT filename FROM scan_cur)').run();
    });
    fillAndClean();
    removed = db.prepare('SELECT COUNT(*) AS c FROM scan_missing').get().c;
    for (const row of db.prepare('SELECT id FROM scan_missing').all()) {
      removeHLSSilent(row.id);
    }
    db.prepare('DELETE FROM scan_cur').run();
    db.prepare('DELETE FROM scan_missing').run();
  } catch (e) {
    console.error('曲库扫描-清理缺失文件阶段失败:', e.message);
  }

  return { total: files.length, added, removed, skipped: brokenRel.size };
}

// 单文件入库：下载/合成成功后只登记"这一个"文件，避免每首歌都触发整库全量扫描
// （递归遍历全部目录 + 逐文件 ffprobe + 全库清理缺失记录）导致 CPU 持续拉满。
// 新增文件以 filename（相对路径唯一键）去重；已存在则直接返回库内记录。同名 .lrc
// 一并关联。全量扫描（启动 / 手动 / bulk 整批结束）仍负责"清理已缺失文件"等同步。
function scanFile(f) {
  if (!f || !fs.existsSync(f)) return null;
  const base = path.basename(f);
  if (HLS_SEGMENT_RE.test(base)) return null;          // HLS 缓存分片不入库
  const ext = path.extname(f).toLowerCase();
  if (!MEDIA_EXT.has(ext)) return null;                // 非媒体文件忽略
  // 找到所属扫描根，算出相对路径（filename 唯一键沿用相对路径）
  const roots = scanRoots();
  let root = null, rel = null;
  for (const r of roots) {
    const rp = path.resolve(r);
    if (f === rp || f.startsWith(rp + path.sep)) { root = rp; rel = path.relative(rp, f).replace(/\\/g, '/'); break; }
  }
  if (!root) return null;
  const existing = db.prepare('SELECT * FROM songs WHERE filename=?').get(rel);
  if (existing) return existing;
  try {
    const { valid, transient } = probeMedia(f);
    if (!valid) {
      console.warn('单文件入库-文件未通过探测，跳过:', rel, transient ? '(暂时性)' : '(损坏)');
      return null;
    }
    const { artist, title } = parseSongMeta(f);
    const media_type = AUDIO_EXT.includes(ext) ? 'audio' : 'video';
    const audio_tracks = media_type === 'audio' ? 1 : probeAudioTracks(f);
    const lyrics_path = findLyricsPath(f) || null;
    const lrc_karaoke = sniffLrcKaraoke(lyrics_path);
    const insert = db.prepare(`
      INSERT INTO songs (title, artist, filename, filepath, audio_tracks, media_type, lyrics_path, lrc_karaoke, pinyin, pinyin_initial, lang)
      VALUES (@title, @artist, @filename, @filepath, @audio_tracks, @media_type, @lyrics_path, @lrc_karaoke, @pinyin, @pinyin_initial, @lang)
    `);
    insert.run({ title, artist, filename: rel, filepath: f, audio_tracks, media_type, lyrics_path, lrc_karaoke, pinyin: toPinyin(title), pinyin_initial: toPinyinInitial(title), lang: detectLang(title, artist) });
    // 顺手登记 mtime/size：下一轮全量扫描时这个文件就能走"未变化跳过探测"通道
    try {
      const st = fs.statSync(f);
      db.prepare('INSERT INTO scan_stat (filename, mtime_ms, size) VALUES (?, ?, ?) ON CONFLICT(filename) DO UPDATE SET mtime_ms = excluded.mtime_ms, size = excluded.size').run(rel, st.mtimeMs, st.size);
    } catch (e) {}
    return db.prepare('SELECT * FROM songs WHERE filename=?').get(rel);
  } catch (e) {
    console.error('单文件入库失败(' + rel + '):', e.message);
    return null;
  }
}

// ---------- 扫描状态（供 /api/diag 判断"CPU 高是不是正在扫曲库"） ----------
// 启动期那一次全量扫描最容易被误判成"CPU 一直高"：曲库大时它要跑很久（每个
// 文件都要起一次 ffprobe），而且每次重启/重建容器都会重来一遍。把"是否正在
// 扫描 + 上次结果 + 已跑多久"暴露出去，运维接口就能一眼区分"正在扫描"和
// "有东西在空转"——这两种情况处理方式完全不同。
const scanState = { scanning: false, startedAt: 0, finishedAt: 0, last: null, files: 0, processed: 0 };

function getScanState() {
  return {
    scanning: scanState.scanning,
    startedAt: scanState.startedAt,
    finishedAt: scanState.finishedAt,
    runningSec: scanState.scanning ? Math.round((Date.now() - scanState.startedAt) / 1000) : 0,
    // 进度：files=本轮枚举到的媒体文件总数（枚举阶段先把目录走完，此时只涨 files），
    // processed=已逐个探测处理的数量。两者一直不动 = 卡住；processed 在涨 = 正常推进
    // （这一步每首歌要起一次 ffprobe，慢是正常的，尤其首次扫描大曲库）。
    files: scanState.files,
    processed: scanState.processed,
    last: scanState.last,
  };
}

// 对外导出的是"带状态跟踪"的版本（index.js 的定时/启动扫描、bulk 结束后的
// 扫描都会走它，从而被 /api/diag 看见）；scanner 内部各函数仍调用原始
// scanLibrary，不额外包一层。
async function scanLibraryTracked(...args) {
  // 并发保护：扫描是重活（递归遍历目录 + 每个文件一次 ffprobe），同时跑两轮
  // 只会互相拖慢、把 CPU 翻倍，还可能出现两次扫描同时判定"文件缺失"的竞态。
  // 已在扫时直接返回"进行中"，由调用方决定怎么提示（/api/scan 会回 409）。
  if (scanState.scanning) {
    return { total: 0, added: 0, removed: 0, busy: true, error: 'IN_PROGRESS' };
  }
  scanState.scanning = true;
  scanState.startedAt = Date.now();
  scanState.files = 0;
  scanState.processed = 0;
  try {
    const r = await scanLibrary(...args);
    scanState.last = r;
    return r;
  } finally {
    scanState.scanning = false;
    scanState.finishedAt = Date.now();
  }
}

module.exports = { scanLibrary: scanLibraryTracked, scanFile, scanRoots, MV_DIR, probeAudioTracks, findLyricsPath, getScanState };
