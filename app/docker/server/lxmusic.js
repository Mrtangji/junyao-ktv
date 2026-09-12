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
const { firstSinger } = require('./singers');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const TMP_DIR = path.join(DATA_DIR, 'lx_tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// 下载目录分两种（见 dlconfig.js，均由 docker 环境变量在启动时确定）：
//   MP3（含 LRC 歌词）→ MP3_DIR（env MP3_DIR，默认同 MV_DIR，如 /mp3）
//   MV（.mp4，含 MV 模式合成出的 mp4）→ MV_DIR（env MV_DIR，如 /mv）
// 均按歌手分目录：目录/歌手名/歌手名 - 歌名.mp3|.mp4，scanner.js 递归扫描两个
// 根目录自动入库，LRC 与 MP3 同名放一起、扫描时自动关联。
const dlcfg = require('./dlconfig');

// ---------- 取消（"停止"）支持 ----------
// 批量下载点「停止」时，除了让主循环不再开新任务，还必须**就地掐断正在进行的网络 I/O**，
// 否则要等当前请求自己超时才停得下来（脚本请求超时 30s、下载流 25s，一篇歌词也有 15s，
// 累加起来就是"按了停止很久没停"）。
// 难点：音源脚本内部的请求（lx.request）拿不到调用方传下来的 signal；内置源（boardsdk）
// 也在很深的层次各自调用 httpReq。所以这里维护一个模块级"当前取消令牌"：长流程
// （歌手批量下载）开始时注册，httpReq 在未显式传入 signal 时自动采用它 —— 于是脚本内、
// 内置源内发起的请求也能被一并中断。流程结束务必 setCancelSignal(null) 复位。
let currentCancelSignal = null;
function setCancelSignal(sig) { currentCancelSignal = sig || null; }

const stopError = () => Object.assign(new Error('__SB_STOPPED__'), { __stopped: true });

// 任一取消令牌已触发即抛出"已停止"。用于每个 await 之前 —— 因为音源脚本常把网络错误
// 吞掉后抛出自己的错误，靠错误对象上的 __stopped 会丢标记，这里用令牌状态兜住。
function throwIfAborted(signal) {
  if ((signal && signal.aborted) || (currentCancelSignal && currentCancelSignal.aborted)) throw stopError();
}
function isAborted(signal) {
  return !!((signal && signal.aborted) || (currentCancelSignal && currentCancelSignal.aborted));
}

// ---------- 通用 HTTP（跟随重定向 + gzip，供 lx.request 与内置源共用） ----------
function httpReq(url, options = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    // 取消令牌：显式传入优先，否则用当前流程注册的令牌（覆盖脚本内部/内置源内部请求）
    const signal = options.signal || currentCancelSignal;
    if (signal && signal.aborted) return reject(stopError());
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
    // 取消监听必须在 req.end() 之前就挂上。原实现把它写在响应回调里，导致
    // "已发出请求、响应头还没回来"这段（连接建立 + 首字节等待，脚本请求最长 30s）
    // 完全无法中断 —— 点了停止仍要等对方超时，这正是"按了停止很久没停"的主因。
    let onAbort = null;
    if (signal) {
      onAbort = () => req.destroy(stopError());
      signal.addEventListener('abort', onAbort);
    }
    const detachAbort = () => { if (onAbort) { try { signal.removeEventListener('abort', onAbort); } catch (e) {} onAbort = null; } };
    req.on('close', detachAbort);
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

// 社区源对 lx.request 回调 body 的消费方式不一：有的直接取属性（需 JSON 对象，
// 如独家音源 v5，取到字符串会抛 unknow error），有的无条件 JSON.parse(body)
//（需字符串，如长青），有的 Buffer.from(body)/typeof 判断（需原始串）。
// 用 String 包装对象：JSON.parse/字符串操作走原始串，属性来自解析后的 JSON。
function lxResponseBody(raw) {
  if (typeof raw !== 'string') return raw;
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return raw; }
  if (!parsed || typeof parsed !== 'object') return raw;
  const obj = new String(raw);
  Object.assign(obj, parsed);
  return obj;
}

// 解析脚本头部注释 @name/@description/@version/@author/@homepage// 兼容性：社区音源头部写法五花八门——官方文档是 /** */，但墨澜/星海/独家音源等
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
      // 音源脚本的网络请求默认放宽到 30s（部分源接口响应慢，15s 常超时）
      httpReq(url, Object.assign({ timeout: 30000 }, options || {})).then(resp => {
        if ((options && options.responseType) === 'buffer') return callback(null, resp, resp.body);
        const body = lxResponseBody(resp.body);
        callback(null, Object.assign({}, resp, { body }), body);
      }).catch(err => callback(err));
      return () => {};
    },
    utils: lxUtils(),
  };
  // 部分社区源（如独家音源 v5）直接使用 Node 的 crypto（createHash 等）
  const sandbox = { globalThis: {}, lx, console: { log: () => {}, error: () => {}, warn: () => {}, info: () => {} }, setTimeout, clearTimeout, Buffer, TextEncoder, TextDecoder, URL, URLSearchParams, crypto };
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
  let v = db.prepare("SELECT value FROM settings WHERE key='lx_active_source'").get();
  let id = v ? parseInt(v.value) : null;
  if (!id) {
    // 没有激活记录：典型场景是「修复前导入的音源在旧沙箱下激活失败、lx_active_source 从未写入」。
    // 若库里已有导入的源，自动启用最近导入的那一个，避免每次重启都退回未激活导致下载全失败。
    const row = db.prepare('SELECT id FROM lx_sources ORDER BY id DESC LIMIT 1').get();
    id = row ? row.id : null;
  }
  if (!id) return null;
  activateSourceById(id).catch(e => { console.error('LX 源初始化失败:', e.message); });
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
  if (!activeSource) throw new Error('NO_ACTIVE_SOURCE');  // 网络点唱/榜单的曲目来自内置酷我(kw)源（kwSearch/kwBoardSongs 的 songmid），
  // 因此必须用脚本声明的 kw 源解析；仅当脚本不支持 kw 时才退回其第一个源
  //（此时平台不匹配大概率失败，报错会注明平台，方便换源）。
  const keys = Object.keys(activeSource.sources);
  const sourceKey = keys.includes('kw') ? 'kw' : keys[0];
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
  const plat = keys.includes('kw') ? 'kw' : `${sourceKey}(非kw，与榜单平台不匹配)`;
  throw new Error(`音源「${activeSource.meta.name}」${plat} 解析失败：${(lastErr && lastErr.message) || '未知原因'}，可在曲库管理换音源重试`);
}

