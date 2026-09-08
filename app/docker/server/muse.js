// 麦动 muse.db 双源曲库（曲库浏览/搜索 + 麦动排行榜）+ ktv_api.js 实时换链
// =====================================================================
// 复刻 maidong app / maidong-server 的同源机制：
//  - muse.db（app 同款 SQLite 曲库）：
//      songs 表（deleted_at IS NULL 且 cloud_url 非空 = 可下载）→「全部歌曲」
//      playlists(type=2) 排行榜歌单 ⋈ playlist_songs →「麦动排行榜」（与 app 一致）
//  - ktv_api.js 热更链路：按歌曲编号（filename 去掉 .ts/.ls 后缀，即"musicno"）
//      实时换新签名直链（返回 .ts，MPEG-TS），muse.db 里的 cloud_url 签名会过期，
//      必须下载时实时换链，不能复用库里的旧链接。
// muse.db 来源（按优先级）：
//  1. 设置里配置的 md_muse_url（settings 表，跟随 /data 持久化）：
//     - http(s)://...：远程 muse.db，下载缓存到 DATA_DIR/muse-md.db（24h 自动刷新，
//       保存配置时强制刷新；下载失败时回落用上一次的缓存）
//     - 其它值：视为容器内路径（如把 muse.db 挂载进 /data 直接填 /data/muse.db）
//  2. 未配置时自动发现：DATA_DIR/muse.db（宿主机挂载，如 /data/muse.db）
//     → 镜像内置 /app/vendor/muse.db（CI 构建时从 GitHub Release 打进镜像，
//       开箱即用，无需任何配置）
// 下载的 ts：MV 模式 ffmpeg -c copy 转封装 mp4 入 MV_DIR；MP3 模式抽音频入 MP3_DIR
// （见 maidong.js downloadMd）。
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const KEY = 'md_muse_url';
const CACHE_NAME = 'muse-md.db';
// 未配置 md_muse_url 时的自动发现路径（按优先级）：宿主机挂载 → 镜像内置
const DATA_DB = path.join(DATA_DIR, 'muse.db');
const BUNDLED_DB = '/app/vendor/muse.db';
const REFRESH_MS = 24 * 60 * 60 * 1000; // 远程 muse.db 缓存刷新间隔
const KTV_API_REMOTE =
  'https://gitee.com/yangyachao-X/maidong-ktv/raw/master/app/src/main/assets/mobile/ktv_api.js';
const KTV_API_REFRESH_MS = 24 * 60 * 60 * 1000;

// ---------- 配置 ----------
function getMuseUrl() {
  try {
    const row = require('./db').prepare('SELECT value FROM settings WHERE key=?').get(KEY);
    return (row && row.value ? String(row.value) : '').trim();
  } catch (e) { return ''; }
}

// 解析配置 → { remote } 或 { local }；未配置时自动发现（/data/muse.db → 镜像内置），都找不到返回 null
function resolveSource() {
  const v = getMuseUrl();
  if (/^https?:\/\//i.test(v)) return { remote: v, cache: path.join(DATA_DIR, CACHE_NAME) };
  if (v) return { local: v };
  // 自动发现：宿主机挂载优先（可覆盖镜像内置版本），其次镜像内置
  if (fs.existsSync(DATA_DB)) return { local: DATA_DB };
  if (fs.existsSync(BUNDLED_DB)) return { local: BUNDLED_DB };
  return null;
}

// ---------- 远程 muse.db 下载（流式，跟随重定向） ----------
function downloadToFile(url, dest, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 60000, headers: { Accept: '*/*' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        return downloadToFile(res.headers.location, dest, redirectsLeft - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const out = fs.createWriteStream(dest + '.part');
      res.pipe(out);
      out.on('finish', () => out.close(() => { fs.renameSync(dest + '.part', dest); resolve(); }));
      out.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
  });
}

// 确保 muse.db 本地可用，返回本地路径。force=true 强制重新下载远程副本。
async function ensureMuseDb(force = false) {
  const src = resolveSource();
  if (!src) throw new Error('未找到麦动 muse.db（可放 /data/muse.db、打进镜像或到设置里配置地址）');
  if (src.local) {
    if (!fs.existsSync(src.local)) throw new Error('muse.db 不存在: ' + src.local);
    return src.local;
  }
  const cache = src.cache;
  const fresh = fs.existsSync(cache) && (Date.now() - fs.statSync(cache).mtimeMs) < REFRESH_MS;
  if (fresh && !force) return cache;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    await downloadToFile(src.remote, cache);
  } catch (e) {
    if (fs.existsSync(cache)) return cache; // 下载失败回落旧缓存
    throw new Error('muse.db 下载失败: ' + e.message);
  }
  return cache;
}

