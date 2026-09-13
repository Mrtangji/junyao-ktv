const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const db = require('./db');
const { scanLibrary, getScanState } = require('./scanner');
const dlcfg = require('./dlconfig');
const { toPinyin, toPinyinInitial } = require('./pinyin');
const { detectLang } = require('./lang');
const { ensureHLS, removeHLS, outDir, waitForFile, scheduleHLSCleanup, cancelAllActive, activeTranscodes, runningPids, pendingWaitCount, HLS_DIR } = require('./hlsgen');
const procmon = require('./procmon');
const appVersion = require('./version');
const maidong = require('./maidong');
const muse = require('./muse');
const { getPitchCurve } = require('./pitch');
const log = require('./logger');
const { firstSinger } = require('./singers');

const PORT = process.env.PORT || 8080;
// 请求体上限：主要是给「歌手批量下载」的歌手名单留余量——名单是整段文本 POST 上来的，
// 一万三千行就有 150KB 左右，远超 express 默认的 100KB，会被直接 413 挡掉；而 Express
// 默认的 413 响应是一个 HTML 错误页，前端 fetch(...).json() 只会报
//   Unexpected token '<', "<!DOCTYPE "... is not valid JSON
// 完全看不出是"名单太大"（见文件末尾的统一错误中间件，那条路已改成返回 JSON）。
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || '8mb';
const app = express();
app.use(express.json({ limit: JSON_BODY_LIMIT }));

// ---------- 「曲库管理」管理员登录 ----------
// 管理员密码不再通过安装/升级向导收集、也不写进 docker-compose.yml：改成
// 首次打开「曲库管理」(/admin) 时，由用户自己设置一个密码，哈希后存进
// SQLite 的 settings 表（key='admin_password_hash'，见 db.js），跟随 /data
// 一起持久化，升级、容器重建都不受影响。之后每次打开都是登录，不是设置。
// 登录成功后签发一个随机 session token，保存在内存里（进程重启/容器重建
// 后失效，需要重新登录，符合这类局域网轻量应用的预期），通过 httpOnly
// cookie 下发给浏览器。
// 注意：登录状态只用来保护「曲库管理」页面里真正的管理操作（编辑/删除
// 歌曲、改密码）；/api/scan、/api/songs 等电视端、手机点歌页面同样在用的
// 公共接口不受影响——电视端"扫描曲库"本来就需要有人在电视旁边用遥控器
// 操作，风险和曲库管理网页端裸露在局域网里不是一回事。
const ADMIN_PASSWORD_KEY = 'admin_password_hash';
const ADMIN_SESSION_COOKIE = 'ktv_admin_session';
const adminSessions = new Set();

function getAdminPasswordHash() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(ADMIN_PASSWORD_KEY);
  return row ? row.value : null;
}

function setAdminPasswordHash(hash) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(ADMIN_PASSWORD_KEY, hash);
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function hashesMatch(a, b) {
  const bufA = Buffer.from(String(a || '').padEnd(64, '0'));
  const bufB = Buffer.from(String(b || '').padEnd(64, '0'));
  return String(a).length === 64 && crypto.timingSafeEqual(bufA, bufB);
}

// 没有引入 cookie-parser，手动解析 Cookie 请求头即可，避免多引入一个依赖。
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function isAdminAuthed(req) {
  const token = parseCookies(req)[ADMIN_SESSION_COOKIE];
  return !!(token && adminSessions.has(token));
}

function requireAdminAuth(req, res, next) {
  if (isAdminAuthed(req)) return next();
  res.status(401).json({ error: '请先登录管理员账号' });
}

function startSession(res) {
  const token = crypto.randomBytes(24).toString('hex');
  adminSessions.add(token);
  res.cookie(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

// 前端据此判断该弹"设置密码"（首次使用）还是"登录"表单。
app.get('/api/admin/session', (req, res) => {
  res.json({ authed: isAdminAuthed(req), passwordSet: !!getAdminPasswordHash() });
});

// 首次使用：设置管理员密码。已经设置过密码后，这个接口不再允许直接覆盖
// （避免任何人不登录、光靠访问这个接口就能重置密码顶替管理员），改密码
// 走下面需要登录态的 /api/admin/change-password。
app.post('/api/admin/setup', (req, res) => {
  if (getAdminPasswordHash()) {
    return res.status(409).json({ error: '管理员密码已设置过，请使用登录' });
  }
  const { password } = req.body || {};
  if (!password || password.length < 4) {
    return res.status(400).json({ error: '密码至少 4 位' });
  }
  setAdminPasswordHash(sha256Hex(password));
  startSession(res);
  log.info('ADMIN', '首次设置曲库管理密码成功');
  res.json({ ok: true });
});

app.post('/api/admin/login', (req, res) => {
  const stored = getAdminPasswordHash();
  if (!stored) {
    return res.status(400).json({ error: '尚未设置管理员密码，请先设置' });
  }
  const { password } = req.body || {};
  const inputHash = password ? sha256Hex(password) : '';
  if (!hashesMatch(inputHash, stored)) {
    log.warn('ADMIN', '曲库管理登录失败：密码错误');
    return res.status(401).json({ error: '密码错误' });
  }
  startSession(res);
  log.info('ADMIN', '曲库管理登录成功');
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  const token = parseCookies(req)[ADMIN_SESSION_COOKIE];
  if (token) adminSessions.delete(token);
  res.clearCookie(ADMIN_SESSION_COOKIE);
  res.json({ ok: true });
});

// 登录状态下修改密码：需要正确提供当前密码，防止已经打开着「曲库管理」
// 页面的旁人（会话没过期时）随手把密码改掉。改密码后，为安全起见把其它
// 所有已登录的 session 一起失效，只保留当前这一个。
app.post('/api/admin/change-password', requireAdminAuth, (req, res) => {
  const stored = getAdminPasswordHash();
  const { oldPassword, newPassword } = req.body || {};
  const oldHash = oldPassword ? sha256Hex(oldPassword) : '';
  if (!stored || !hashesMatch(oldHash, stored)) {
    return res.status(401).json({ error: '当前密码不正确' });
  }
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: '新密码至少 4 位' });
  }
  setAdminPasswordHash(sha256Hex(newPassword));
  const token = parseCookies(req)[ADMIN_SESSION_COOKIE];
  adminSessions.clear();
  if (token) adminSessions.add(token);
  log.info('ADMIN', '曲库管理密码已修改');
  res.json({ ok: true });
});

// ---------- 静态资源 ----------
// 根地址直达 TV 端页面（http://host:8080 = /tv/）
app.get('/', (req, res) => res.redirect('/tv/'));
app.use('/tv',    express.static(path.join(__dirname, '../web/tv')));
app.use('/m',     express.static(path.join(__dirname, '../web/mobile')));
app.use('/admin', express.static(path.join(__dirname, '../web/admin')));
app.use('/cover', express.static('/data/covers'));

// 同名旁车歌词：例如 /mv/周杰伦 - 晴天.lrc。
// 只允许返回扫描器记录过的歌词文件，避免把容器内其它文件暴露给局域网客户端。
// 歌词内容按 UTF-8 返回；前端会兼容 BOM 和常见的 LRC 标签。
// 路径兼容两种存储格式：新版扫描器存绝对路径（下载目录可配置后歌词不一定在
// MV_DIR 下，校验放宽到 MV_DIR 或配置的下载目录之内）；旧库存的是 MV_DIR 相对
// 路径，首次重扫后会被自动升级为绝对路径，这里保留兜底。
app.get('/lyrics/:id', (req, res) => {
  const song = db.prepare('SELECT lyrics_path FROM songs WHERE id = ?').get(req.params.id);
  if (!song || !song.lyrics_path) return res.status(404).end();
  const raw = String(song.lyrics_path);
  const roots = [path.resolve(dlcfg.MV_DIR)];
  const mp3Root = path.resolve(dlcfg.MP3_DIR);
  if (mp3Root !== roots[0]) roots.push(mp3Root);
  let full;
  if (path.isAbsolute(raw)) {
    full = path.resolve(raw);
    // 绝对路径必须落在曲库根目录（MV_DIR/自定义下载目录）之内，防止越权读取
    if (!roots.some(root => full === root || full.startsWith(root + path.sep))) return res.status(404).end();
  } else {
    const rel = raw.replace(/\\/g, '/');
    if (!rel || rel.startsWith('/') || rel.includes('..')) return res.status(404).end();
    full = path.resolve(dlcfg.MV_DIR, rel);
    const root = roots[0];
    if (full !== root && !full.startsWith(root + path.sep)) return res.status(404).end();
  }
  try {
    if (!fs.statSync(full).isFile()) return res.status(404).end();
  } catch (e) {
    return res.status(404).end();
  }
  res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  fs.createReadStream(full).pipe(res);
});