// ---------- 换链自动换源（源过期兜底） ----------
// resolveMusicUrl 失败（脚本过期/接口失效/NO_ACTIVE_SOURCE）时依次：
//   1) 轮换其余已导入的 LX 源脚本（实例按 id 缓存，避免每首歌重新拉起沙箱）；
//   2) kw 平台再用内置 antiserver 直链兜底（不依赖任何脚本）。
// 歌曲来自哪个平台（musicInfo.src：kw/wy/tx/kg）就优先用各脚本的同平台源解析。
const _altSourceCache = new Map(); // id -> inst | null（拉起失败的记 null 避免反复重试）

async function getAltSourceInstance(id) {
  if (_altSourceCache.has(id)) return _altSourceCache.get(id);
  let inst = null;
  try {
    const row = db.prepare('SELECT script FROM lx_sources WHERE id=?').get(id);
    if (row) inst = await runSourceScript(row.script);
  } catch (e) { inst = null; }
  _altSourceCache.set(id, inst);
  return inst;
}

async function resolveViaInstance(inst, sourceKey, musicInfo, preferQuality, signal) {
  const keys = Object.keys(inst.sources);
  const key = keys.includes(sourceKey) ? sourceKey : null;
  if (!key) throw new Error(`音源「${inst.meta.name}」不支持 ${sourceKey} 平台`);
  const qualitys = inst.sources[key].qualitys || ['128k', '320k'];
  const order = [preferQuality, ...qualitys.filter(q => q !== preferQuality)];
  let lastErr;
  for (const q of order) {
    throwIfAborted(signal);   // 音源脚本会把网络错误吞掉换成自己的错误，靠令牌状态兜住
    try {
      const url = await inst.requestHandler({ source: key, action: 'musicUrl', info: { type: q, musicInfo } });
      if (url && typeof url === 'string' && /^https?:/.test(url)) return url;
      lastErr = new Error('脚本返回无效 url');
    } catch (e) { if (e && e.__stopped) throw e; lastErr = e; }
  }
  throw lastErr || new Error('解析失败');
}