// ---------- muse.db 只读查询 ----------
let _db = null, _dbKey = '';
function openDb(file) {
  const st = fs.statSync(file);
  const key = file + '|' + st.mtimeMs + '|' + st.size;
  if (_db && _dbKey === key) return _db;
  try { if (_db) _db.close(); } catch (e) {}
  // 更新中的 muse.db 可能带 -wal，只读打开；WAL 校验点失败则退化为拷贝副本再开
  try {
    _db = new Database(file, { readonly: true, fileMustExist: true });
  } catch (e) {
    const copy = path.join(DATA_DIR, 'muse-md-open.db');
    fs.copyFileSync(file, copy);
    _db = new Database(copy, { readonly: true, fileMustExist: true });
  }
  _dbKey = key;
  return _db;
}

const SINGER_SUB =
  "(SELECT group_concat(sg.name,'、') FROM song_singer_relations ssr " +
  'INNER JOIN singers sg ON sg.id=ssr.singer_id WHERE ssr.song_id=s.id)';
const BASE_WHERE =
  'WHERE s.deleted_at IS NULL AND s.cloud_url IS NOT NULL AND s.cloud_url != \'\' ' +
  'AND s.filename IS NOT NULL AND s.filename != \'\'';

function entryOf(r) {
  const no = String(r.filename || '').replace(/\.(ls|ts)$/i, '');
  return {
    songmid: no,               // musicno，换链下载用
    name: String(r.name || no).trim(),
    singer: String(r.singer_names || '').trim(),
    src: 'muse',               // 前端点歌时带上，服务端据此走实时换链
    url: null,                 // 签名直链会过期，必须点歌时实时换链
    pic: null,
  };
}

// 全部歌曲（最常唱排序）+ 关键词搜索（歌名/歌手模糊）
async function allSongs({ q = '', page = 1, limit = 100 } = {}) {
  const file = await ensureMuseDb(false);
  const db = openDb(file);
  const where = BASE_WHERE;
  const kw = String(q || '').trim();
  const having = kw
    ? ` AND (s.name LIKE '%' || @kw || '%' OR ${SINGER_SUB} LIKE '%' || @kw || '%')`
    : '';
  const totalRow = db.prepare(`SELECT COUNT(*) c FROM songs s ${where}${having}`).get({ kw });
  const rows = db.prepare(
    `SELECT s.filename, s.name, ${SINGER_SUB} AS singer_names FROM songs s ${where}${having} ` +
    'ORDER BY s.rec_score DESC, s.local_hot_score DESC, s.hot_score DESC LIMIT @limit OFFSET @offset'
  ).all({ kw, limit: String(limit), offset: String((Math.max(1, page) - 1) * limit) });
  return { list: rows.map(entryOf), total: totalRow ? totalRow.c : 0, page: Math.max(1, page), limit };
}

// 排行榜歌单（playlists type=2，与 app「排行榜」同源同序）
async function rankPlaylists() {
  const file = await ensureMuseDb(false);
  const db = openDb(file);
  const rows = db.prepare(
    'SELECT id, name, song_count FROM playlists WHERE deleted_at IS NULL AND type=2 ' +
    'ORDER BY CASE WHEN rank_type IS NULL THEN 1 ELSE 0 END, rank_type ASC, rec_score DESC'
  ).all();
  return rows.map(r => ({ bangid: 'muse_rank_' + r.id, name: `${r.name || '排行榜'}(${r.song_count || 0})` }));
}