// ---------- HLS 播放 (音轨切换不中断播放、进度可寻址) ----------
// 取代了旧的"?track=0/1 现场 ffmpeg 重新封装"方案：那个方案吐出的新流没有
// Content-Length/Range 支持，所以切音轨、以及切完音轨后拖进度条，都只能从
// 头播放。现在把视频轨和每条音频轨分别切成独立的 HLS 分片(.ts)，用一份
// master.m3u8 通过 EXT-X-MEDIA 把所有音频轨声明成同一个 AUDIO group。前端
// hls.js 加载它后，切音轨只是 hls.audioTrack = 0/1，只重新拉音频分片，视频
// 播放位置、连续性完全不受影响；HLS 分片本身天然可寻址，拖进度条对任意音轨
// 都正常工作。单音轨文件走同一套逻辑，master.m3u8 里只声明 1 条音频轨即可，
// 具体生成逻辑见 hlsgen.js。
// 渐进式：ensureHLS 不会等整首歌转码完成才 resolve —— 如果这首歌还没转过，
// 它会立刻创建输出目录、把 master.m3u8 写出来，然后把真正耗时的 ffmpeg 转码
// 丢到后台异步执行，函数本身几乎立即返回。所以这个路由的响应时间只取决于
// "有没有查到歌"和"磁盘 IO"，跟这首歌要转多久没有关系，不会再出现点歌后
// 卡在这一步转圈的情况。
app.get('/hls/:id/master.m3u8', async (req, res) => {
  markPlayerActivity();
  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(req.params.id);
  if (!song || !fs.existsSync(song.filepath)) return res.status(404).end();
  log.info('HLS', `请求播放 master.m3u8: id=${song.id} "${song.title || song.filename}"`);
  try {
    const m3u8Path = await ensureHLS(song);
    res.set({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
    fs.createReadStream(m3u8Path).pipe(res);
  } catch (e) {
    log.error('HLS', `master.m3u8 生成失败: id=${song.id} "${song.filename}": ${e.message}`);
    res.status(500).end();
  }
});

// 子播放列表(video.m3u8/audioN.m3u8)与分片(.ts)。file 名做白名单校验防止路径穿越，
// id 也强制要求纯数字，避免拼接出 outDir 之外的路径。
//
// 渐进式转码下，这些文件是随着后台 ffmpeg 进程持续产出的：播放器可能会在
// 某个分片刚好还没转出来的瞬间发出请求。这里不再"文件不存在就直接 404"，
// 而是短暂轮询等待它出现（waitForFile），一旦转码进度追上就立即响应——
// 真正做到"随出随播"，而不是让播放器自己重试或者干等整首歌转完。如果这
// 首歌的转码任务本身已经失败，或者等待太久都没等到（比如源文件损坏、卡在
// 极端情况），才会明确地报错而不是无限期挂起请求。
app.get('/hls/:id/:file', async (req, res) => {
  markPlayerActivity();
  const { id, file } = req.params;
  if (!/^\d+$/.test(id) || !/^[\w.-]+$/.test(file)) return res.status(400).end();
  const p = path.join(outDir(id), file);

  let ready = fs.existsSync(p);
  if (!ready) {
    try {
      await waitForFile(p, id);
      ready = true;
    } catch (e) {
      if (e.code === 'BUILD_FAILED') {
        log.error('HLS', `分片生成失败: id=${id}, file=${file}: ${e.cause && e.cause.message}`);
        return res.status(500).end();
      }
      log.warn('HLS', `等待分片超时: id=${id}, file=${file}`);
      return res.status(404).end(); // 等待超时，视为确实不存在（例如非法文件名/已被清理）
    }
  }

  if (file.endsWith('.m3u8')) res.set({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
  else if (file.endsWith('.ts')) res.set({ 'Content-Type': 'video/mp2t', 'Cache-Control': 'public, max-age=31536000, immutable' });
  fs.createReadStream(p).pipe(res);
});

// ---------- MV 直传流 (Range 请求) ----------
// 历史接口，现已不是 TV 播放器的主路径(见上面的 /hls)。保留作为兼容兜底：
// 例如 hls.js 加载失败、或未来某个场景需要拿到原始文件直传时使用。仍支持
// ?track=0/1（对多音轨文件用 ffmpeg -c copy 现场重新封装出单音轨流），但注意
// 这个分支吐出的流不支持 Range/寻址，只适合"整段从头播完"的用途，不要再用它
// 做音轨切换后还要拖进度条的场景——那正是旧 bug 的根因，具体解释见 /hls 路由。
// /stream 直传兜底（多音轨现场重封装）会临时起一个 ffmpeg。它不走 hlsgen 的
// 转码登记表，这里单独登记 pid —— 一是让"孤儿 ffmpeg 巡检"知道它是合法进程，
// 不会误杀；二是 /api/diag 能把它和 HLS 转码区分开。
const liveStreamProcs = new Set();

app.get('/stream/:id', (req, res) => {
  markPlayerActivity();
  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(req.params.id);
  if (!song || !fs.existsSync(song.filepath)) return res.status(404).end();

  const trackParam = req.query.track;
  const hasMultiTrack = (song.audio_tracks || 1) >= 2;

  if (trackParam !== undefined && hasMultiTrack) {
    const track = Math.max(0, Math.min(parseInt(trackParam, 10) || 0, song.audio_tracks - 1));
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'none',   // 现场重新封装，长度未知，无法支持 Range 拖进度
      'Cache-Control': 'no-store',
    });
    const ff = spawn('ffmpeg', [
      '-loglevel', 'error',
      '-i', song.filepath,
      '-map', '0:v:0',
      '-map', `0:a:${track}`,
      '-c', 'copy',
      '-movflags', 'frag_keyframe+empty_moov+faststart',
      '-f', 'mp4',
      'pipe:1',
    ]);
    let responded = false;
    if (ff.pid) liveStreamProcs.add(ff.pid);
    ff.stdout.pipe(res);
    ff.stderr.on('data', d => log.warn('TRANSCODE', `[stream直传兜底][ffmpeg] ${d.toString().trim()}`));
    const cleanup = () => {
      liveStreamProcs.delete(ff.pid);
      if (!ff.killed) { try { ff.kill('SIGKILL'); } catch (e) {} }
    };
    ff.on('close', () => liveStreamProcs.delete(ff.pid));
    ff.on('error', err => { log.error('TRANSCODE', `[stream直传兜底] ffmpeg 启动失败: ${err.message}`); if (!responded) { responded = true; res.status(500).end(); } cleanup(); });
    res.on('close', cleanup);
    return;
  }

  const stat = fs.statSync(song.filepath);
  // 音频按实际后缀给 Content-Type（曲库现在也收 FLAC/WAV 等无损文件），
  // 认不出的后缀仍旧回落 audio/mpeg，行为与之前一致。
  const AUDIO_MIME = {
    '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
    '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav',
  };
  const contentType = song.media_type === 'audio'
    ? (AUDIO_MIME[path.extname(song.filepath).toLowerCase()] || 'audio/mpeg')
    : 'video/mp4';
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': contentType });
    return fs.createReadStream(song.filepath).pipe(res);
  }
  const [s, e] = range.replace(/bytes=/, '').split('-');
  const start = parseInt(s, 10);
  const end = e ? parseInt(e, 10) : stat.size - 1;
  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Content-Type': contentType,
  });
  fs.createReadStream(song.filepath, { start, end }).pipe(res);
});

// ---------- 原唱/伴唱切换状态上报 ----------
// 实际的切换动作(hls.audioTrack=0/1 或者声道复制)完全发生在浏览器端
// (见 web/tv/index.html 的 VoiceManager)，服务端本身并不参与、也就无从
// 知晓用户什么时候切了原唱/伴唱。这里加一个轻量上报接口，由前端在每次
// 切换后调用一次，让这个状态变化也能进 docker 后台日志，方便排查
// "切了没生效"之类的问题。上报失败与否不影响播放本身，前端是 fire-and-forget。
app.post('/api/voice/switch', (req, res) => {
  const { song_id, mode, to } = req.body || {};
  const song = song_id ? db.prepare('SELECT id, title, filename FROM songs WHERE id = ?').get(song_id) : null;
  const songTag = song ? `id=${song.id} "${song.title || song.filename}"` : `id=${song_id || '未知'}`;
  const toName = to === 'original' ? '原唱' : to === 'accompaniment' ? '伴唱' : (to || '未知');
  const modeName = mode === 'tracks' ? '多音轨(HLS audioTrack)' : mode === 'stereo' ? '双声道(Web Audio 声道复制)' : (mode || '未知');
  log.info('VOICE', `切换音轨: ${songTag} -> ${toName} (方式: ${modeName})`);
  res.json({ ok: true });
});

// ---------- 歌曲库 ----------
app.get('/api/songs', (req, res) => {
  const q = (req.query.q || '').trim();
  const artist = (req.query.artist || '').trim();
  const lang = (req.query.lang || '').trim();
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 100));
  const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
  // 语言筛选：lang 为空表示「全部」。
  // 注意：不能用 (? = '' OR lang = ?) 的守卫写法——OR 里带绑定参数会让 SQLite
  // 放弃 idx_songs_lang_rank 而退化成全表扫描（实测 4 万首走 SCAN songs 约
  // 1.95ms）。改为按 lang 是否为空拼接 SQL 与参数，有筛选时明确写 lang = ?，
  // 才能命中复合索引（实测 0.07ms，约 28 倍差距）。
  const langSql = lang ? ' AND lang = ?' : '';
  const langArg = lang ? [lang] : [];
  let rows;
  if (artist) {
    rows = db.prepare(`SELECT * FROM songs WHERE artist = ?${langSql} ORDER BY title LIMIT ? OFFSET ?`)
      .all(artist, ...langArg, limit, offset);
  } else if (q) {
    // 纯字母(拼音首字母/全拼，如 zjl / zhoujielun)走服务端拼音列查询：用 >=/< 区间
    // 扫 B-tree 索引，4 万首也是微秒级，且不依赖前端全量加载。这样点歌面板的字母
    // 键盘、以及搜索框输入拼音都能直接命中，而不必把整库拉到浏览器。
    if (/^[a-zA-Z]+$/.test(q)) {
      const ql = q.toLowerCase();
      const hi = ql + '{'; // '{' (0x7B) 大于任何小写字母，作为前缀上限
      rows = db.prepare(`
        SELECT s.* FROM (
          SELECT s.* FROM songs s WHERE s.pinyin >= ? AND s.pinyin < ?${langSql}
          UNION
          SELECT s.* FROM songs s WHERE s.pinyin_initial >= ? AND s.pinyin_initial < ?${langSql}
        ) s ORDER BY s.play_count DESC, s.id DESC LIMIT ? OFFSET ?
      `).all(ql, hi, ...langArg, ql, hi, ...langArg, limit, offset);
    // FTS5 trigram 可命中中文任意片段；长度不足 3 个字符时仍走 LIKE，保证短词可搜。
    } else if (db.fts5Ready && q.length >= 3) {
      const match = q.replace(/["*:^(){}\[\]]/g, ' ').trim();
      if (!match) return res.json([]);
      rows = db.prepare(`
        SELECT s.* FROM songs s JOIN songs_fts f ON f.rowid = s.id
        WHERE songs_fts MATCH ?${langSql} ORDER BY s.play_count DESC, s.id DESC LIMIT ? OFFSET ?
      `).all(match, ...langArg, limit, offset);
    } else {
      rows = db.prepare(`SELECT * FROM songs WHERE (title LIKE ? OR artist LIKE ?)${langSql} ORDER BY play_count DESC, id DESC LIMIT ? OFFSET ?`)
        .all(`%${q}%`, `%${q}%`, ...langArg, limit, offset);
    }
  } else {
    // 默认列表也分页，避免 40,000 首歌曲一次性序列化并传给电视/手机浏览器。
    // 有语言筛选时明确写 lang = ? 以命中复合索引，无筛选时走 play_count 索引。
    rows = lang
      ? db.prepare('SELECT * FROM songs WHERE lang = ? ORDER BY play_count DESC, id DESC LIMIT ? OFFSET ?').all(lang, limit, offset)
      : db.prepare('SELECT * FROM songs ORDER BY play_count DESC, id DESC LIMIT ? OFFSET ?').all(limit, offset);
  }
  res.set('Cache-Control', 'no-store');
  res.json(rows);
});

