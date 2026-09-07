// ============ LX Music 整合 ============
// 三块能力：
//   1) LX 自定义音源脚本沙箱：导入 lx-music 自定义源 .js（协议见 lx-music-desktop
//      自定义源文档），在 node:vm 里执行，提供 globalThis.lx shim（EVENT_NAMES/
//      on/send/request/utils），解析出 musicUrl。协议约定：
//        - 脚本须 send(EVENT_NAMES.inited, { sources: { kw: { name, type:'music',
//          actions:['musicUrl'], qualitys:[...] }, ... } })
//        - on(EVENT_NAMES.request, ({source, action, info}) => Promise)
//          action='musicUrl' 时 info={type:'128k'|'320k'|'flac'|'flac24bit', musicInfo}
//   2) 内置酷我(kw)源适配器：网络搜索 + 榜单（含「KTV点唱榜」bangid=255）。
//      实现参考 lx-music-desktop src/renderer/utils/musicSdk/kw/。
//      搜索: http://search.kuwo.cn/r.s?...  JSON abslist
//      榜单: https://wbd.kuwo.cn/api/bd/bang/bang_info  AES-128-ECB 加密参数/响应
//   3) 下载：musicUrl 拉流 → mp3 直存 / 其它格式 ffmpeg 转码 mp3 → MV_DIR/歌手名/
//      （如 /mv/周杰伦/周杰伦 - 晴天.mp3）→ scanLibrary 入库 → 返回歌曲行（前端直接入队播放）。

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const vm = require('vm');
const { spawn } = require('child_process');
const db = require('./db');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const TMP_DIR = path.join(DATA_DIR, 'lx_tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// MV_DIR 与 scanner.js 同一环境变量。下载的歌按歌手分目录：
//   MV_DIR/歌手名/歌手名 - 歌名.mp3（如 /mv/周杰伦/周杰伦 - 晴天.mp3）
// scanner.js 是递归扫描，子目录会自动入库。
const MV_DIR = process.env.MV_DIR || '/mv';

// ---------- 通用 HTTP（跟随重定向 + gzip，供 lx.request 与内置源共用） ----------
function httpReq(url, options = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const headers = Object.assign({ 'User-Agent': 'lx-music-request/2.0.0', 'Accept-Encoding': 'gzip, deflate' }, options.headers || {});
    let body = options.body != null ? String(options.body) : null;
    if (options.form) {
      body = typeof options.form === 'string' ? options.form : new URLSearchParams(options.form).toString();
      headers['Content-Type'] = headers['Content-Type'] || 'application/x-www-form-urlencoded';
    } else if (options.formData && typeof options.formData === 'object') {
      const boundary = '----lxform' + crypto.randomBytes(8).toString('hex');
      const parts = [];
      for (const [k, v] of Object.entries(options.formData)) {
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
      }
      parts.push(Buffer.from(`--${boundary}--\r\n`));
      body = Buffer.concat(parts);
      headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
    }
    if (body) headers['Content-Length'] = Buffer.byteLength(body);
    const req = mod.request(u, { method: (options.method || (body ? 'POST' : 'GET')).toUpperCase(), headers, timeout: options.timeout || 15000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectCount < 5) {
        res.resume();
        const next = new URL(res.headers.location, u).toString();
        const m = (options.method || 'GET').toUpperCase();
        return resolve(httpReq(next, (m === 'GET') ? options : Object.assign({}, options, { method: m === 'POST' && [301, 302, 303].includes(res.statusCode) ? 'GET' : m, body: m === 'POST' && [301, 302, 303].includes(res.statusCode) ? null : body }), redirectCount + 1));
      }
      const chunks = [];
      let stream = res;
      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        const buf = Buffer.concat(chunks);
        const asBuffer = options.responseType === 'buffer' || !/text|json|html|xml|javascript/i.test(res.headers['content-type'] || '');
        resolve({ statusCode: res.statusCode, headers: res.headers, body: asBuffer ? buf : buf.toString('utf8') });
      });
      stream.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------- LX 源脚本沙箱 ----------
function lxUtils() {
  return {
    buffer: {
      from: (data, encoding) => Buffer.from(data, encoding),
      bufToString: (buf, format) => Buffer.from(buf).toString(format),
    },
    crypto: {
      aesEncrypt: (buffer, mode, key, iv) => {
        const cipher = crypto.createCipheriv(mode.toLowerCase().includes('gcm') ? mode : mode, key, iv || null);
        return Buffer.concat([cipher.update(Buffer.from(buffer)), cipher.final()]);
      },
      md5: (str) => crypto.createHash('md5').update(str).digest('hex'),
      randomBytes: (size) => crypto.randomBytes(size).toString('hex').slice(0, size),
      rsaEncrypt: (buffer, key) => crypto.publicEncrypt(key, Buffer.from(buffer)),
    },
    zlib: {
      inflate: (buf) => new Promise((res, rej) => zlib.inflate(Buffer.from(buf), (e, d) => e ? rej(e) : res(d))),
      deflate: (buf) => new Promise((res, rej) => zlib.deflate(Buffer.from(buf), (e, d) => e ? rej(e) : res(d))),
    },
  };
}

// 解析脚本头部注释 @name/@description/@version/@author/@homepage
// 兼容性：社区音源头部写法五花八门——官方文档是 /** */，但墨澜/星海/独家音源等
// 大量脚本用 /*! */ 或 /* */，还有的用 // 行注释，且文件可能带 BOM 或前置空行。
// 策略：去掉 BOM 后在文件前 16KB 内依次扫描所有块注释（每个注释块内提取 @key），
// 都找不到 name 再退化到 // 行注释里找；再找不到才报"不是有效的音源脚本"。
function parseScriptMeta(script) {
  const meta = { name: '', description: '', version: '', author: '', homepage: '' };
  const head = String(script || '').replace(/^\uFEFF/, '').slice(0, 16384);
  const grab = (text) => {
    for (const key of Object.keys(meta)) {
      if (meta[key]) continue;
      // 值在同行取到行尾或注释装饰符为止；description 换行内容不追，取首行够用
      const km = text.match(new RegExp(`@${key}[ \\t]+([^\\r\\n*]+)`));
      if (km) meta[key] = km[1].replace(/\s+$/, '').trim();
    }
  };
  const blocks = head.match(/\/\*[\s\S]*?\*\//g) || [];
  for (const b of blocks) { grab(b); if (meta.name) break; }
  if (!meta.name) grab(head.split(/\r?\n/).filter(l => l.trim().startsWith('//')).join('\n'));
  return meta;
}

// 在 vm 沙箱里跑一个源脚本，返回 { sources, requestHandler }
// 注意：不少社区源（如长青SVIP、独家音源）是"异步初始化"——脚本先注册 on()，
// 再拉取远端配置后才 send(inited)，同步检查会误判"未发送有效的 inited 事件"。
// 所以这里用带超时（15 秒）的轮询等待 inited 与 request 处理函数都就绪。
async function runSourceScript(script) {
  const meta = parseScriptMeta(script);
  if (!meta.name) throw new Error('不是有效的 LX 音源脚本：找不到 @name 头部注释（请确认选择的是音源 .js 文件，而非普通脚本）');
  let initedInfo = null;
  let requestHandler = null;
  const EVENT_NAMES = { inited: 'inited', request: 'request', updateAlert: 'updateAlert' };
  const lx = {
    version: '2.0.0',
    env: 'desktop',
    currentScriptInfo: Object.assign({ rawScript: script }, meta),
    EVENT_NAMES,
    on: (name, handler) => { if (name === EVENT_NAMES.request) requestHandler = handler; },
    send: (name, data) => { if (name === EVENT_NAMES.inited) initedInfo = data; },
    request: (url, options, callback) => {
      httpReq(url, options || {}).then(resp => callback(null, resp, resp.body)).catch(err => callback(err));
      return () => {};
    },
    utils: lxUtils(),
  };
  const sandbox = { globalThis: {}, lx, console: { log: () => {}, error: () => {}, warn: () => {}, info: () => {} }, setTimeout, clearTimeout, Buffer, TextEncoder, TextDecoder, URL, URLSearchParams };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { timeout: 8000, filename: `${meta.name || 'lx-source'}.js` });
  const hasSources = () => !!(initedInfo && initedInfo.sources && Object.keys(initedInfo.sources).length);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !(hasSources() && requestHandler)) {
    await new Promise(r => setTimeout(r, 200));
  }
  if (!hasSources()) throw new Error('脚本未发送有效的 inited 事件（sources 为空）');
  if (!requestHandler) throw new Error('脚本未注册 request 事件处理函数');
  const sources = {};
  for (const [k, v] of Object.entries(initedInfo.sources)) {
    sources[k] = { name: v.name || k, actions: v.actions || ['musicUrl'], qualitys: v.qualitys || ['128k', '320k'] };
  }
  return { meta, sources, requestHandler };
}