// 带自动换源的 musicUrl 解析。platform：歌曲来源平台（kw/wy/tx/kg）。
async function resolveMusicUrlWithFallback(platform, musicInfo, preferQuality = '320k', signal) {
  const errors = [];
  throwIfAborted(signal);
  // 1) 当前激活源
  if (activeSource) {
    try { return await resolveViaInstance(activeSource, platform, musicInfo, preferQuality, signal); }
    catch (e) { if (e && e.__stopped) throw e; errors.push(`当前源「${activeSource.meta.name}」: ${e.message}`); }
  } else {
    errors.push('NO_ACTIVE_SOURCE');
  }
  // 2) 其余已导入源逐个轮换
  const rows = activeSource
    ? db.prepare('SELECT id, name FROM lx_sources WHERE id != ? ORDER BY id').all(activeSource.id)
    : db.prepare('SELECT id, name FROM lx_sources ORDER BY id').all();
  for (const row of rows) {
    throwIfAborted(signal);
    const inst = await getAltSourceInstance(row.id);
    if (!inst) { errors.push(`源#${row.id} 拉起失败`); continue; }
    try { return await resolveViaInstance(inst, platform, musicInfo, preferQuality, signal); }
    catch (e) { if (e && e.__stopped) throw e; errors.push(`源「${inst.meta.name}」: ${e.message}`); }
  }
  // 3) kw 平台最后用内置酷我直链兜底
  if (platform === 'kw') {
    try {
      throwIfAborted(signal);
      const { resolveKwUrl } = require('./kw-url');
      const url = await resolveKwUrl(musicInfo.songmid || musicInfo.songId || musicInfo.musicId, preferQuality, signal);
      if (url) return url;
      errors.push('内置酷我直链也失败');
    } catch (e) { if (e && e.__stopped) throw e; errors.push(`内置酷我直链: ${e.message}`); }
  }
  throw new Error(`所有音源解析失败（${errors.join('；')}）`);
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
    // 秒（酷我搜索 DURATION / 榜单 duration；取不到为 0，调用方不过滤）
    duration: parseInt(item.DURATION) || parseInt(item.duration) || parseInt(item.interval) || 0,
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
  const list = (body.abslist || []).map(info => kwSong({ songmid: String(info.MUSICRID || '').replace('MUSIC_', ''), name: info.SONGNAME, singer: formatSinger(info.ARTIST), album: info.ALBUM, DURATION: info.DURATION, types: kwParseQuality(info.N_MINFO) }));
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
async function kwLyric(songmid, signal) {
  const params = `user=12345,web,web,web&requester=localhost&req=1&rid=MUSIC_${songmid}`;
  const key = Buffer.from('yeelion');
  const out = Buffer.alloc(params.length);
  for (let i = 0, j = 0; i < params.length; i++, j = (j + 1) % key.length) out[i] = params.charCodeAt(i) ^ key[j];
  const resp = await httpReq(`http://newlyric.kuwo.cn/newlyric.lrc?${out.toString('base64')}`, { responseType: 'buffer', timeout: 15000, signal });
  const buf = resp.body;
  if (resp.statusCode !== 200 || buf.toString('utf8', 0, 10) !== 'tp=content') throw new Error('歌词接口响应异常');
  const payload = buf.slice(buf.indexOf('\r\n\r\n') + 4);
  const lrc = new TextDecoder('gb18030').decode(zlib.inflateSync(payload));
  if (!lrc || !/\[\d{1,2}:\d{2}/.test(lrc)) throw new Error('歌词内容为空');
  return lrc;
}

// ---------- 下载入库 ----------
// 给 ffmpeg 子进程挂上取消：点「停止」时立刻 SIGKILL，不必等它把整首歌转完
// （一首 4 分钟的 FLAC 转 MP3 或合成 MP4，在 NAS 上要几十秒，这就是"按了停止
//  还卡很久"的另一个来源）。
function rejectOnAbort(child, signal, reject) {
  const sig = signal || currentCancelSignal;
  if (!sig) return;
  const onAbort = () => {
    try { child.kill('SIGKILL'); } catch (e) {}
    reject(stopError());
  };
  if (sig.aborted) return onAbort();
  sig.addEventListener('abort', onAbort);
  child.on('close', () => { try { sig.removeEventListener('abort', onAbort); } catch (e) {} });
}

function ffmpegToMp3(src, dst, signal) {
  return new Promise((resolve, reject) => {
    // -q:a 0 = LAME 最高质量 VBR（约 245kbps）。原来用 2（约 190kbps），
    // 把无损源压成 MP3 时白白丢掉一截；源本身是 mp3 的走 copy 不会进这里。
    const p = spawn('ffmpeg', ['-y', '-i', src, '-codec:a', 'libmp3lame', '-q:a', '0', dst], { windowsHide: true });
    rejectOnAbort(p, signal, reject);
    let err = '';
    p.stderr.on('data', d => { if (err.length < 2000) err += d.toString(); });
    p.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg 转码失败: ' + err.slice(-300))));
    p.on('error', reject);
  });
}

// mp3 + 封面图 → MV 风格 mp4（静态封面视频，走 MV 播放路径）。coverBuf 为空时用纯色背景
function ffmpegMp3ToMv(mp3Path, coverBuf, mp4Path, signal) {
  return new Promise((resolve, reject) => {
    const coverTmp = coverBuf ? mp4Path + '.cover' : null;
    try {
      const args = ['-y', '-loop', '1', '-framerate', '2'];
      if (coverTmp) { fs.writeFileSync(coverTmp, coverBuf); args.push('-i', coverTmp); }
      else args.push('-f', 'lavfi', '-i', 'color=c=0x141432:s=1280x720:r=2');
      args.push('-i', mp3Path,
        '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p',
        '-tune', 'stillimage', '-preset', 'ultrafast', '-shortest',
        '-c:v', 'libx264', '-c:a', 'aac', '-b:a', '320k', mp4Path);
      const p = spawn('ffmpeg', args, { windowsHide: true });
      rejectOnAbort(p, signal, reject);
      let err = '';
      p.stderr.on('data', d => { if (err.length < 2000) err += d.toString(); });
      p.on('close', code => { try { if (coverTmp) fs.unlinkSync(coverTmp); } catch (e) {} code === 0 ? resolve() : reject(new Error('ffmpeg 合成 MV 失败: ' + err.slice(-300))); });
      p.on('error', e => { try { if (coverTmp) fs.unlinkSync(coverTmp); } catch (e2) {} reject(e); });
    } catch (e) { reject(e); }
  });
}

// 下载封面图（仅接受 jpeg/png/webp），失败返回 null
async function downloadCover(picUrl, signal) {
  if (!picUrl || !/^https?:/.test(picUrl)) return null;
  try {
    const resp = await httpReq(picUrl, { responseType: 'buffer', timeout: 15000, signal });
    if (resp.statusCode !== 200) return null;
    const b = resp.body;
    const isJpeg = b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;
    const isPng = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47;
    const isWebp = b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';
    return (isJpeg || isPng || isWebp) ? b : null;
  } catch (e) { return null; }
}

const sanitize = (s) => String(s || '').replace(/[\\/:*?"<>|.]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || '未知';

// 跨设备安全的移动：rename 在 tmp 目录(/data/k_tmp)与曲库(/mv)挂在不同文件系统时
// 会抛 EXDEV: cross-device link not permitted，此时退化为复制+删除
function moveFile(src, dst) {
  try {
    fs.renameSync(src, dst);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(src, dst);
    try { fs.unlinkSync(src); } catch (e2) {}
  }
}

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

// 下载一首网络歌曲到曲库，返回 songs 表行
// format: 'mp3'（默认，320K 音质优先，存 MP3_DIR）
//       | 'flac'（无损优先：向音源请求 flac 音质，拿到 FLAC 原样落盘不转码；
//                源确实没有无损时自动回落 320K MP3，落盘为 .mp3）
//       | 'mv'（320K 音频 + 封面合成为 .mp4 存 MV_DIR；同时保留同名 .mp3 与 .lrc
//               到 MP3_DIR——曲库里 MV/MP3 双版本可用，LRC 跟音频走）
// sqOnly: 仅 format='flac' 时有意义。置 true 时"只要真无损"——音源实际只给到
//         有损内容（嗅探出的不是 FLAC）就放弃这一首（不落盘、不入库），
//         抛 __noLossless 让调用方换平台再找，避免库里混进 MP3 冒充无损。
async function downloadSong({ songmid, name, singer, source = 'kw', pic = null, format = 'mp3', lrcText = null, info = null, signal = null, sqOnly = false }) {
  throwIfAborted(signal);   // 已被停止（含脚本内部请求被掐断的情形）→ 直接干净退出
  const mp3Root = dlcfg.getMp3Dir();
  const mvRoot = path.resolve(dlcfg.MV_DIR);
  const isMv = format === 'mv';
  const lossless = format === 'flac';
  const dlRoot = isMv ? mvRoot : mp3Root; // 本次下载主文件的目标根目录
  if (!fs.existsSync(dlRoot)) throw new Error('MV_DIR_UNAVAILABLE');
  if (!fs.existsSync(isMv ? mp3Root : mvRoot)) throw new Error('MV_DIR_UNAVAILABLE');
  // 目录名取「第一位歌手」：合作曲（周杰伦、温岚）统一落到 周杰伦/ 目录下，
  // 不会建出「周杰伦、温岚」这种拼起来的目录（口径同 lx-music-desktop 的 getFirstSinger）。
  // 文件名/元数据仍保留完整歌手串 —— 扫描器是从文件名解析 artist 的，多歌手信息不丢。
  const artistFull = sanitize(singer) || '未知歌手';
  const artist = sanitize(firstSinger(singer)) || artistFull;
  const title = sanitize(name) || '未知歌名';
  // 主文件（mp3/flac/mp4）落 dlRoot；MV 模式下同时保留的 mp3/lrc 落 mp3Root
  const mainDir = path.join(dlRoot, artist);
  if (!fs.existsSync(mainDir)) fs.mkdirSync(mainDir, { recursive: true });
  if (isMv && mp3Root !== mvRoot) {
    const mp3Dir = path.join(mp3Root, artist);
    if (!fs.existsSync(mp3Dir)) fs.mkdirSync(mp3Dir, { recursive: true });
  }
  const baseName = `${artistFull} - ${title}`;
  const relOf = (e) => path.join(artist, `${baseName}.${e}`);
  let mp3Path = null;          // MV 模式下保留到 MP3_DIR 的同名 mp3 路径（函数作用域，供末尾入库用）
  // 已存在同名歌曲 → 直接返回库里的记录（可能上次已下过）。
  // Bug修复：必须按 filename（相对路径，扫描入库的唯一键）查——旧写法按 filepath
  // 查，而 filepath 存的是绝对路径，永远查不到，导致每次下载最后都报"入库失败"。
  // 无损模式两个后缀都查：音源没有无损时上一次会回落存成 .mp3，也算已下载。
  const inLib = (e) => db.prepare('SELECT * FROM songs WHERE filename=?').get(relOf(e).replace(/\\/g, '/'));
  let existed = inLib(isMv ? 'mp4' : (lossless ? 'flac' : 'mp3'));
  if (!existed && lossless && !isMv) existed = inLib('mp3');
  if (existed) return existed;
  // 1) 解析 url（320K 优先；当前源失效自动轮换其余源，kw 再退内置直链）；
  // 2) 拉流到临时文件；3) mp3 直存 / 转码 / 合成 MV
  const platform = ['kw', 'wy', 'tx', 'kg'].includes(source) ? source : 'kw';
  // musicInfo：脚本换链入参。不同平台字段要求不同——kg 需要 FileHash（hash=Audioid
  // 必然解析失败）、tx 需要 songId（数字 id）/strMediaMid、wy 需要数字 id。
  // 调用方经 info 透传搜索结果里的平台字段，覆盖下面的 songmid 兜底值。
  const musicInfo = { songmid, songId: songmid, musicId: songmid, hash: songmid, id: songmid, name, singer, singerName: singer, source: platform };
  if (info && typeof info === 'object') {
    for (const k of ['hash', 'songId', 'musicId', 'strMediaMid', 'albumAudioId', 'albumId', 'duration', 'interval', 'types', 'qualitys']) {
      if (info[k] != null && info[k] !== '') musicInfo[k] = info[k];
    }
  }
  // 无损模式先请求 flac 音质（脚本按 preferQuality 优先、失败才轮换其余音质；
  // 内置酷我直链兜底也支持 flac 参数），拿不到无损时返回值会是 mp3 直链，
  // 由下面的落盘分支自动按 MP3 处理。
  if (signal && signal.aborted) throw stopError();
  const url = await resolveMusicUrlWithFallback(platform, musicInfo, lossless ? 'flac' : '320k', signal);
  throwIfAborted(signal);
  const tmpPath = path.join(TMP_DIR, `dl_${Date.now()}_${process.pid}`);
  const resp = await httpReq(url, { responseType: 'buffer', timeout: 25000, signal });
  throwIfAborted(signal);
  if (resp.statusCode !== 200) throw new Error(`下载失败 HTTP ${resp.statusCode}`);
  // 内容校验：不是有效音频就直接给出可读原因，不再让 ffmpeg 报晦涩错误，
  // 也避免坏内容被 content-type 误判直接改名为 .mp3 入库
  const sniff = sniffAudio(resp.body);
  if (sniff.kind === 'text') throw new Error(`音源返回的不是音频（接口可能已失效或被风控）：${sniff.detail}`);
  if (sniff.kind === 'm3u8') throw new Error('音源返回的是 HLS 播放列表(m3u8)，该链接不支持直接下载，请换音源');
  const isMp3Src = sniff.kind === 'mp3';
  const rawAudio = isMp3Src || ['flac', 'ogg', 'm4a', 'wav', 'aac'].includes(sniff.kind);
  if (!rawAudio) throw new Error('音源返回的内容不是有效音频（可能已加密或链接已失效），请换音源或稍后重试');
  // 「只收无损」：搜索阶段靠平台音质标注过滤过一道，这里是最终兜底——
  // 音源实际返回的不是 FLAC（虚标无损/只有 320K MP3）就整首放弃。
  // 此时临时文件还没写盘（writeFileSync 在下面），直接抛错即可，不留垃圾。
  if (lossless && !isMv && sqOnly && sniff.kind !== 'flac') {
    throw Object.assign(new Error('该曲目无可用的无损资源（音源只返回了有损音质）'), { __noLossless: true });
  }
  // 无损模式且源确实给了 FLAC → 原样落盘 .flac（不转码，保住无损）；
  // 否则（源只有 MP3 / 其它有损容器）统一转成 MP3 落盘，
  // 后缀必须跟着实际内容走，不能出现"内容是 mp3 名字是 .flac"的假无损文件。
  const keepFlac = lossless && !isMv && sniff.kind === 'flac';
  const rel = relOf(isMv ? 'mp4' : (keepFlac ? 'flac' : 'mp3'));
  const finalPath = path.join(dlRoot, rel);
  const key = rel.replace(/\\/g, '/');
  fs.writeFileSync(tmpPath, resp.body);
  // 转码/合成阶段可被"停止"立刻掐断（kill 掉 ffmpeg 子进程），不必等整首转完
  try {
    if (!isMv) {
      if (isMp3Src || keepFlac) moveFile(tmpPath, finalPath);
      else { await ffmpegToMp3(tmpPath, finalPath, signal); try { fs.unlinkSync(tmpPath); } catch (e) {} }
    } else {
      // MV 模式：先统一为 mp3，再与封面合成 mp4；mp3 与 LRC 一并保留到 MP3_DIR
      // （需求：下载 MV 时同时得到对应 MP3 与 LRC——曲库里 MV/MP3 双版本可用，
      //   LRC 为两者共用同名文件。扫描器会把 mp4 记为 MV、mp3 记为 audio）
      const tmpMp3 = finalPath + '.tmp.mp3';
      // 保留的 mp3 落 MP3_DIR（与 MV 分库）；可能跨文件系统，用 moveFile 而非 rename
      mp3Path = path.join(mp3Root, artist, `${baseName}.mp3`);
      if (isMp3Src) moveFile(tmpPath, tmpMp3);
      else await ffmpegToMp3(tmpPath, tmpMp3, signal);
      try {
        const cover = await downloadCover(pic, signal);
        await ffmpegMp3ToMv(tmpMp3, cover, finalPath, signal);
        moveFile(tmpMp3, mp3Path);
      } finally { try { fs.unlinkSync(tmpMp3); } catch (e) {} }
      try { fs.unlinkSync(tmpPath); } catch (e) {}
    }
  } catch (e) { try { fs.unlinkSync(finalPath); } catch (e2) {} throw e; }
  // 同步下载 LRC 歌词（同名 .lrc 放一起，扫描器自动关联 lyrics_path）；
  // 歌词属附属信息，失败不影响歌曲入库。外部传入 lrcText（wy/tx/kg 由 boardsdk 取）
  // 优先使用；kw 平台用内置酷我歌词接口兜底。
  // 已被停止：跳过附属的歌词抓取（音频已经落盘，没必要再等一次网络请求才收工）
  try {
    if (!isAborted(signal)) {
      let lrc = lrcText;
      if (!lrc && platform === 'kw') { try { lrc = await kwLyric(songmid, signal); } catch (e) { lrc = null; } }
      if (lrc) {
        fs.writeFileSync(path.join(mp3Root, rel.replace(/\.(mp3|mp4|flac|m4a|aac|ogg|opus|wav)$/i, '.lrc')), lrc, 'utf8');
      } else { console.error('LRC 下载失败(忽略):', name); }
    }
  } catch (e) { console.error('LRC 下载失败(忽略):', name, e.message); }
  // 4) 入库并返回新行：只登记本首（含 MV 模式保留的同名 mp3），不再触发整库全量重扫，
  //    避免批量下载时每首歌都把整棵目录树 + 全库清理重跑一遍导致 CPU 持续拉满。
  //    注意：这里即使已被"停止"也照样入库——文件确实下好了，不入库反而会留下
  //    一个要等下次手动扫描才被发现的孤儿文件；入库后再由主循环的 stopFlag 收尾。
  const { scanFile } = require('./scanner');
  await scanFile(finalPath);
  if (isMv && mp3Path) await scanFile(mp3Path);
  const row = db.prepare('SELECT * FROM songs WHERE filename=?').get(key);
  if (!row) throw new Error('入库失败（扫描未识别到新文件）');
  return row;
}
// 非 kw 源时构造通用 musicInfo（不同源脚本字段名不一，尽量全给）
function musicInfoOf(songmid, name, singer) {
  return { songmid, songId: songmid, musicId: songmid, hash: songmid, id: songmid, name, singer, singerName: singer, source: Object.keys(activeSource ? activeSource.sources : {})[0] || 'kw' };
}

// 本地曲库匹配：标题+歌手模糊查（给"点唱榜/搜索结果"判断是否已有）。
// filter（可选）限定"算已有"的范围，用于歌手批量下载——不同格式任务对"已有"
// 的口径不同（FLAC 任务不应被库里已有的 TS/MV 或 MP3 挡住）：
//   · filter.exts：只认这些后缀的行（如 ['flac']），按 LOWER(filename) 尾缀匹配
//   · filter.mediaTypes：只认这些媒体类型的行（如 ['video']，MV 任务用）
//   · 不传 filter → 老口径：任何同名同歌手的行都算已有（点唱接口用这个）
function findLocalSong(name, singer, filter) {
  const title = sanitize(name);
  if (!title) return null;
  let sql = 'SELECT * FROM songs WHERE title LIKE ?';
  const args = [`%${title}%`];
  if (filter && Array.isArray(filter.exts) && filter.exts.length) {
    sql += ` AND (${filter.exts.map(() => `LOWER(filename) LIKE ?`).join(' OR ')})`;
    for (const e of filter.exts) args.push(`%.${String(e).replace(/^\./, '').toLowerCase()}`);
  } else if (filter && Array.isArray(filter.mediaTypes) && filter.mediaTypes.length) {
    sql += ` AND media_type IN (${filter.mediaTypes.map(() => '?').join(',')})`;
    args.push(...filter.mediaTypes);
  }
  sql += ' LIMIT 10';
  const rows = db.prepare(sql).all(...args);
  if (!rows.length) return null;
  if (!singer) return rows[0];
  const s = String(singer);
  return rows.find(r => s.includes(r.artist || '\u0000') || (r.artist || '').includes(firstSinger(s))) || null;
}

module.exports = {
  initActiveSource, activateSourceById, deactivateSource, activateScript, activeSource: () => activeSource,
  resolveMusicUrl, resolveMusicUrlWithFallback, kwSearch, kwBoardSongs, KW_BOARDS, kwLyric,
  downloadSong, findLocalSong, parseScriptMeta,
  // 长流程（歌手批量下载）注册/解除"取消令牌"，让脚本内、内置源内发起的请求也能被掐断
  setCancelSignal,
  // 内部工具：供 maidong.js 等模块复用下载入库链路
  internals: {
    httpReq, sniffAudio, moveFile, ffmpegToMp3, ffmpegMp3ToMv, downloadCover, sanitize, TMP_DIR,
    stopError, isAborted, throwIfAborted, currentCancelSignal: () => currentCancelSignal,
  },
};
