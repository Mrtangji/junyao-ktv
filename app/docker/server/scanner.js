const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const db = require('./db');
const { removeHLS } = require('./hlsgen');
const { toPinyin, toPinyinInitial } = require('./pinyin');
const { detectLang } = require('./lang');

const MV_DIR = process.env.MV_DIR || '/mv';
// 新增对 .mpg (MPEG-1/2 Program Stream) 格式的支持：曲库扫描环节只需要把
// 后缀加入白名单即可正常入库；实际播放走 hlsgen.js 的转码流程，非 h264
// 编码（.mpg 源文件常见的 mpeg1video/mpeg2video）会被 SAFE_VIDEO_CODECS
// 判定为不可直拷贝，自动走 VAAPI/libx264 转码分支，不需要针对该格式
// 额外改动转码逻辑。
const VIDEO_EXT = ['.mp4', '.mkv', '.avi', '.flv', '.mov', '.webm', '.mpg'];
const AUDIO_EXT = ['.mp3'];
const MEDIA_EXT = new Set([...VIDEO_EXT, ...AUDIO_EXT]);

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
function probeAudioTracks(filepath) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a',
      '-show_entries', 'stream=index',
      '-of', 'csv=p=0',
      filepath
    ], { timeout: 15000 }).toString();
    const count = out.split('\n').map(l => l.trim()).filter(Boolean).length;
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
  if (!fs.existsSync(MV_DIR)) {
    console.error('曲库目录不可访问，已跳过本次扫描以避免误删曲库:', MV_DIR);
    return { total: 0, added: 0, removed: 0, error: 'MV_DIR_UNAVAILABLE' };
  }
  const files = listFilesRecursive(MV_DIR);
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
  for (const f of files) {
    const rel = path.relative(MV_DIR, f);
    if (!existingSet.has(rel)) {
      try {
        const { artist, title } = parseFilename(f);
        const media_type = AUDIO_EXT.includes(path.extname(f).toLowerCase()) ? 'audio' : 'video';
        // 新文件入库时顺手探测音轨数，避免播放时才发现切换不了；纯 MP3 永远是单音轨。
        const audio_tracks = media_type === 'audio' ? 1 : probeAudioTracks(f);
        const lyrics = findLyricsPath(f);
        const lyrics_path = lyrics ? path.relative(MV_DIR, lyrics) : null;
        const r = insert.run({ title, artist, filename: rel, filepath: f, audio_tracks, media_type, lyrics_path, pinyin: toPinyin(title), pinyin_initial: toPinyinInitial(title), lang: detectLang(title, artist) });
        if (r.changes > 0) added++;
      } catch (e) {
        console.error('曲库扫描-新增文件入库失败(' + rel + '):', e.message);
      }
    }
    await yieldToEventLoop();
  }

  // 已存在曲目也要补齐/刷新媒体类型和同名 LRC 路径，确保升级后 MP3 与歌词立即可用。
  try {
    const updMeta = db.prepare('UPDATE songs SET media_type = ?, lyrics_path = ? WHERE filename = ?');
    for (const f of files) {
      const rel = path.relative(MV_DIR, f);
      const type = AUDIO_EXT.includes(path.extname(f).toLowerCase()) ? 'audio' : 'video';
      const lrc = findLyricsPath(f);
      updMeta.run(type, lrc ? path.relative(MV_DIR, lrc) : null, rel);
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
  let removed = 0;
  try {
    const currentRelSet = new Set(files.map(f => path.relative(MV_DIR, f)));
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

  return { total: files.length, added, removed };
}

module.exports = { scanLibrary, MV_DIR, probeAudioTracks, findLyricsPath };