// ---------- 源管理（存 DB，同时最多启用一个，与 LX Music 行为一致） ----------
db.exec(`CREATE TABLE IF NOT EXISTS lx_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT, description TEXT, version TEXT, author TEXT, homepage TEXT,
  script TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
)`);

let activeSource = null; // { id, meta, sources, requestHandler }

async function activateSourceById(id) {
  const row = db.prepare('SELECT * FROM lx_sources WHERE id=?').get(id);
  if (!row) throw new Error('源不存在');
  const inst = await runSourceScript(row.script);
  activeSource = { id: row.id, meta: inst.meta, sources: inst.sources, requestHandler: inst.requestHandler };
  db.prepare("INSERT INTO settings (key,value) VALUES ('lx_active_source',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(row.id));
  return activeSource;
}

function initActiveSource() {
  const v = db.prepare("SELECT value FROM settings WHERE key='lx_active_source'").get();
  if (!v) return null;
  activateSourceById(parseInt(v.value)).catch(e => { console.error('LX 源初始化失败:', e.message); return null; });
  return null;
}

// 校验脚本可运行（导入前用），返回实例但不设为激活
function activateScript(script) {
  return runSourceScript(script);
}

// 停用当前源（源被删除时）
function deactivateSource() {
  activeSource = null;
}

// 通过 LX 源解析 musicUrl（quality 降级重试）
async function resolveMusicUrl(musicInfo, preferQuality = '320k') {
  if (!activeSource) throw new Error('NO_ACTIVE_SOURCE');
  // 选脚本声明的第一个源 key（一般只有一个）
  const sourceKey = Object.keys(activeSource.sources)[0];
  const qualitys = activeSource.sources[sourceKey].qualitys;
  const order = [preferQuality, ...qualitys.filter(q => q !== preferQuality)];
  let lastErr;
  for (const q of order) {
    try {
      const url = await activeSource.requestHandler({ source: sourceKey, action: 'musicUrl', info: { type: q, musicInfo } });
      if (url && typeof url === 'string' && /^https?:/.test(url)) return url;
      lastErr = new Error('脚本返回无效 url');
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('musicUrl 解析失败');
}

// ---------- 内置酷我(kw)源：搜索 + 榜单 ----------
// 参考 lx-music-desktop musicSdk/kw，AES-128-ECB 参数/响应加解密
const KW_AES_KEY = Buffer.from([112, 87, 39, 61, 199, 250, 41, 191, 57, 68, 45, 114, 221, 94, 140, 228], 'binary');
const KW_APP_ID = 'y67sprxhhpws';
function kwBuildParam(jsonData) {
  const cipher = crypto.createCipheriv('aes-128-ecb', KW_AES_KEY, null);
  const enc = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(jsonData))), cipher.final()]).toString('base64');
  const time = Date.now();
  const sign = crypto.createHash('md5').update(`${KW_APP_ID}${enc}${time}`).digest('hex').toUpperCase();
  return `data=${encodeURIComponent(enc)}&time=${time}&appId=${KW_APP_ID}&sign=${sign}`;
}
function kwDecodeBody(base64Result) {
  const raw = Buffer.from(decodeURIComponent(base64Result), 'base64');
  const decipher = crypto.createDecipheriv('aes-128-ecb', KW_AES_KEY, null);
  return JSON.parse(Buffer.concat([decipher.update(raw), decipher.final()]).toString());
}
const formatSinger = (s) => String(s || '').replace(/&|\/|,/g, '、').trim();
const M_INFO_RE = /level:(\w+),bitrate:(\d+),format:(\w+),size:([\w.]+)/;
function kwParseQuality(nMinfo) {
  const types = [];
  if (!nMinfo) return types;
  for (const seg of nMinfo.split(';')) {
    const m = seg.match(M_INFO_RE);
    if (!m) continue;
    const map = { '4000': 'flac24bit', '2000': 'flac', '320': '320k', '128': '128k' };
    if (map[m[2]] && !types.includes(map[m[2]])) types.push(map[m[2]]);
  }
  const order = ['flac24bit', 'flac', '320k', '128k'];
  return types.sort((a, b) => order.indexOf(a) - order.indexOf(b));
}
function kwSong(item, nameField, singerField) {
  return {
    songmid: item.songmid || String(item.id || item.MUSICRID || '').replace('MUSIC_', ''),
    name: item.name || item.SONGNAME || '',
    singer: item.singer || formatSinger(item.ARTIST || item.artist || ''),
    album: item.albumName || item.ALBUM || item.album || '',
    pic: item.pic || item.img || item.picPath || null,
    source: 'kw',
    types: item.types || kwParseQuality(item.n_minfo || item.N_MINFO),
  };
}

