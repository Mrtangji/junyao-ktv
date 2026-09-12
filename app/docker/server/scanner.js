const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const db = require('./db');
const { removeHLS } = require('./hlsgen');
const { toPinyin, toPinyinInitial } = require('./pinyin');
const { detectLang } = require('./lang');
const dlcfg = require('./dlconfig');

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
// 逐字歌词优先：同名再加 _word 后缀的（如「晴天_word.lrc」）是增强型 LRC
// （带 <mm:ss.xx> 逐字时间标签），优先于逐行版关联入库。
function findLyricsPath(filepath) {
  const dir = path.dirname(filepath);
  const stem = path.basename(filepath, path.extname(filepath));
  try {
    const names = fs.readdirSync(dir);
    const word = names.find(name => name.toLowerCase() === `${stem.toLowerCase()}_word.lrc`);
    const exact = names.find(name => name.toLowerCase() === `${stem.toLowerCase()}.lrc`);
    if (word) return path.join(dir, word);
    return exact ? path.join(dir, exact) : null;
  } catch (e) {
    return null;
  }
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
    const lines = out.split('\n').map(l => l.trim()).filter(l => l && l.includes(','));
    if (lines.length === 0) return { valid: false, transient: false, audioTracks: 1 };
    const audio = lines
      .filter(l => l.startsWith('audio,'))
      .map(l => l.slice('audio,'.length))
      .filter(c => c && !/^(unknown|n\/a)?$/i.test(c));
    return { valid: true, transient: false, audioTracks: Math.max(1, audio.length) };
  } catch (e) {
    // 超时被 kill / 其它 IO 错误都按暂时性失败处理（下轮再试）；
    // 只有 ffprobe 正常退出但报 Invalid data 才判定文件本身坏掉
    const invalidData = /invalid data/i.test(String(e.stderr || ''));
    return { valid: false, transient: !invalidData, audioTracks: 1 };
  }
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
function listFilesRecursive(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    console.error('曲库目录读取失败，已跳过(' + dir + '):', e.message);
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    // fs.existsSync 会跟随符号链接检查目标是否真实存在；断链/目标已删除的文件在此被排除
    if (!fs.existsSync(full)) continue;
    let isDir;
    try {
      isDir = entry.isDirectory() || fs.statSync(full).isDirectory();
    } catch (e) {
      continue; // 探测失败（如挂载点抖动导致stat失败），视为不可用文件，跳过
    }
    if (isDir) {
      results = results.concat(listFilesRecursive(full));
    } else if (MEDIA_EXT.has(path.extname(entry.name).toLowerCase())) {
      if (HLS_SEGMENT_RE.test(entry.name)) continue; // HLS 播放缓存分片，不是曲库
      results.push(full);
    }
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
  // lxmusic.js/maidong.js）在 Linux/Windows 上行为一致。
  const files = [];
  for (const root of roots) {
    for (const f of listFilesRecursive(root)) {
      files.push({ f, rel: path.relative(root, f).replace(/\\/g, '/') });
    }
  }
  const insert = db.prepare(`
    INSERT INTO songs (title, artist, filename, filepath, audio_tracks, media_type, lyrics_path, pinyin, pinyin_initial, lang)
    VALUES (@title, @artist, @filename, @filepath, @audio_tracks, @media_type, @lyrics_path, @pinyin, @pinyin_initial, @lang)
    ON CONFLICT(filename) DO NOTHING
  `);
  const existing = db.prepare('SELECT filename FROM songs').all().map(r => r.filename);
  const existingSet = new Set(existing);

  // 渐进式扫描：原来是先把所有新文件（含耗时的 ffprobe 音轨探测）都收集进一个
  // 数组，最后开一个大事务一次性批量 INSERT——这意味着不管曲库有多少首歌，都
  // 要等"最后一首"探测完，数据库里才会一次性冒出所有新歌，/api/songs 在这之
  // 前一直只能看到上一次扫描的结果。曲库越大（尤其首次安装、一次性批量导入
  // 几百上千首）主界面/点歌页面看起来就越像长时间"没有歌"，要等全部扫描完才
  // 突然出现完整列表。
  // 现在改成逐个文件探测、探测完立即单独 INSERT 并让出一次事件循环：前面已经
  // 扫完的歌马上就能被 /api/songs 查到，主界面列表随扫描推进逐步变长，不需要
  // 等后面的文件也扫完。单条记录探测/入库失败只记日志跳过，不影响其余文件
  // 继续扫描（沿用原来的"单条失败不影响整体"原则）。
  let added = 0;
  // 本轮判定为"文件本身坏掉"的相对路径：不入库；已入库的同名记录也会在
  // 清理阶段被一并移除（连同它的队列/收藏/历史引用）。
  const brokenRel = new Set();
  for (const { f, rel } of files) {
    if (!existingSet.has(rel)) {
      try {
        // 新文件先验证可解析性：损坏/下载不完整的文件（ffprobe 报 Invalid
        // data）直接跳过不入库——播起来也是黑屏。暂时性失败（超时/IO 抖动）
        // 同样跳过本轮，但保留记录待下轮重试。
        const { valid, transient, audioTracks } = probeMedia(f);
        if (!valid) {
          if (transient) {
            console.warn('曲库扫描-文件探测暂时失败，本轮跳过待下轮重试:', rel);
          } else {
            brokenRel.add(rel);
            console.warn('曲库扫描-文件无法解析（损坏或下载不完整），已跳过:', rel);
          }
          await yieldToEventLoop();
          continue;
        }
        const { artist, title } = parseSongMeta(f);
        const media_type = AUDIO_EXT.includes(path.extname(f).toLowerCase()) ? 'audio' : 'video';
        // 音轨数在探测可解析性时顺带拿到，避免二次 ffprobe；纯 MP3 永远单音轨。
        const audio_tracks = media_type === 'audio' ? 1 : audioTracks;
        const lyrics = findLyricsPath(f);
        // 歌词路径存绝对路径：下载目录可配置后歌词文件不一定在 MV_DIR 下，相对路径
        // 表达不了跨目录引用（/lyrics/:id 接口同时兼容旧库存量的相对路径）。
        const lyrics_path = lyrics ? lyrics : null;
        const r = insert.run({ title, artist, filename: rel, filepath: f, audio_tracks, media_type, lyrics_path, pinyin: toPinyin(title), pinyin_initial: toPinyinInitial(title), lang: detectLang(title, artist) });
        if (r.changes > 0) added++;
      } catch (e) {
        console.error('曲库扫描-新增文件入库失败(' + rel + '):', e.message);
      }
    } else if (path.extname(rel).toLowerCase() === '.ts') {
      // 已入库的 .ts 也复查可解析性：网络下载的 ts 是坏文件重灾区，且这类
      // 文件入库时可能还是旧的"失败回落 1 音轨"逻辑。坏文件记入 brokenRel，
      // 清理阶段连同其记录一起移除。
      const { valid, transient } = probeMedia(f);
      if (!valid && !transient) {
        brokenRel.add(rel);
        console.warn('曲库扫描-已入库的 .ts 无法解析（损坏或下载不完整），将移除:', rel);
      }
    }
    await yieldToEventLoop();
  }

  // 已存在曲目也要补齐/刷新媒体类型和同名 LRC 路径，确保升级后 MP3 与歌词立即可用。
  try {
    const updMeta = db.prepare('UPDATE songs SET media_type = ?, lyrics_path = ? WHERE filename = ?');
    for (const { f, rel } of files) {
      const type = AUDIO_EXT.includes(path.extname(f).toLowerCase()) ? 'audio' : 'video';
      const lrc = findLyricsPath(f);
      updMeta.run(type, lrc ? lrc : null, rel);
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

  // 清理已不存在的文件记录：这一步只有本地数据库增删操作，没有 ffprobe 这类
  // 耗时 IO，不是本次"渐进式"要解决的瓶颈，保持原有一次性事务写法。
  // 另外本轮探测出"文件本身坏掉"的记录（brokenRel）也一并清理——文件还在
  // 磁盘上但无法解析，留着只会让用户点歌时黑屏。
  let removed = 0;
  try {
    const currentRelSet = new Set(files.filter(x => !brokenRel.has(x.rel)).map(x => x.rel));
    const all = db.prepare('SELECT id, filename FROM songs').all();
    // queue 表对 songs.id 有真实的外键约束，但 /api/queue/next 只会把已播完的
    // 队列条目标记成 status='done'，从来不会真正从 queue 表删除——这些"done"的
    // 历史队列记录会一直留着引用 song_id，导致下面删 songs 这一行时被外键约束
    // 挡住(FOREIGN KEY constraint failed)，曲目实际没删掉，扫描结果里的歌曲数目
    // 也就跟着不对。删除歌曲前先把 queue/history/favorites 里所有指向这个
    // song_id 的记录一起清掉（history/favorites 虽然 schema 里没写真正的
    // FOREIGN KEY，但同样是指向已删除歌曲的悬空引用，一并清理避免后续查询/
    // 展示出问题），再删 songs 本身。
    const delQueue = db.prepare('DELETE FROM queue WHERE song_id = ?');
    const delHistory = db.prepare('DELETE FROM history WHERE song_id = ?');
    const delFavorites = db.prepare('DELETE FROM favorites WHERE song_id = ?');
    const del = db.prepare('DELETE FROM songs WHERE id = ?');
    const delSongAndRefs = db.transaction((id) => {
      delQueue.run(id);
      delHistory.run(id);
      delFavorites.run(id);
      del.run(id);
    });
    for (const row of all) {
      if (!currentRelSet.has(row.filename)) {
        try {
          delSongAndRefs(row.id);
          removeHLS(row.id);
          removed++;
        } catch (e) {
          // 单条记录删除失败（如HLS缓存目录权限问题）只记日志、跳过，不影响其余记录清理
          console.error('曲库扫描-删除已缺失曲目失败(id=' + row.id + '):', e.message);
        }
      }
    }
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
    const insert = db.prepare(`
      INSERT INTO songs (title, artist, filename, filepath, audio_tracks, media_type, lyrics_path, pinyin, pinyin_initial, lang)
      VALUES (@title, @artist, @filename, @filepath, @audio_tracks, @media_type, @lyrics_path, @pinyin, @pinyin_initial, @lang)
    `);
    insert.run({ title, artist, filename: rel, filepath: f, audio_tracks, media_type, lyrics_path, pinyin: toPinyin(title), pinyin_initial: toPinyinInitial(title), lang: detectLang(title, artist) });
    return db.prepare('SELECT * FROM songs WHERE filename=?').get(rel);
  } catch (e) {
    console.error('单文件入库失败(' + rel + '):', e.message);
    return null;
  }
}

module.exports = { scanLibrary, scanFile, scanRoots, MV_DIR, probeAudioTracks, findLyricsPath };