// 按首字母搜索
app.get('/api/songs/letter/:letter', (req, res) => {
  const letter = req.params.letter.toUpperCase();
  const rows = db.prepare('SELECT * FROM songs WHERE UPPER(SUBSTR(title,1,1)) = ? ORDER BY title LIMIT 100').all(letter);
  res.json(rows);
});

// ---------- 歌手列表 ----------
app.get('/api/artists', (req, res) => {
  // 每位歌手返回其主导语言(歌曲数最多的语言)，供歌星面板按语言筛选。
  const rows = db.prepare(`
    SELECT s.artist, COUNT(*) as count,
      (SELECT lang FROM songs s2 WHERE s2.artist = s.artist GROUP BY lang ORDER BY COUNT(*) DESC LIMIT 1) as lang
    FROM songs s WHERE s.artist IS NOT NULL AND s.artist != '' GROUP BY s.artist ORDER BY s.artist
  `).all();
  res.json(rows);
});

// ---------- 历史 (常唱) ----------
app.get('/api/history', (req, res) => {
  const rows = db.prepare(`
    SELECT s.*, COUNT(h.id) as times_sung
    FROM songs s JOIN history h ON s.id = h.song_id
    GROUP BY s.id ORDER BY times_sung DESC, s.play_count DESC LIMIT 50
  `).all();
  res.json(rows);
});

// ---------- 唱歌评分 ----------
// 参考音高曲线：首次请求时用 ffmpeg 从「原唱音轨」(第 0 条) 离线提取并落盘缓存，
// 之后直接读缓存（源文件被替换会自动失效重建）。一首 4 分钟的歌首次提取约
// 5~15 秒（取决于 CPU），前端要按"评分准备中"处理这段延迟。
app.get('/api/songs/:id/pitch', (req, res) => {
  const song = db.prepare('SELECT id, filepath, title FROM songs WHERE id = ?').get(req.params.id);
  if (!song) return res.status(404).json({ error: '歌曲不存在' });
  getPitchCurve(song)
    .then(curve => { res.set('Cache-Control', 'no-store'); res.json(curve); })
    .catch(e => res.status(502).json({ error: '音高曲线提取失败', detail: e.message }));
});

// 提交演唱成绩。广播给所有 WS 客户端，电视端可以即时弹"本曲得分"。
app.post('/api/scores', (req, res) => {
  const { song_id, score, grade, device } = req.body || {};
  const sid = Number.parseInt(song_id, 10);
  const sc = Number(score);
  if (!Number.isFinite(sid) || !Number.isFinite(sc)) {
    return res.status(400).json({ error: '参数不合法' });
  }
  const g = (grade || '').toString().slice(0, 4);
  const d = (device || '').toString().slice(0, 64);
  db.prepare('INSERT INTO scores(song_id, score, grade, device) VALUES(?,?,?,?)').run(sid, sc, g, d);
  const best = db.prepare('SELECT MAX(score) AS best FROM scores WHERE song_id = ?').get(sid).best;
  const payload = JSON.stringify({
    type: 'score', data: { song_id: sid, score: sc, grade: g, device: d, best: best ?? sc },
  });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(payload); });
  res.json({ ok: true, best: best ?? sc });
});

// 某首歌的历史最高分（点歌面板/成绩面板显示"历史最高"用）。
app.get('/api/songs/:id/best-score', (req, res) => {
  const row = db.prepare('SELECT MAX(score) AS best, COUNT(*) AS cnt FROM scores WHERE song_id = ?').get(req.params.id);
  res.json({ best: row.best ?? null, count: row.cnt });
});

// 最近的演唱成绩（评分面板"打榜"列表）。
app.get('/api/scores/recent', (req, res) => {
  const rows = db.prepare(`
    SELECT sc.score, sc.grade, sc.created_at, s.title, s.artist
    FROM scores sc JOIN songs s ON s.id = sc.song_id
    ORDER BY sc.id DESC LIMIT 20
  `).all();
  res.json(rows);
});

// ---------- LX Music（音源导入 / 网络搜索 / 榜单 / 下载点唱） ----------
const lxmusic = require('./lxmusic');
const boardsdk = require('./boardsdk');
lxmusic.initActiveSource();

// 当前激活源 + 已导入源列表
app.get('/api/lx/source', (req, res) => {
  const act = lxmusic.activeSource();
  const list = db.prepare('SELECT id,name,description,version,author,homepage,created_at FROM lx_sources ORDER BY id DESC').all();
  res.json({
    active: act ? { id: act.id, name: act.meta.name, sources: act.sources } : null,
    list,
  });
});

// 导出源脚本原文（?download=1 时按文件下载）。局域网内自用：排查音源问题时
// 把脚本拉到本地沙箱逐请求调试，不必在服务器上反复部署试错。
app.get('/api/lx/source/:id/script', (req, res) => {
  const row = db.prepare('SELECT id, name, script FROM lx_sources WHERE id=?').get(parseInt(req.params.id));
  if (!row) return res.status(404).json({ error: '源不存在' });
  if (req.query.download) {
    res.setHeader('Content-Disposition', `attachment; filename="lx-source-${row.id}.js"`);
    res.type('text/javascript; charset=utf-8');
  }
  res.send(row.script);
});

// 导入源：{ script: '源脚本内容' } 或 { url: 'http://.../source.js' }
app.post('/api/lx/source', async (req, res) => {
  try {
    let script = req.body.script;
    if (!script && req.body.url) {
      const resp = await fetch(req.body.url).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); });
      script = resp;
    }
    if (!script || typeof script !== 'string' || script.length < 50) return res.status(400).json({ error: '缺少有效脚本内容' });
    const inst = await lxmusic.activateScript(script); // 校验可运行后才入库
    const info = db.prepare('INSERT INTO lx_sources (name,description,version,author,homepage,script) VALUES (?,?,?,?,?,?)')
      .run(inst.meta.name, inst.meta.description, inst.meta.version, inst.meta.author, inst.meta.homepage, script);
    await lxmusic.activateSourceById(info.lastInsertRowid);
    res.json({ ok: true, id: info.lastInsertRowid, name: inst.meta.name, sources: inst.sources });
  } catch (e) {
    res.status(400).json({ error: '源导入失败: ' + e.message });
  }
});

app.delete('/api/lx/source/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const act = lxmusic.activeSource();
  db.prepare('DELETE FROM lx_sources WHERE id=?').run(id);
  if (act && act.id === id) {
    db.prepare("DELETE FROM settings WHERE key='lx_active_source'").run();
    lxmusic.deactivateSource();
  }
  res.json({ ok: true });
});

app.post('/api/lx/source/:id/activate', async (req, res) => {  try {
    const act = await lxmusic.activateSourceById(parseInt(req.params.id));
    res.json({ ok: true, name: act.meta.name, sources: act.sources });
  } catch (e) { res.status(400).json({ error: '源启用失败: ' + e.message }); }
});

// 榜单歌曲本地拥有情况（点唱榜「MP3/MV/MP3+MV」标签）：
// 标题（宽松匹配，与 findLocalSong 同口径）→ 本地曲库各匹配行的 media_type，
// 任一 audio 行 = 有 MP3，任一 video 行 = 有 MV。标题 Map 缓存 60s，避免
// 每次翻榜单都全表拉取；模糊回落只对未精确命中的少数歌曲逐条 LIKE 查询。
let _locMap = null, _locMapAt = 0;
// 标题归一化：小写 + 去掉所有非字母/数字/汉字字符（空格、点、括号等），
// 「Mr.Q」「Mr Q」「mr q」归一为同一键，规避下载入库时 sanitize 去符号的差异
function normTitle(t) {
  return String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}
function localSongMap() {
  if (_locMap && Date.now() - _locMapAt < 60000) return _locMap;
  const map = new Map();
  for (const r of db.prepare('SELECT title, artist, media_type, lyrics_path, lrc_karaoke FROM songs').all()) {
    const k = normTitle(r.title);
    if (!k) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push({ artist: String(r.artist || '').toLowerCase(), mt: r.media_type, lrc: !!r.lyrics_path, lrcx: !!r.lrc_karaoke });
  }
  _locMap = map; _locMapAt = Date.now();
  return map;
}
function localFlags(name, singer) {
  const map = localSongMap();
  const t = normTitle(name);
  if (!t) return { mp3: false, mv: false };
  let rows = map.get(t);
  if (!rows) {
    // 榜名常带 (HD)/(Live) 等画质后缀而本地入库时已去掉，去掉后缀再试精确
    const t2 = t.replace(/(hd|hq|live|mv|4k|1080p|720p)$/i, '');
    if (t2 && t2 !== t) rows = map.get(t2);
  }
  if (!rows) {
    // 模糊回落：本地标题与榜名互相包含（处理简称/全称等差异）
    const found = [];
    for (const [k, v] of map) {
      if (k.includes(t) || t.includes(k)) { found.push(...v); if (found.length >= 20) break; }
    }
    rows = found;
  }
  if (!rows || !rows.length) return { mp3: false, mv: false };
  const s = String(singer || '').toLowerCase();
  let matched = rows;
  if (s) {
    const first = firstSinger(s).trim();
    const m = rows.filter(r => (r.artist && (s.includes(r.artist) || r.artist.includes(first))) || !r.artist || r.artist === '未知歌手');
    // 歌手过滤无命中时不强行过滤（榜名歌手写法差异大），退回全部标题匹配
    if (m.length) matched = m;
  }
  return { mp3: matched.some(r => r.mt === 'audio'), mv: matched.some(r => r.mt === 'video'), lrc: matched.some(r => r.lrc), lrcx: matched.some(r => r.lrcx) };
}
function attachLocalFlags(list) {
  if (!Array.isArray(list) || !list.length) return list;
  return list.map(s => {
    try {
      const f = localFlags(s.name, s.singer);
      return { ...s, localMp3: !!f.mp3, localMv: !!f.mv, localLrc: !!f.lrc, localLrcx: !!f.lrcx };
    } catch (e) { return s; }
  });
}