// 榜单列表（静态，来自 lx-music-desktop kw/leaderboard.js 的 boardList，KTV点唱榜=255）
const KW_BOARDS = [
  ['255', 'KTV点唱榜'], ['93', '飙升榜'], ['17', '新歌榜'], ['16', '热歌榜'], ['158', '抖音热歌榜'],
  ['187', '流行趋势榜'], ['26', '经典怀旧榜'], ['104', '华语榜'], ['182', '粤语榜'], ['22', '欧美榜'],
  ['64', '影视金曲榜'], ['176', 'DJ嗨歌榜'], ['185', '最强翻唱榜'], ['186', 'ACG神曲榜'], ['278', '古风音乐榜'],
].map(([bangid, name]) => ({ id: `kw__${bangid}`, name, bangid }));

async function kwSearch(str, page = 1, limit = 30) {
  const url = `http://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(str)}&pn=${page - 1}&rn=${limit}&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1`;
  const resp = await httpReq(url);
  let body = resp.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { throw new Error('酷我搜索响应解析失败'); } }
  const list = (body.abslist || []).map(info => kwSong({ songmid: String(info.MUSICRID || '').replace('MUSIC_', ''), name: info.SONGNAME, singer: formatSinger(info.ARTIST), album: info.ALBUM, types: kwParseQuality(info.N_MINFO) }));
  return { list, total: parseInt(body.TOTAL || list.length), page, limit };
}