// 排行榜歌单内歌曲（按 sort_no，与 app 一致）
async function rankSongs(playlistId, page = 1, limit = 100) {
  const file = await ensureMuseDb(false);
  const db = openDb(file);
  const where = 'WHERE ps.playlist_id=@pid AND s.deleted_at IS NULL AND ' +
    "s.cloud_url IS NOT NULL AND s.cloud_url != '' AND s.filename IS NOT NULL AND s.filename != ''";
  const totalRow = db.prepare(
    `SELECT COUNT(*) c FROM playlist_songs ps INNER JOIN songs s ON s.id=ps.song_id ${where}`
  ).get({ pid: String(playlistId) });
  const rows = db.prepare(
    `SELECT s.filename, s.name, ${SINGER_SUB} AS singer_names FROM songs s ` +
    'INNER JOIN playlist_songs ps ON s.id=ps.song_id ' + where +
    ' ORDER BY ps.sort_no ASC LIMIT @limit OFFSET @offset'
  ).all({ pid: String(playlistId), limit: String(limit), offset: String((Math.max(1, page) - 1) * limit) });
  return { list: rows.map(entryOf), total: totalRow ? totalRow.c : 0, page: Math.max(1, page), limit };
}

// 曲库规模（设置面板展示用；未启用返回 0）
function songCount() {
  try {
    const src = resolveSource();
    if (!src) return 0;
    const file = src.local || src.cache;
    if (!fs.existsSync(file)) return 0;
    const db = openDb(file);
    const r = db.prepare(`SELECT COUNT(*) c FROM songs s ${BASE_WHERE}`).get();
    return r ? r.c : 0;
  } catch (e) { return 0; }
}

// muse.db 是否已就绪（本地路径看存在性；远程看缓存是否已下载过，不触发下载）
function available() {
  try {
    const src = resolveSource();
    if (!src) return false;
    if (src.local) return fs.existsSync(src.local);
    return fs.existsSync(src.cache);
  } catch (e) { return false; }
}

// 按歌曲编号同步反查歌名/歌手（曲库扫描用：/mv 里编号命名的 .ts 文件，
// 如 0123456.ts，入库时从这里拿到真实歌名/歌手而不是"未知歌手 - 0123456"）。
// 只用本地已就绪的 muse.db（配置路径/自动发现/已有缓存），绝不触发远程下载；
// 扫描器是同步流程，本函数必须保持同步。未就绪/查不到返回 null。
let _lookupDb = null, _lookupStmt = null, _lookupKey = '';
function lookupByNo(no) {
  try {
    const n = String(no || '').trim();
    if (!/^\d+$/.test(n)) return null;
    const src = resolveSource();
    if (!src) return null;
    const file = src.local || src.cache;
    if (!file || !fs.existsSync(file)) return null;
    const st = fs.statSync(file);
    const key = file + '|' + st.mtimeMs + '|' + st.size;
    if (!_lookupDb || _lookupKey !== key) {
      try { if (_lookupDb) _lookupDb.close(); } catch (e) {}
      _lookupDb = new Database(file, { readonly: true, fileMustExist: true });
      _lookupStmt = _lookupDb.prepare(
        `SELECT s.name AS name, ${SINGER_SUB} AS singer_names FROM songs s ` +
        'WHERE s.filename = ? AND s.deleted_at IS NULL LIMIT 1');
      _lookupKey = key;
    }
    const r = _lookupStmt.get(n + '.ts') || _lookupStmt.get(n + '.ls');
    if (!r) return null;
    const title = String(r.name || '').trim();
    const artist = String(r.singer_names || '').trim();
    if (!title && !artist) return null;
    return { title, artist };
  } catch (e) { return null; }
}