// 榜单列表（KTV点唱榜等）
// 榜单列表（src: kw/wy/tx/kg，缺省 kw；四平台统一由 boardsdk 提供）
app.get('/api/lx/boards', async (req, res) => {
  const src = boardsdk.isValidSource(req.query.src) ? req.query.src : 'kw';
  try { res.json(await boardsdk.boards(src)); }
  catch (e) { res.status(502).json({ error: '榜单获取失败: ' + e.message }); }
});

// 榜单歌曲
app.get('/api/lx/board', async (req, res) => {
  const src = boardsdk.isValidSource(req.query.src) ? req.query.src : 'kw';
  const limit = parseInt(req.query.limit) || 100;
  try {
    const r = await boardsdk.boardSongs(src, req.query.bangid || '255', parseInt(req.query.page) || 1, limit);
    r.list = attachLocalFlags(r.list);
    res.json(r);
  } catch (e) {
    // 四平台榜单直连失败（平台接口失效 / 服务器到不了官网）→ 兜底本站热门点唱榜，保证点唱榜可用
    // 服务器能直连时上方 try 已返回真实榜，不会走到这里
    try {
      const rows = db.prepare('SELECT id,title,artist,album,cover FROM songs WHERE media_type=? ORDER BY play_count DESC, id DESC LIMIT ?').all('audio', limit);
      const list = rows.map(s => ({ songmid: String(s.id), name: s.title, singer: s.artist || '', album: s.album || '', pic: s.cover || '', src, duration: 0 }));
      res.json({ list: attachLocalFlags(list), total: list.length, page: 1, limit: list.length, fallback: true, fallbackReason: '平台榜单接口暂不可用，已显示本站热门点唱' });
    } catch (e2) {
      res.status(502).json({ error: '榜单获取失败: ' + e.message });
    }
  }
});

// 网络搜索（src: kw/wy/tx/kg，缺省 kw；四平台统一由 boardsdk 提供）
app.get('/api/lx/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ list: [], total: 0, page: 1, limit: 30 });
  const src = boardsdk.isValidSource(req.query.src) ? req.query.src : 'kw';
  try {
    res.json(await boardsdk.search(src, q, parseInt(req.query.page) || 1, parseInt(req.query.limit) || 30));
  } catch (e) { res.status(502).json({ error: '网络搜索失败: ' + e.message }); }
});