async function kwBoardSongs(bangid, page = 1, limit = 100) {
  const body = { uid: '', devId: '', sFrom: 'kuwo_sdk', user_type: 'AP', carSource: 'kwplayercar_ar_6.0.1.0_apk_keluze.apk', id: String(bangid), pn: page - 1, rn: limit };
  const url = `https://wbd.kuwo.cn/api/bd/bang/bang_info?${kwBuildParam(body)}`;
  const resp = await httpReq(url, { responseType: 'buffer' });
  const raw = kwDecodeBody(resp.body.toString('utf8'));
  if (raw.code != 200 || !raw.data || !raw.data.musiclist) throw new Error('榜单数据获取失败');
  return { list: raw.data.musiclist.map(it => kwSong(it)), total: parseInt(raw.data.total || 0), page, limit };
}

// ---------- 歌词（酷我 newlyric 接口） ----------
// 流程（参考 lx-music-desktop kw/lyric.js 与酷我 PC 客户端解密方案）：
//   请求参数串与 'yeelion' 逐字节 XOR 后 base64 → GET newlyric.lrc →
//   响应为 "tp=content\r\n...\r\n\r\n" + zlib deflate 数据 → inflate 后是
//   GB18030 编码的标准 LRC 文本（含 [ti:]/[ar:] 等标签）。
async function kwLyric(songmid) {
  const params = `user=12345,web,web,web&requester=localhost&req=1&rid=MUSIC_${songmid}`;
  const key = Buffer.from('yeelion');
  const out = Buffer.alloc(params.length);
  for (let i = 0, j = 0; i < params.length; i++, j = (j + 1) % key.length) out[i] = params.charCodeAt(i) ^ key[j];
  const resp = await httpReq(`http://newlyric.kuwo.cn/newlyric.lrc?${out.toString('base64')}`, { responseType: 'buffer', timeout: 15000 });
  const buf = resp.body;
  if (resp.statusCode !== 200 || buf.toString('utf8', 0, 10) !== 'tp=content') throw new Error('歌词接口响应异常');
  const payload = buf.slice(buf.indexOf('\r\n\r\n') + 4);
  const lrc = new TextDecoder('gb18030').decode(zlib.inflateSync(payload));
  if (!lrc || !/\[\d{1,2}:\d{2}/.test(lrc)) throw new Error('歌词内容为空');
  return lrc;
}

// ---------- 下载入库 ----------
function ffmpegToMp3(src, dst) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-y', '-i', src, '-codec:a', 'libmp3lame', '-q:a', '2', dst], { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => { if (err.length < 2000) err += d.toString(); });
    p.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg 转码失败: ' + err.slice(-300))));
    p.on('error', reject);
  });
}