// ---------- ktv_api.js 实时换链 ----------
// Node 版 XMLHttpRequest shim：vendored ktv_api.js 的 httpGet/httpPost 用
function installXhrShim() {
  if (global.XMLHttpRequest) return;
  global.XMLHttpRequest = class {
    open(method, url) { this._method = method; this._url = url; }
    setRequestHeader() {}
    send(body) {
      const done = (r) => setTimeout(() => {
        if (r instanceof Error) { this.onerror && this.onerror(r); return; }
        this.status = r.s; this.responseText = r.b; this.onload && this.onload();
      }, 0);
      const mod = this._url.startsWith('https') ? https : http;
      const req = mod.request(this._url, {
        method: this._method,
        headers: { Accept: '*/*', 'User-Agent': 'Dalvik/2.1.0' },
        timeout: 15000,
      }, (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => done({ s: res.statusCode, b }));
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e) => done(e));
      if (body) req.write(body);
      req.end();
    }
  };
}

let _ktvApi = null;
let _apiJsLoaded = '';
// 热更 ktv_api.js（app 同款热更机制）：成功拉到新版写 DATA_DIR/ktv_api.js，
// 失败（断网/gitee 被墙）用上次缓存，再退回镜像内置 vendor-ktv-api.js
async function refreshKtvApiJs() {
  const cachePath = path.join(DATA_DIR, 'ktv_api.js');
  const freshEnough = fs.existsSync(cachePath) &&
    (Date.now() - fs.statSync(cachePath).mtimeMs) < KTV_API_REFRESH_MS;
  if (freshEnough) return cachePath;
  try {
    const body = await new Promise((resolve) => {
      const mod = KTV_API_REMOTE.startsWith('https') ? https : http;
      const req = mod.get(KTV_API_REMOTE, { timeout: 8000 }, (res) => {
        if (res.statusCode !== 200) { resolve(null); res.resume(); return; }
        let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve(b));
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(null));
    });
    if (body && body.includes('KtvApi')) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(cachePath, body);
    }
  } catch (e) { /* 热更失败不致命，用本地副本 */ }
  return fs.existsSync(cachePath) ? cachePath : path.join(__dirname, 'vendor-ktv-api.js');
}

async function getKtvApi() {
  const jsPath = await refreshKtvApiJs();
  installXhrShim();
  if (!_ktvApi || _apiJsLoaded !== jsPath + '|' + (fs.existsSync(jsPath) ? fs.statSync(jsPath).mtimeMs : 0)) {
    delete require.cache[require.resolve(jsPath)];
    const { KtvApi } = require(jsPath);
    _ktvApi = new KtvApi({ debug: false });
    _apiJsLoaded = jsPath + '|' + (fs.existsSync(jsPath) ? fs.statSync(jsPath).mtimeMs : 0);
  }
  return _ktvApi;
}

// 按歌曲编号实时换签名直链（返回 .ts）。cloud_url 会过期，禁止用库里的旧链接。
// 注意：部分节点对没有真源的歌会返回广告视频（如 ad_files/my_ad_video.ts）占位，
// 这里过滤广告直链并用 regenerateDevice 换设备/节点重试（节点路由与设备相关）。
async function resolveMuseUrl(no) {
  if (!no) throw new Error('缺少麦动歌曲编号');
  const api = await getKtvApi();
  const id = String(no);
  let last = '';
  for (let i = 0; i < 3; i++) {
    if (i > 0 && api.regenerateDevice) api.regenerateDevice();
    const url = await api.getSongUrl(id, '720', false);
    if (url && /^https?:\/\//i.test(url) && /\.ts(\?|$)/i.test(url) && !/ad[_-]?(files|video)|my_ad/i.test(url)) {
      return url;
    }
    last = url ? '接口返回了无效/广告直链' : '接口未返回直链';
  }
  throw new Error('换链失败（' + last + '，该歌曲可能暂无可用源）');
}

module.exports = {
  getMuseUrl, resolveSource, ensureMuseDb, available, songCount,
  allSongs, rankPlaylists, rankSongs, lookupByNo,
  resolveMuseUrl,
};