// 音源解析诊断：不下载不入库，让**当前激活音源**解析指定音质的直链，并抓取
// 返回内容的头部嗅探真实格式。用于排查"选 FLAC 却拿到 MP3"——脚本对 flac
// 请求返回的到底是 FLAC 还是 320K，一测便知（ URL 与嗅探结果都给出来）。
// query: songmid（必填）、src（平台 kw/wy/tx/kg）、quality（flac/flac24bit/320k/128k）、
//        name/singer（可选，部分源脚本换链要用）
app.get('/api/lx/probe-url', async (req, res) => {
  const { songmid, name, singer } = req.query;
  if (!songmid) return res.status(400).json({ error: '缺少 songmid' });
  const platform = ['kw', 'wy', 'tx', 'kg'].includes(req.query.src) ? req.query.src : 'kw';
  const q = ['flac24bit', 'flac', '320k', '128k'].includes(req.query.quality) ? req.query.quality : 'flac';
  const musicInfo = { songmid, songId: songmid, musicId: songmid, hash: songmid, id: songmid, name: name || '', singer: singer || '', source: platform };
  try {
    const url = await lxmusic.resolveMusicUrl(musicInfo, q);
    let sniff = null;
    let contentType = null;
    try {
      // 只抓头部 64KB（Range，能省则省；服务器不支持 Range 就多下点也无妨）
      const r = await lxmusic.internals.httpReq(url, { responseType: 'buffer', timeout: 15000, headers: { Range: 'bytes=0-65535' } });
      contentType = (r.headers && r.headers['content-type']) || null;
      const s = lxmusic.internals.sniffAudio(r.body);
      sniff = { kind: s.kind, detail: s.detail || null };
    } catch (e) { sniff = { kind: 'sniff-error', detail: e.message }; }
    res.json({ ok: true, platform, quality: q, url: url.replace(/([?&])(sign|token|key)=[^&]*/gi, '$1***'), sniff, contentType });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// 点唱：本地有直接入队；没有则下载入库再入队。body: {songmid,name,singer,pic,format,src}
// src: 歌曲来源平台 kw/wy/tx/kg（缺省 kw），服务端据此用对应平台源换链下载（源过期自动换源）；
// format: 'mp3'（默认，320K 优先）| 'mv'（320K 音频+封面合成视频，走 MV 播放路径；
//         同时保留同名 .mp3 与 .lrc，曲库自动入库双版本）
app.post('/api/lx/queue', async (req, res) => {
  const { songmid, name, singer, pic, format, src } = req.body || {};
  if (!songmid || !name) return res.status(400).json({ error: '缺少 songmid/name' });
  const platform = boardsdk.isValidSource(src) ? src : 'kw';
  // 平台换链必需字段（kg 的 FileHash、tx 的数字 songId/strMediaMid 等）原样透传
  const info = {};
  for (const k of ['hash', 'songId', 'strMediaMid', 'albumAudioId', 'duration']) {
    if (req.body[k] != null && req.body[k] !== '') info[k] = req.body[k];
  }
  let song = lxmusic.findLocalSong(name, singer);
  let downloaded = false;
  if (!song) {
    try {
      let lrcText = null;
      try { lrcText = await boardsdk.lyricText(platform, { songmid, name, singer, pic, ...info }); } catch (e) {}
      song = await lxmusic.downloadSong({ songmid, name, singer, pic: pic || null, format: ['mv', 'flac'].includes(format) ? format : 'mp3', source: platform, lrcText, info });
      downloaded = true;
    } catch (e) {
      if (e.message === 'MV_DIR_UNAVAILABLE') return res.status(503).json({ error: '曲库目录不可访问' });
      return res.status(502).json({ error: '下载失败: ' + e.message });
    }
  }
  const q = db.prepare('INSERT INTO queue (song_id,nickname) VALUES (?,?)').run(song.id, '网络点唱');
  db.prepare('UPDATE songs SET play_count=play_count+1 WHERE id=?').run(song.id);
  startPlayingIfIdle(q.lastInsertRowid);
  broadcastQueue();
  res.json({ ok: true, downloaded, song });
});

// ---------- 麦动 KTV 点歌系统（点歌榜来源之二，见 server/maidong.js） ----------
// 双源：catalog.json/API 音源（原有两项）+ muse.db 曲库/排行榜（museUrl 配置后启用），
// 点歌榜分类按 bangid 前缀（muse_all / muse_rank_* / cat_* / __all__）分流到对应源。
app.get('/api/md/config', async (req, res) => {
  const cfg = maidong.getConfig();
  let museOk = false, museSongs = 0;
  try { museOk = muse.available(); if (museOk) museSongs = muse.songCount(); } catch (e) {}
  res.json({ ...cfg, museOk, museSongs });
});
app.post('/api/md/config', (req, res) => {
  try { res.json(maidong.setConfig(req.body || {})); }
  catch (e) { res.status(400).json({ error: '麦动配置保存失败: ' + e.message }); }
});
app.get('/api/md/boards', async (req, res) => {
  try { res.json(await maidong.boards()); }
  catch (e) { res.status(502).json({ error: '麦动曲库分类获取失败: ' + e.message }); }
});
app.get('/api/md/board', async (req, res) => {
  try {
    const r = await maidong.boardSongs(req.query.bangid || '__all__', parseInt(req.query.page) || 1,
      parseInt(req.query.limit) || 100, req.query.q || '');
    r.list = attachLocalFlags(r.list);
    res.json(r);
  } catch (e) { res.status(502).json({ error: '麦动榜单获取失败: ' + e.message }); }
});
app.get('/api/md/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ list: [], total: 0, page: 1, limit: 0 });
  const page = parseInt(req.query.page) || 1;
  try {
    // 麦动 muse.db 曲库优先（本地库、最常唱排序）；未启用/无结果再退其它源
    if (muse.getMuseUrl()) {
      const r = await muse.allSongs({ q, page, limit: 100 });
      if (r.total > 0) return res.json(r);
    }
    const { apiBase } = maidong.getConfig();
    if (apiBase) return res.json(await maidong.apiSearch(q, page));
    // 未配 API 音源时退化为曲库内搜索
    res.json(await maidong.boardSongs('__all__', 1, 100, q));
  } catch (e) { res.status(502).json({ error: '麦动搜索失败: ' + e.message }); }
});
// 点唱：本地有直接入队；没有则下载入库再入队。body: {songmid,name,singer,url,pic,format,src}
// src='muse'：songmid 是麦动歌曲编号，服务端点歌时经 ktv_api.js 实时换签名直链下载
app.post('/api/md/queue', async (req, res) => {
  const { songmid, name, singer, url, pic, format, src } = req.body || {};
  if (!songmid || !name) return res.status(400).json({ error: '缺少 songmid/name' });
  let song = lxmusic.findLocalSong(name, singer);
  let downloaded = false;
  if (!song) {
    try {
      song = await maidong.downloadMd({ songmid, name, singer, url, pic: pic || null, format: format === 'mv' ? 'mv' : 'mp3', src: src === 'muse' ? 'muse' : '' });
      downloaded = true;
    } catch (e) {
      if (e.message === 'MV_DIR_UNAVAILABLE') return res.status(503).json({ error: '曲库目录不可访问' });
      return res.status(502).json({ error: '下载失败: ' + e.message });
    }
  }
  const q = db.prepare('INSERT INTO queue (song_id,nickname) VALUES (?,?)').run(song.id, '网络点唱');
  db.prepare('UPDATE songs SET play_count=play_count+1 WHERE id=?').run(song.id);
  startPlayingIfIdle(q.lastInsertRowid);
  broadcastQueue();
  res.json({ ok: true, downloaded, song });
});

// ---------- 全曲库批量下载（曲库管理页右上角，见 server/bulk.js） ----------
// 麦动 muse.db 源整库下载到 MV_DIR（按歌手分目录 .ts），最常唱优先；
// 导入目录/启动/停止属于重操作，要求管理员登录；进度查询开放给页面轮询。
const bulk = new (require('./bulk').BulkDownloader)();
app.get('/api/bulk/status', (req, res) => res.json(bulk.status()));
app.post('/api/bulk/import', requireAdminAuth, async (req, res) => {
  try { res.json({ ok: true, total: await bulk.importCatalog() }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/bulk/start', requireAdminAuth, (req, res) => {
  const r = bulk.start(req.body || {});
  res.status(r.ok ? 200 : 400).json(r);
});
app.post('/api/bulk/stop', requireAdminAuth, (req, res) => res.json(bulk.stop()));
// 清空反盗版跳过清单（bulk-skipped.txt 一并删除）
app.post('/api/bulk/clear-skipped', requireAdminAuth, (req, res) => res.json(bulk.clearSkipped()));
// 读取跳过清单文件内容（填入「按清单下载」输入框）
app.get('/api/bulk/skipped-text', requireAdminAuth, (req, res) => res.json(bulk.skippedText()));

// ---------- 歌手批量下载（学习 lx-music-desktop 歌手批量下载，见 server/singer-batch.js） ----------
// 四平台（kw/wy/tx/kg）按歌手搜索收集歌曲（过滤词+时长区间清洗）→ 逐首下载入库，
// 单首下载失败自动换平台找同名歌续下（换源链见 lxmusic.resolveMusicUrlWithFallback）。
const singerBatch = require('./singer-batch');
app.get('/api/singer-batch/status', (req, res) => res.json(singerBatch.status()));
app.get('/api/singer-batch/defaults', (req, res) => res.json({ filterWords: singerBatch.DEFAULT_FILTER_WORDS }));
app.post('/api/singer-batch/start', requireAdminAuth, async (req, res) => {
  const r = await singerBatch.start(req.body || {});
  res.status(r.ok ? 200 : 400).json(r);
});
// 暂停：断开在途请求 + 保存断点（当前这首会在继续时重下），可再「继续下载」接着下
app.post('/api/singer-batch/pause', requireAdminAuth, (req, res) => {
  const r = singerBatch.pause();
  res.status(r.ok ? 200 : 400).json(r);
});
// 继续：内存里挂着的任务直接放行；服务重启/意外中断留下的快照则冷启动续传
app.post('/api/singer-batch/resume', requireAdminAuth, (req, res) => {
  const r = singerBatch.resume();
  res.status(r.ok ? 200 : 400).json(r);
});
// 停止才是真正放弃（连同断点快照一起清掉）
app.post('/api/singer-batch/stop', requireAdminAuth, (req, res) => res.json(singerBatch.stop()));

// ---------- 爱唱榜 (按播放次数) ----------
app.get('/api/charts', (req, res) => {
  const rows = db.prepare('SELECT * FROM songs WHERE play_count > 0 ORDER BY play_count DESC LIMIT 50').all();
  res.json(rows);
});

// ---------- 收藏 ----------
app.get('/api/favorites', (req, res) => {
  const device = req.query.device || 'default';
  const rows = db.prepare(`
    SELECT s.* FROM songs s
    JOIN favorites f ON s.id = f.song_id
    WHERE f.device_id = ? ORDER BY f.created_at DESC
  `).all(device);
  res.json(rows);
});

app.post('/api/favorites/:song_id', (req, res) => {
  const device = req.body.device || 'default';
  db.prepare('INSERT OR IGNORE INTO favorites (song_id, device_id) VALUES (?,?)').run(req.params.song_id, device);
  res.json({ ok: true });
});

app.delete('/api/favorites/:song_id', (req, res) => {
  const device = req.query.device || 'default';
  db.prepare('DELETE FROM favorites WHERE song_id = ? AND device_id = ?').run(req.params.song_id, device);
  res.json({ ok: true });
});

// ---------- 歌曲管理 (Admin) ----------
// 只有这两个真正的"增删改"动作要求登录；/api/scan、/api/songs 等电视端、
// 手机点歌页面共用的接口保持开放，见文件顶部「曲库管理管理员登录」的说明。
app.delete('/api/songs/:id', requireAdminAuth, (req, res) => {
  db.prepare('DELETE FROM songs WHERE id = ?').run(req.params.id);
  removeHLS(req.params.id);
  res.json({ ok: true });
});

app.put('/api/songs/:id', requireAdminAuth, (req, res) => {
  const { title, artist } = req.body;
  db.prepare('UPDATE songs SET title=?, artist=? WHERE id=?').run(title, artist, req.params.id);
  // 歌名/歌手改动后重算拼音与语言，否则点歌面板的拼音首字母搜索、语言筛选会漏掉这首歌。
  if (title || artist) {
    db.prepare('UPDATE songs SET pinyin=?, pinyin_initial=?, lang=? WHERE id=?')
      .run(toPinyin(title || ''), toPinyinInitial(title || ''), detectLang(title, artist), req.params.id);
  }
  res.json({ ok: true });
});

// ---------- 扫描 / 统计 ----------

// ---------- 全库歌词补全（admin） ----------
// 给库里没有歌词的歌逐首补歌词：kw 搜索「标题 歌手」→ 同时下载两个版本——
// `歌名.lrc`（逐行版）+ `歌名.lrcx`（逐字版，酷我 newlyric lrcx 接口，拿不到就只有 .lrc），
// 写到歌曲同目录，更新 lyrics_path / lrc_karaoke。播放时 findLyricsPath 优先 .lrcx。
// 节流与歌手批量一致（kwSearch 内部已有），整体串行跑，可随时停止。
let lrcBackfill = { running: false, stopFlag: false, total: 0, done: 0, ok: 0, okLrcx: 0, fail: 0, noMatch: 0, current: '' };
app.post('/api/lyrics/backfill/start', requireAdminAuth, async (req, res) => {
  if (lrcBackfill.running) return res.status(409).json({ error: '歌词补全已在进行中' });
  const rows = db.prepare('SELECT id, title, artist, filepath, filename FROM songs WHERE lyrics_path IS NULL').all();
  if (!rows.length) return res.json({ ok: true, total: 0 });
  lrcBackfill = { running: true, stopFlag: false, total: rows.length, done: 0, ok: 0, okLrcx: 0, fail: 0, noMatch: 0, current: '' };
  res.json({ ok: true, total: rows.length });
  (async () => {
    const { kwSearch, kwLyric, kwLyricLrcx } = lxmusic;
    const norm = t => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    for (const row of rows) {
      if (lrcBackfill.stopFlag) break;
      lrcBackfill.current = `${row.artist || ''} - ${row.title}`.trim();
      try {
        // 搜索：标题 + 首位歌手
        const q = `${row.title} ${String(row.artist || '').split(/[、;；|/]/)[0] || ''}`.trim();
        const r = await kwSearch(q, 1, 10);
        const nt = norm(row.title);
        const hit = (r.list || []).find(s => {
          return norm(s.name) === nt || norm(s.name).includes(nt) || nt.includes(norm(s.name));
        }) || (r.list || [])[0];
        if (!hit || !hit.songmid) { lrcBackfill.noMatch++; continue; }
        const dir = path.dirname(row.filepath);
        const base = path.basename(row.filename, path.extname(row.filename));
        let wroteLrcx = false, wroteLrc = false;
        try {
          const enh = await kwLyricLrcx(hit.songmid, null);
          fs.writeFileSync(path.join(dir, `${base}.lrcx`), enh, 'utf8'); wroteLrcx = true;
        } catch (e) {}
        try {
          const plain = await kwLyric(hit.songmid, null);
          fs.writeFileSync(path.join(dir, `${base}.lrc`), plain, 'utf8'); wroteLrc = true;
        } catch (e) {}
        if (!wroteLrcx && !wroteLrc) { lrcBackfill.fail++; continue; }
        // 歌词路径与逐字标记：findLyricsPath 同口径（.lrcx 优先）
        const lrcPath = wroteLrcx ? path.join(dir, `${base}.lrcx`) : path.join(dir, `${base}.lrc`);
        db.prepare('UPDATE songs SET lyrics_path=?, lrc_karaoke=? WHERE id=?').run(lrcPath, wroteLrcx ? 1 : 0, row.id);
        lrcBackfill.ok++;
        if (wroteLrcx) lrcBackfill.okLrcx++;
      } catch (e) {
        lrcBackfill.fail++;
        console.error('歌词补全失败(' + lrcBackfill.current + '):', e.message);
      } finally {
        lrcBackfill.done++;
        await new Promise(r => setTimeout(r, 400 + Math.random() * 400)); // 节流，防限流
      }
    }
    lrcBackfill.running = false;
    lrcBackfill.current = '';
    console.log(`[歌词补全] 结束：${lrcBackfill.ok}/${lrcBackfill.total} 成功（逐字 ${lrcBackfill.okLrcx}），无匹配 ${lrcBackfill.noMatch}，失败 ${lrcBackfill.fail}${lrcBackfill.stopFlag ? '（已停止）' : ''}`);
  })().catch(e => { lrcBackfill.running = false; console.error('[歌词补全] 异常终止:', e); });
});
app.get('/api/lyrics/backfill/status', (req, res) => {
  const { running, stopFlag, total, done, ok, okLrcx, fail, noMatch, current } = lrcBackfill;
  res.json({ running, stopping: stopFlag && running, total, done, ok, okLrcx, fail, noMatch, current });
});
app.post('/api/lyrics/backfill/stop', requireAdminAuth, (req, res) => {
  lrcBackfill.stopFlag = true;
  res.json({ ok: true });
});

app.post('/api/scan', async (req, res) => {
  // 已在扫就别再起一轮：全量扫描是重活，并发只会互相拖慢、CPU 翻倍
  if (getScanState().scanning) {
    return res.status(409).json({ ok: false, error: 'IN_PROGRESS', message: '已有扫描正在后台进行中，请等它跑完再试' });
  }
  try { res.json({ ok: true, ...(await scanLibrary()) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 轻量扫描状态：供前端在扫描期间轮询进度（不要用 /api/diag 轮询——它为了
// 采样 CPU 会阻塞数百毫秒，代价比这个接口大得多）
app.get('/api/scan/status', (req, res) => res.json(getScanState()));

app.get('/api/stats', (req, res) => {
  const songCount  = db.prepare('SELECT COUNT(*) c FROM songs').get().c;
  const queueCount = db.prepare("SELECT COUNT(*) c FROM queue WHERE status!='done'").get().c;
  res.json({ songCount, queueCount, mvDir: dlcfg.MV_DIR, mp3Dir: dlcfg.getMp3Dir() });
});

// ---------- 点歌队列 ----------
function getQueueWithSongs() {
  return db.prepare(`
    SELECT q.id as queue_id, q.nickname, q.is_top, q.status, q.created_at,
           s.id as song_id, s.title, s.artist, s.filename, s.cover, s.duration,
           s.audio_tracks, s.media_type, s.lyrics_path
    FROM queue q JOIN songs s ON q.song_id = s.id
    WHERE q.status != 'done'
    -- 排序修复：置顶只能把一首歌挪到"正在播放"之后的第一位（即整个队列的第二位），
    -- 不能盖过正在播放的那首。旧排序 'is_top DESC, id ASC' 只按置顶标记排，
    -- 完全没考虑播放状态——如果正在播放的这一行本身 is_top=0，任何一首刚被置顶
    -- 的候选歌都会因为 is_top=1 排到它前面，等于把"正在播放"从队首挤下去，
    -- 界面上会显示成"置顶歌曲排在正在播放的歌前面"，观感和语义都不对。
    -- 现在最优先按 status='playing' 排（true=1 排最前），保证正在播放的
    -- 那一行永远占据第一位，其次才按 is_top、再按 id 排——这样置顶操作实际能
    -- 达到的最靠前位置，就是紧跟在正在播放歌曲后面的"第二位"，不会再越过它。
    ORDER BY (q.status='playing') DESC, q.is_top DESC, q.id ASC
  `).all();
}

// 自动播放队列条目的固定昵称（TV 端首页自动播放功能，见 web/tv 的 maybeAutoPlay）
const AUTO_NICK = '自动播放';
// 「首页无播放列表时按切歌」随机点的歌（见 /api/queue/next）。与自动播放同为
// "非用户点歌"的占位曲目，有人手动点歌时可以直接让位。
const RANDOM_NICK = '随机播放';
const isAutoNick = (n) => n === AUTO_NICK || n === RANDOM_NICK;

// 从全曲库随机取一首（避开最近 history 里播过的，避免"按切歌老是同一首"）。
// 用 COUNT + OFFSET 而不是 ORDER BY RANDOM()：内置 muse.db 曲库可达几十万首，
// RANDOM() 会整表扫描排序，这里走主键索引取值，代价恒定。
function pickRandomSong() {
  let total = 0;
  try { total = db.prepare('SELECT COUNT(*) AS c FROM songs').get().c || 0; } catch (e) { return null; }
  if (!total) return null;
  let recent = [];
  try { recent = db.prepare('SELECT song_id FROM history ORDER BY id DESC LIMIT 20').all().map(r => r.song_id); } catch (e) {}
  let fallback = null;
  for (let i = 0; i < 8; i++) {
    const offset = Math.floor(Math.random() * total);
    const song = db.prepare('SELECT * FROM songs LIMIT 1 OFFSET ?').get(offset);
    if (!song) continue;
    if (!fallback) fallback = song;
    if (!recent.includes(song.id)) return song;
  }
  return fallback;
}
// 点歌入队后的开播判定：
//  - 队列空闲（无正在播放）→ 新歌直接开播（原有行为）；
//  - 正在播的是自动播放的歌 → 手动点歌打断自动播放：当前自动歌标记结束，
//    新点的歌立即开播（需求：自动播放持续到有人手动点歌，且自动切到手动点的歌）。
//  - 正在播的是手动点的歌 → 正常排队等待，不打断。
function startPlayingIfIdle(queueId) {
  const playing = db.prepare("SELECT * FROM queue WHERE status='playing'").get();
  if (playing && !isAutoNick(playing.nickname)) return;
  if (playing) db.prepare("UPDATE queue SET status='done' WHERE id=?").run(playing.id);
  db.prepare("UPDATE queue SET status='playing' WHERE id=?").run(queueId);
}

app.get('/api/queue', (req, res) => res.json(getQueueWithSongs()));

app.post('/api/queue', (req, res) => {
  const { song_id, nickname } = req.body;
  const song = db.prepare('SELECT * FROM songs WHERE id=?').get(song_id);
  if (!song) return res.status(404).json({ error: '歌曲不存在' });
  const info = db.prepare('INSERT INTO queue (song_id,nickname) VALUES (?,?)').run(song_id, nickname || '匿名歌手');
  db.prepare('UPDATE songs SET play_count=play_count+1 WHERE id=?').run(song_id);
  startPlayingIfIdle(info.lastInsertRowid);
  broadcastQueue();
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.post('/api/queue/:id/top', (req, res) => {
  // Bug修复：原来只把这一条设成 is_top=1，从不清除其它行的置顶标记。连续给
  // 不同歌曲点"置顶"后，会有多条 is_top=1 的记录同时存在，这些记录之间只能
  // 按 id ASC 排序——最新点的这首排在更早被置顶的那些后面，界面上看起来就是
  // "点了置顶但完全没反应/挪不动"，也就是卡住无法置顶。
  // 修复为：先把所有非播放中的置顶标记清空，再把当前这条设为置顶，保证同一
  // 时刻只有一首歌处于"置顶"状态，每次点击都能确实把这首歌顶到最前面
  // （紧跟在正在播放的歌曲之后）。
  const tx = db.transaction((id) => {
    db.prepare("UPDATE queue SET is_top=0 WHERE status!='playing'").run();
    db.prepare('UPDATE queue SET is_top=1 WHERE id=?').run(id);
  });
  tx(req.params.id);
  broadcastQueue(); res.json({ ok: true });
});

app.delete('/api/queue/:id', (req, res) => {
  db.prepare('DELETE FROM queue WHERE id=?').run(req.params.id);
  broadcastQueue(); res.json({ ok: true });
});

app.post('/api/queue/next', (req, res) => {
  const cur = db.prepare("SELECT * FROM queue WHERE status='playing' ORDER BY id LIMIT 1").get();
  if (cur) {
    db.prepare("UPDATE queue SET status='done' WHERE id=?").run(cur.id);
    db.prepare('INSERT INTO history (song_id,nickname) VALUES (?,?)').run(cur.song_id, cur.nickname);
  }
  const nxt = db.prepare("SELECT * FROM queue WHERE status='waiting' ORDER BY is_top DESC, id ASC LIMIT 1").get();
  if (nxt) {
    db.prepare("UPDATE queue SET status='playing' WHERE id=?").run(nxt.id);
    broadcastQueue();
    return res.json({ ok: true });
  }
  // 队列里既没有正在播放的、也没有等候的（首页"无播放列表"）→ 切歌改为随机播一首。
  // 旧行为是原地不动：用户按了切歌像没反应（既没有歌可切，也没有提示）。
  // 注意只在"队列完全为空"时随机：随机点歌不算用户点的歌，跑完这一首若队列仍空，
  // 就回到空闲（要不要继续连着随机播，由「首页自动播放」开关决定）。
  if (!cur) {
    const song = pickRandomSong();
    if (song) {
      // 不计 play_count：随机播放不是"点唱"，不应把热门榜（按 play_count 排序）搅乱
      const info = db.prepare('INSERT INTO queue (song_id,nickname,status) VALUES (?,?,?)')
        .run(song.id, RANDOM_NICK, 'playing');
      broadcastQueue();
      log.info('QUEUE', `首页无播放列表，切歌随机播放《${song.title}》`);
      return res.json({ ok: true, random: true, queue_id: info.lastInsertRowid, song_id: song.id, title: song.title, artist: song.artist || '' });
    }
    broadcastQueue();
    return res.json({ ok: true, empty: true });   // 曲库为空，没得随机
  }
  broadcastQueue();
  res.json({ ok: true });
});

// ---------- WebSocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ---------- HTTPS（自签证书） ----------
// 浏览器安全策略：麦克风（getUserMedia，唱歌评分用）只在 HTTPS 或 localhost 下开放，
// 局域网 HTTP 访问拿不到麦克风。这里用自签证书在同一 app 上再起一个 HTTPS 端口，
// 证书持久化在 DATA_DIR 下，重启不换。App 端信任自签证书；浏览器访问会弹证书
// 警告，点「高级→继续访问」即可。
const https = require('https');
const selfsigned = require('selfsigned');
const HTTPS_PORT = process.env.HTTPS_PORT || 8443;
const CERT_DIR = path.join(process.env.DATA_DIR || '/data', 'https');
const wssAll = [wss]; // 所有 WebSocket 实例（http + https），广播用

function broadcastQueue() {
  const payload = JSON.stringify({ type: 'queue', data: getQueueWithSongs() });
  wssAll.forEach(w => w.clients.forEach(c => { if (c.readyState === 1) c.send(payload); }));
}

// ---------- 客户端在线检测 / 无人在线时停止后台播放 ----------
// 背景：KTV 的"播放"由客户端（电视端 / 安卓端 WebView 加载 web/tv/index.html，
// 以及手机遥控页 web/mobile）驱动——服务端负责的是把这首歌转成 HLS 分片。
// 这份转码是"纯为客户端服务"的后台任务，而且一旦开始就会把整首歌转完。于是
// 会出现：看电视的人早把电视/手机全关掉了，服务端还在后台吭哧吭哧转码，等于
// 白白占着一个 CPU 核（NAS 上就是常驻 10%~20%）。这里补上"没人看就停"：
//
//   1) 在线数：/ws 的 WebSocket 连接数就是"有多少个客户端开着"（电视端、安卓
//      端、手机遥控页都连它，断线会自动重连）。播放器拉取 m3u8/分片(/hls/*)
//      与直传流(/stream/*)的 HTTP 请求也算"活跃"，避免误判。
//   2) 空闲停止：最后一个客户端断开后开始计时，宽限期（默认 60 秒，可用环境
//      变量 IDLE_STOP_MS 调整）内没有任何客户端重连、也没有播放请求，就：
//        - 立即 kill 掉所有在途的 ffmpeg 转码进程（hlsgen.cancelAllActive）；
//        - 把队列里 status='playing' 的那条复位为 'waiting'，即"停止播放"——
//          客户端下次连上来时不会莫名其妙自动接着播刚才那首，而是停在待播队列；
//        - 广播一次队列，让可能刚好又在线的客户端刷新界面。
//      客户端一回来（重连 / 请求播放）就取消这次倒计时，正常的短暂切换页面、
//      网络抖动（电视端 2 秒重连一次）都不会触发误停。
const IDLE_STOP_MS = Math.max(5000, Number(process.env.IDLE_STOP_MS) || 60000);
// 停止时默认把"正在播放"那条复位为"等待播放"（即真的把播放停下来，客户端下次
// 连上不会突然自己接着播）。若希望保留"刚才是这首歌"，设 IDLE_STOP_KEEP_PLAYING=1。
const IDLE_STOP_KEEP_PLAYING = process.env.IDLE_STOP_KEEP_PLAYING === '1';
let idleTimer = null;
let lastActivityAt = Date.now();

function onlineClientCount() {
  let n = 0;
  wssAll.forEach(w => w.clients.forEach(c => { if (c.readyState === 1) n++; }));
  return n;
}

function cancelIdleStop() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

function scheduleIdleStop() {
  if (idleTimer) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (onlineClientCount() > 0) return; // 宽限期内又有客户端连上来了
    if (Date.now() - lastActivityAt < IDLE_STOP_MS) return scheduleIdleStop(); // 期间还有播放请求，再等一轮
    stopServerPlayback('电视端/安卓端已全部离线');
  }, IDLE_STOP_MS);
  if (idleTimer.unref) idleTimer.unref();
}

// 客户端来了/还在用：刷新活跃时间，并撤销待执行的"空闲停止"。
function markPlayerActivity() {
  lastActivityAt = Date.now();
  if (onlineClientCount() > 0) cancelIdleStop();
  else scheduleIdleStop();
}

// "停止服务端播放"：中断在途转码 + 复位队列播放状态。
function stopServerPlayback(reason) {
  const canceled = cancelAllActive();
  let reset = 0;
  if (!IDLE_STOP_KEEP_PLAYING) {
    try {
      const info = db.prepare("UPDATE queue SET status='waiting' WHERE status='playing'").run();
      reset = info.changes || 0;
      if (reset) broadcastQueue();
    } catch (e) {
      log.warn('PLAYER', '队列播放状态复位失败: ' + e.message);
    }
  }
  log.info('PLAYER', `停止服务端播放（${reason}）：中断在途转码 ${canceled.length} 首、复位队列播放状态 ${reset} 条`);
  return { canceled, reset };
}

function onWsConnection(ws) {
  lastActivityAt = Date.now();
  cancelIdleStop(); // 有客户端在线，不进入空闲停止
  log.info('PLAYER', `客户端已连接（当前在线 ${onlineClientCount()}）`);
  ws.send(JSON.stringify({ type: 'queue', data: getQueueWithSongs() }));
  ws.on('message', msg => {
    lastActivityAt = Date.now();
    try {
      const p = JSON.parse(msg);
      if (p.type === 'control')
        wssAll.forEach(w => w.clients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify(p)); }));
    } catch(e) {}
  });
  ws.on('close', () => {
    const n = onlineClientCount();
    log.info('PLAYER', `客户端已断开（当前在线 ${n}）`);
    // 最后一个客户端也走了 → 启动空闲倒计时；宽限期内没人回来就停止后台播放。
    if (n === 0) scheduleIdleStop();
  });
  ws.on('error', () => {});
}

// 供前端/运维查询：当前在线客户端数、在途转码数、空闲停止阈值
app.get('/api/player/status', (req, res) => {
  res.json({
    clients: onlineClientCount(),
    transcoding: activeTranscodes(),
    idleStopMs: IDLE_STOP_MS,
    idlePending: !!idleTimer,
    lastActivityAt,
  });
});

// 手动"立即停止后台播放/转码"（不影响客户端本身，只是让服务端停止为其转码）
app.post('/api/player/stop', (req, res) => {
  cancelIdleStop();
  const r = stopServerPlayback('手动请求');
  res.json({ ok: true, ...r });
});

// ---------- 版本：确认服务器上跑的是不是最新版 ----------
// 镜像 tag 永远是 latest，看不出是哪一次构建；commit sha + 构建时间才能和
// GitHub 上的提交一一对上。不需要鉴权（前台 TV/安卓端也要用它显示版本）。
app.get('/api/version', (req, res) => {
  res.json(appVersion.getVersion());
});

// ---------- 自诊断：CPU 到底被谁占了 ----------
// 容器镜像里没有 top/ps（装 procps 又要加体积），所以这里用 /proc 自己采样，
// 让 `curl http://NAS:8080/api/diag` 一句话回答：
//   - 容器内各进程的 CPU 占用（% of 单核）+ 占整机 CPU 的百分比；
//   - 每个 ffmpeg 的完整命令行与存活时长，以及它有没有被登记（registered）；
//   - 是否正在全量扫描曲库（scan.scanning / runningSec）；
//   - 在线客户端数、在途转码数、等分片的请求数。
// 这样"有东西一直占 CPU"就能直接看出是 node 在建路径、是 ffmpeg 在转码、
// 还是有个失控的 ffmpeg（未登记 → 下面的巡检会收拾掉）。
// 出口诊断：排查"音源中转按 IP/指纹风控"时一句话回答——服务器的真实公网出口
// 是什么（局域网设备以为的出口和外部实际看到的不一定一致：多网卡、级联路由、
// IPv6 优先都可能造成两台机器"同一个局域网"却"不同公网出口"）、DNS 把中转
// 域名解析成了什么地址族。ipify4=纯 IPv4 回显，ipify64=双栈优先 IPv6 回显。
app.get('/api/diag/egress', async (req, res) => {
  const out = { node: process.version };
  try { out.ipify4 = await fetch('https://api.ipify.org').then(r => r.text()); }
  catch (e) { out.ipify4 = '失败: ' + e.message; }
  try { out.ipify64 = await fetch('https://api64.ipify.org').then(r => r.text()); }
  catch (e) { out.ipify64 = '失败: ' + e.message; }
  try {
    const dns = require('dns').promises;
    out.relayDNS = await dns.lookup('88.lxmusic.xn--fiqs8s', { all: true, verbatim: true });
  } catch (e) { out.relayDNS = '失败: ' + e.message; }
  res.json(out);
});

// 换链/下载追踪：最近 60 条 musicUrl 解析与下载结果（URL 脱敏、嗅探结果、
// 响应头、试听片段拒收记录）。用来对比 PC 端 lx-music 与服务端拿到的链接差异，
// 定位"中转按客户端指纹降级下发防盗版片段"的问题。?clear=1 清空。
app.get('/api/diag/lx', (req, res) => {
  if (req.query.clear != null) { lxmusic.clearLxTrace(); }
  res.json(lxmusic.getLxTrace());
});

app.get('/api/diag', async (req, res) => {
  let cpu;
  try { cpu = await procmon.sampleCpu({ sampleMs: Math.min(3000, Number(req.query.ms) || 500), top: 15 }); }
  catch (e) { cpu = { error: e.message }; }
  const registered = new Set([...runningPids(), ...liveStreamProcs]);
  const mediaProcs = procmon.listMediaProcs().map(p => ({ ...p, registered: registered.has(p.pid) }));
  let queue = [];
  try { queue = db.prepare('SELECT status, COUNT(*) AS c FROM queue GROUP BY status').all(); } catch (e) {}

  // 一句话结论：省得用户对着 JSON 猜"到底是不是 KTV 在占 CPU"。
  // 关键在于把"本容器用了几个核"和"宿主机整体负载"摆在一起比：宿主机的
  // /proc/loadavg 不受 PID 命名空间隔离，容器里读到的就是 NAS 整机的负载。
  const scan = getScanState();
  const hints = [];
  if (scan.scanning) {
    hints.push(`正在全量扫描曲库（已 ${scan.runningSec}s，进度 ${scan.processed}/${scan.files}）：每个文件都要起一次 ffprobe，属于容器启动/重建后的一次性开销，跑完会自行回落；进度数字在涨说明没有卡死。`);
  }
  if (mediaProcs.length) {
    const orphan = mediaProcs.filter(p => !p.registered);
    hints.push(orphan.length
      ? `发现 ${orphan.length} 个未登记的转码进程（疑似失控 ffmpeg），孤儿巡检会自动清理。`
      : `有 ${mediaProcs.length} 个已登记的转码进程在跑（正在播放/直传），属正常现象。`);
  }
  if (cpu && cpu.available) {
    const cc = cpu.containerCores || 0;
    const l1 = cpu.host ? cpu.host.load1 : 0;
    if (l1 >= 0.2 && cc < 0.1) {
      hints.push(`宿主机近 1 分钟负载约 ${l1} 个核，而本容器仅占 ${cc} 个核 —— 占用来自本容器之外（NAS 自身服务/媒体索引/缩略图，或其它容器）。`);
    } else if (cc >= 0.5) {
      hints.push(`本容器自身占用约 ${cc} 个核${scan.scanning ? '，与"正在扫描曲库"相符' : ''}。`);
    } else {
      hints.push(`本容器近似空闲（约 ${cc} 个核，口径 ${cpu.method}）。`);
    }
  }
  res.json({
    version: appVersion.getVersion(),
    uptimeSec: Math.round(process.uptime()),
    rssMB: Math.round(process.memoryUsage().rss / 1048576),
    pid: process.pid,
    clients: onlineClientCount(),
    transcoding: activeTranscodes(),
    pendingWaits: pendingWaitCount(),
    idleStop: { ms: IDLE_STOP_MS, pending: !!idleTimer, keepPlaying: IDLE_STOP_KEEP_PLAYING },
    scan,
    hint: hints,
    procMonitor: procmon.available ? 'linux(/proc)' : 'unavailable(非 Linux)',
    cpu,
    mediaProcs,
    queue,
  });
});

// ---------- 孤儿 ffmpeg 巡检 ----------
// 凡是"命令行指向 HLS 转码目录、却不在登记表里"的 ffmpeg/ffprobe，都说明有
// 一次转码脱离了控制（历史版本漏杀、异常路径等）。这种进程会把整首歌转完才
// 退，正是 NAS 上"什么都没做 CPU 也一直占着"的典型来源。每 5 分钟扫一次，
// 只收拾同时满足三个条件的：命令行里带 HLS 目录名、存活超过 5 分钟、未登记
// ——这样下载转码/封面提取/直传流等合法 ffmpeg 不会被误杀。
const ORPHAN_SWEEP_MS = Number(process.env.ORPHAN_SWEEP_MS) || 5 * 60 * 1000;
const ORPHAN_MIN_AGE_SEC = Number(process.env.ORPHAN_MIN_AGE_SEC) || 300;
function sweepOrphanFfmpeg() {
  if (!procmon.available) return { checked: 0, killed: 0 };
  const registered = new Set([...runningPids(), ...liveStreamProcs]);
  const dirTag = path.basename(HLS_DIR);
  let checked = 0, killed = 0;
  for (const p of procmon.listMediaProcs()) {
    checked++;
    if (registered.has(p.pid)) continue;
    if (p.ageSec >= 0 && p.ageSec < ORPHAN_MIN_AGE_SEC) continue;
    if (!(p.cmdline.includes(HLS_DIR) || p.cmdline.includes(dirTag))) continue;
    log.warn('DIAG', `发现失控的 HLS 转码进程（未登记，已存活 ${p.ageSec}s，pid=${p.pid}），强制结束: ${p.cmdline.slice(0, 160)}`);
    if (procmon.killProc(p.pid)) killed++;
  }
  if (killed) log.info('DIAG', `孤儿 ffmpeg 巡检：检查 ${checked} 个媒体进程，清理 ${killed} 个`);
  return { checked, killed };
}
if (procmon.available) {
  const t = setInterval(sweepOrphanFfmpeg, ORPHAN_SWEEP_MS);
  if (t.unref) t.unref();
  log.info('DIAG', `孤儿 ffmpeg 巡检已启用：每 ${Math.round(ORPHAN_SWEEP_MS / 60000)} 分钟检查一次（存活不足 ${ORPHAN_MIN_AGE_SEC}s 的不动）`);
}
wss.on('connection', onWsConnection);

try {
  let keyPem, certPem;
  try {
    keyPem = fs.readFileSync(path.join(CERT_DIR, 'key.pem'));
    certPem = fs.readFileSync(path.join(CERT_DIR, 'cert.pem'));
  } catch (e) {
    fs.mkdirSync(CERT_DIR, { recursive: true });
    const pems = selfsigned.generate([{ name: 'commonName', value: 'junyao-ktv.local' }], {
      days: 3650,
      algorithm: 'sha256',
      extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] }],
    });
    fs.writeFileSync(path.join(CERT_DIR, 'key.pem'), pems.private);
    fs.writeFileSync(path.join(CERT_DIR, 'cert.pem'), pems.cert);
    keyPem = pems.private; certPem = pems.cert;
  }
  const httpsServer = https.createServer({ key: keyPem, cert: certPem }, app);
  const wssSecure = new WebSocketServer({ server: httpsServer, path: '/ws' });
  wssSecure.on('connection', onWsConnection);
  wssAll.push(wssSecure);
  httpsServer.listen(HTTPS_PORT, () => {
    log.info('SERVER', `KTV HTTPS 已启动: https://0.0.0.0:${HTTPS_PORT}（自签证书，麦克风/评分用）`);
  });
} catch (e) {
  log.error('SERVER', 'HTTPS 启动失败（网页评分功能将不可用，HTTP 不受影响）: ' + e.message);
}

// ---------- 统一错误响应（必须注册在所有路由之后） ----------
// 兜底把中间件/路由抛出的错误转成 JSON。Express 默认的错误页是 HTML，前端
// fetch(...).json() 拿到 "<!DOCTYPE html>" 会抛
//   Unexpected token '<', "<!DOCTYPE "... is not valid JSON
// 让人完全看不懂。最典型的就是"导入一份大歌手名单 → 启动失败"：其实是请求体
// 超过 JSON_BODY_LIMIT 触发了 413，但报错信息完全指错方向。
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const type = err && err.type;
  if (type === 'entity.too.large') {
    log.warn('HTTP', `${req.method} ${req.originalUrl} 请求体超过 ${JSON_BODY_LIMIT}，已拒绝`);
    return res.status(413).json({
      error: `请求体过大（上限 ${JSON_BODY_LIMIT}）：名单太长了一次提交不下，请拆成几批分别导入`,
    });
  }
  if (type === 'entity.parse.failed' || (err instanceof SyntaxError && err.body !== undefined)) {
    return res.status(400).json({ error: '请求体不是合法 JSON：' + String((err && err.message) || '').slice(0, 120) });
  }
  log.error('HTTP', `${req.method} ${req.originalUrl} 处理出错：${(err && err.stack) || err}`);
  res.status((err && err.status) || 500).json({
    error: String((err && err.message) || '服务端内部错误').slice(0, 200),
  });
});

server.listen(PORT, () => {
  log.info('SERVER', `KTV 服务已启动: http://0.0.0.0:${PORT}`);
  // 版本戳放启动日志里：`docker logs` 第一屏就能看到，不用进管理后台，
  // 也方便直接和 GitHub 上最新提交比对。
  const v = appVersion.getVersion();
  log.info('VERSION', `服务端版本 ${v.label}${v.buildTimeLocal ? `（构建于 ${v.buildTimeLocal}）` : ''}`
    + (v.commitUrl ? `　提交: ${v.commitUrl}` : ''));
  if (v.source !== 'ci') {
    log.info('VERSION', `本进程不是从 CI 镜像启动的（${v.source}），版本号取自源码，`
      + '想要权威的构建版本请部署 CI 镜像。');
  }
  log.info('PLAYER', `无人在线自动停止后台播放已启用：最后一台电视端/安卓端断开后 ${Math.round(IDLE_STOP_MS / 1000)} 秒停止后台转码`
    + (IDLE_STOP_KEEP_PLAYING ? '（保留队列播放状态）' : '，并把队列播放状态复位为待播'));
});

// Bug修复：原来这行代码写在 server.listen 之前、且同步调用 scanLibrary()，
// 等于让整个 HTTP 服务能不能对外提供响应，都卡在"这一轮曲库扫描有没有跑完"
// 这一点上——MV 目录下堆的曲目越多（尤其首次安装、批量导入曲库的场景），
// 主界面/点歌页面能打开、能看到任何歌曲列表的时间就越晚，用户看到的就是
// 长时间白屏/连不上。
// 现在把启动扫描挪到 server.listen 之后再异步触发：端口立刻开始监听，扫描
// 转为后台任务执行；配合 scanner.js 里改成的"逐个文件探测、逐个立即入库"，
// 这时候查询 /api/songs 看到的列表会随扫描推进逐步变长，不需要等这一整轮
// 扫描全部跑完才第一次看到歌曲。
// 启动是否自动全量扫描曲库：默认**关闭**，改由用户在「设置 → 重新扫描曲库」
// （电视端 / admin）或 POST /api/scan 手动触发。
// 为什么默认关：全量扫描要递归遍历 /mv + /mp3，并对每个文件起一次 ffprobe，
// 大曲库要跑很久且期间一直吃 CPU——这正是"容器刚创建、什么都没做 CPU 就上去了"
// 的来源之一。而曲库里已有的歌本来就躺在 songs 表里（镜像还内置 muse.db），
// 不扫描也照常显示、点唱；只有"手工往 mv/、mp3/ 里丢进新文件却没入库"时
// 才需要扫一次。
// 注意：下载入库走的是单文件 scanFile（lxmusic/maidong），与此无关——下载
// 完成的歌会立即出现在曲库，不依赖启动扫描。
// 想恢复开机自动扫描：设环境变量 SCAN_ON_START=1。
const SCAN_ON_START = process.env.SCAN_ON_START === '1';
if (SCAN_ON_START) {
  scanLibrary().catch(e => log.error('SCAN', `初始扫描失败: ${e.message}`));
} else {
  log.info('SCAN', '启动自动扫描已关闭——需要时请在设置页点「重新扫描曲库」（或 POST /api/scan）；'
    + '如需开机自动扫描，设环境变量 SCAN_ON_START=1');
}

// HLS 缓存每日清理：传入一个"当前曲库里有效歌曲 id 列表"的取值函数，供
// hlsgen.js 判断哪些 HLS 缓存目录是孤儿（对应歌曲已被删除/曲库文件已缺失）。
// 用函数惰性取值而不是在这里查一次库存起来，是因为清理任务每天才跑一次，
// 曲库内容早就可能变了，每次触发清理时都应该拿当次最新的曲库状态判断，
// 不能用注册时那一刻的旧快照。
scheduleHLSCleanup(() => db.prepare('SELECT id FROM songs').all().map(r => r.id));