// mp3 + 封面图 → MV 风格 mp4（静态封面视频，走 MV 播放路径）。coverBuf 为空时用纯色背景
function ffmpegMp3ToMv(mp3Path, coverBuf, mp4Path) {
  return new Promise((resolve, reject) => {
    const coverTmp = coverBuf ? mp4Path + '.cover' : null;
    try {
      const args = ['-y', '-loop', '1', '-framerate', '2'];
      if (coverTmp) { fs.writeFileSync(coverTmp, coverBuf); args.push('-i', coverTmp); }
      else args.push('-f', 'lavfi', '-i', 'color=c=0x141432:s=1280x720:r=2');
      args.push('-i', mp3Path,
        '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p',
        '-tune', 'stillimage', '-preset', 'ultrafast', '-shortest',
        '-c:v', 'libx264', '-c:a', 'aac', '-b:a', '192k', mp4Path);
      const p = spawn('ffmpeg', args, { windowsHide: true });
      let err = '';
      p.stderr.on('data', d => { if (err.length < 2000) err += d.toString(); });
      p.on('close', code => { try { if (coverTmp) fs.unlinkSync(coverTmp); } catch (e) {} code === 0 ? resolve() : reject(new Error('ffmpeg 合成 MV 失败: ' + err.slice(-300))); });
      p.on('error', e => { try { if (coverTmp) fs.unlinkSync(coverTmp); } catch (e2) {} reject(e); });
    } catch (e) { reject(e); }
  });
}

// 下载封面图（仅接受 jpeg/png/webp），失败返回 null
async function downloadCover(picUrl) {
  if (!picUrl || !/^https?:/.test(picUrl)) return null;
  try {
    const resp = await httpReq(picUrl, { responseType: 'buffer', timeout: 15000 });
    if (resp.statusCode !== 200) return null;
    const b = resp.body;
    const isJpeg = b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;
    const isPng = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47;
    const isWebp = b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';
    return (isJpeg || isPng || isWebp) ? b : null;
  } catch (e) { return null; }
}

const sanitize = (s) => String(s || '').replace(/[\\/:*?"<>|.]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || '未知';

// 识别下载内容是否为有效音频。社区音源的取链接口常返回 JSON/HTML 错误页、
// 防盗链提示甚至加密数据，直接丢给 ffmpeg 只会报晦涩的
// "Invalid data found when processing input"，且坏内容可能被当歌曲改名入库。
// 这里用魔数识别：mp3/flac/ogg/m4a/wav/aac(ADTS) 视为有效；m3u8 单独提示；
// 文本类取出前 120 字符展示给用户（通常是接口报错信息）。
function sniffAudio(buf) {
  if (!buf || buf.length < 16) return { kind: 'unknown' };
  const head = buf.toString('latin1', 0, 512).replace(/^\uFEFF/, '').trimStart();
  if (/^#EXTM3U/.test(head)) return { kind: 'm3u8' };
  if (/^[{<]/.test(head) || /^<!DOCTYPE|^<html/i.test(head)) {
    const text = buf.toString('utf8', 0, 300).replace(/\s+/g, ' ').trim();
    return { kind: 'text', detail: text.slice(0, 120) };
  }
  if (buf.toString('latin1', 0, 3) === 'ID3') return { kind: 'mp3' };
  if (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) {
    // MPEG 帧同步：layer 位为 00 是 ADTS AAC（不能直接改名为 .mp3），否则是 mp3
    return (buf[1] & 0x06) === 0 ? { kind: 'aac' } : { kind: 'mp3' };
  }
  if (buf.toString('latin1', 0, 4) === 'fLaC') return { kind: 'flac' };
  if (buf.toString('latin1', 0, 4) === 'OggS') return { kind: 'ogg' };
  if (buf.length > 12 && buf.toString('latin1', 4, 8) === 'ftyp') return { kind: 'm4a' };
  if (buf.toString('latin1', 0, 4) === 'RIFF') return { kind: 'wav' };
  return { kind: 'unknown' };
}

// 下载一首网络歌曲到曲库（MV_DIR/歌手名/歌手名 - 歌名.mp3|.mp4），返回 songs 表行
// format: 'mp3'（默认，320K 音质优先）| 'mv'（同一 320K 音频 + 封面合成为视频，
//         并同时保留同名 .mp3 与 .lrc——MV/MP3 双版本入库）
async function downloadSong({ songmid, name, singer, source = 'kw', pic = null, format = 'mp3' }) {
  if (!fs.existsSync(MV_DIR)) throw new Error('MV_DIR_UNAVAILABLE');
  const artist = sanitize(singer) || '未知歌手';
  const title = sanitize(name) || '未知歌名';
  const isMv = format === 'mv';
  const artistDir = path.join(MV_DIR, artist);
  if (!fs.existsSync(artistDir)) fs.mkdirSync(artistDir, { recursive: true });
  const rel = path.join(artist, `${artist} - ${title}.${isMv ? 'mp4' : 'mp3'}`);
  const finalPath = path.join(MV_DIR, rel);
  // 已存在同名歌曲 → 直接返回库里的记录（可能上次已下过）
  const existed = db.prepare('SELECT * FROM songs WHERE filepath=?').get(rel.replace(/\\/g, '/'));
  if (existed) return existed;
  // 1) 解析 url（320K 优先）；2) 拉流到临时文件；3) mp3 直存 / 转码 / 合成 MV
  const url = await resolveMusicUrl(source === 'kw' ? { songmid, songId: songmid, musicId: songmid, name, singer } : musicInfoOf(songmid, name, singer));
  const tmpPath = path.join(TMP_DIR, `dl_${Date.now()}_${process.pid}`);
  const resp = await httpReq(url, { responseType: 'buffer', timeout: 120000 });
  if (resp.statusCode !== 200) throw new Error(`下载失败 HTTP ${resp.statusCode}`);
  // 内容校验：不是有效音频就直接给出可读原因，不再让 ffmpeg 报晦涩错误，
  // 也避免坏内容被 content-type 误判直接改名为 .mp3 入库
  const sniff = sniffAudio(resp.body);
  if (sniff.kind === 'text') throw new Error(`音源返回的不是音频（接口可能已失效或被风控）：${sniff.detail}`);
  if (sniff.kind === 'm3u8') throw new Error('音源返回的是 HLS 播放列表(m3u8)，该链接不支持直接下载，请换音源');
  const isMp3Src = sniff.kind === 'mp3';
  const rawAudio = isMp3Src || ['flac', 'ogg', 'm4a', 'wav', 'aac'].includes(sniff.kind);
  if (!rawAudio) throw new Error('音源返回的内容不是有效音频（可能已加密或链接已失效），请换音源或稍后重试');
  fs.writeFileSync(tmpPath, resp.body);
  try {
    if (!isMv) {
      if (isMp3Src) fs.renameSync(tmpPath, finalPath);
      else { await ffmpegToMp3(tmpPath, finalPath); try { fs.unlinkSync(tmpPath); } catch (e) {} }
    } else {
      // MV 模式：先统一为 mp3，再与封面合成 mp4；mp3 一并保留入库
      // （需求：下载 MV 时同时得到对应 MP3 与 LRC——曲库里 MV/MP3 双版本可用，
      //   LRC 为两者共用同名文件。扫描器会把 mp4 记为 MV、mp3 记为 audio）
      const tmpMp3 = finalPath + '.tmp.mp3';
      const mp3Path = finalPath.replace(/\.mp4$/i, '.mp3');
      if (isMp3Src) fs.renameSync(tmpPath, tmpMp3);
      else await ffmpegToMp3(tmpPath, tmpMp3);
      try {
        const cover = await downloadCover(pic);
        await ffmpegMp3ToMv(tmpMp3, cover, finalPath);
        try { fs.renameSync(tmpMp3, mp3Path); } catch (e) {}
      } finally { try { fs.unlinkSync(tmpMp3); } catch (e) {} }
      try { fs.unlinkSync(tmpPath); } catch (e) {}
    }
  } catch (e) { try { fs.unlinkSync(finalPath); } catch (e2) {} throw e; }
  // 同步下载 LRC 歌词（同名 .lrc 放一起，扫描器自动关联 lyrics_path）；
  // 歌词属附属信息，失败不影响歌曲入库。仅酷我源提供该接口。
  if (source === 'kw') {
    try {
      const lrc = await kwLyric(songmid);
      fs.writeFileSync(path.join(MV_DIR, rel.replace(/\.(mp3|mp4)$/i, '.lrc')), lrc, 'utf8');
    } catch (e) { console.error('LRC 下载失败(忽略):', name, e.message); }
  }
  // 4) 扫描入库并返回新行
  const { scanLibrary } = require('./scanner');
  await scanLibrary();
  const row = db.prepare('SELECT * FROM songs WHERE filepath=?').get(rel.replace(/\\/g, '/'));
  if (!row) throw new Error('入库失败（扫描未识别到新文件）');
  return row;
}
// 非 kw 源时构造通用 musicInfo（不同源脚本字段名不一，尽量全给）
function musicInfoOf(songmid, name, singer) {
  return { songmid, songId: songmid, musicId: songmid, hash: songmid, id: songmid, name, singer, singerName: singer, source: Object.keys(activeSource ? activeSource.sources : {})[0] || 'kw' };
}

// 本地曲库匹配：标题+歌手模糊查（给"点唱榜/搜索结果"判断是否已有）
function findLocalSong(name, singer) {
  const title = sanitize(name);
  if (!title) return null;
  const rows = db.prepare(`SELECT * FROM songs WHERE title LIKE ? LIMIT 10`).all(`%${title}%`);
  if (!rows.length) return null;
  if (!singer) return rows[0];
  const s = String(singer);
  return rows.find(r => s.includes(r.artist || '\u0000') || (r.artist || '').includes(s.split('、')[0])) || null;
}

module.exports = {
  initActiveSource, activateSourceById, deactivateSource, activateScript, activeSource: () => activeSource,
  resolveMusicUrl, kwSearch, kwBoardSongs, KW_BOARDS, kwLyric,
  downloadSong, findLocalSong, parseScriptMeta,
};
