// 麦动 KTV 点歌系统接入（maidong-ktv，gitee.com/yangyachao-X/maidong-ktv）
//
// 两种数据源，均可在设置面板配置，点歌榜来源可切换 酷我/麦动：
//  1) 网络曲库 catalog.json（maidong 现有机制，数组 [{id,title,singer,category,url}]，
//     url 直链 mp4/mp3，见 maidong 仓库 catalog.sample.json）
//  2) API 音源服务（maidong docs/音源导入集成设计.md 约定）：
//     GET {base}/search?q=<关键词>&page=<页码>
//       → {"songs":[{id,title,singer,album,pic}]}（兼容直接返回数组）
//     GET {base}/resolve?id=<歌曲id>&quality=<mv|320k|...>
//       → {"url":"..."} （兼容 {"data":{"url":..}} / 纯字符串）
//
// 下载入库复用 lxmusic 的链路：拉流 → sniffAudio 校验 → mp3 直存/转码（存
// MP3_DIR，env MP3_DIR，默认同 MV_DIR）、mp4 直存为 MV（存 MV_DIR，其它容器
// ffmpeg -c copy 尝试）→ 扫描入库。

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const db = require('./db');
const { scanLibrary } = require('./scanner');
const dlcfg = require('./dlconfig');
const muse = require('./muse');
const log = require('./logger');
const lx = require('./lxmusic');
const { httpReq, sniffAudio, moveFile, ffmpegToMp3, ffmpegMp3ToMv, downloadCover, sanitize, TMP_DIR } = lx.internals;

// ---------- 配置（存 settings 表，TV 页/下载共用） ----------
function getConfig() {
  const g = (k) => (db.prepare("SELECT value FROM settings WHERE key=?").get(k) || {}).value || '';
  return { catalogUrl: g('md_catalog_url'), apiBase: g('md_api_base'), museUrl: g('md_muse_url') };
}
function setConfig({ catalogUrl, apiBase, museUrl }) {
  const up = (k, v) => db.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(k, String(v || '').trim());
  if (catalogUrl !== undefined) up('md_catalog_url', catalogUrl);
  if (apiBase !== undefined) up('md_api_base', apiBase);
  if (museUrl !== undefined) {
    up('md_muse_url', museUrl);
    // muse.db 地址变更：后台强制拉取/校验一次，失败不影响保存（可用旧缓存）
    if (String(museUrl || '').trim()) {
      muse.ensureMuseDb(true).then(() => log.info('MUSE', 'muse.db 就绪')).catch((e) => log.error('MUSE', 'muse.db 获取失败: ' + e.message));
    }
  }
  catalogCache = null; // 地址变了清缓存
  return getConfig();
}

// ---------- 网络曲库 catalog ----------
let catalogCache = null; // { url, at, list }
async function loadCatalog() {
  const { catalogUrl } = getConfig();
  if (!catalogUrl) throw new Error('未配置麦动曲库地址（设置 → 麦动点歌）');
  if (catalogCache && catalogCache.url === catalogUrl && Date.now() - catalogCache.at < 5 * 60 * 1000) return catalogCache.list;
  const resp = await httpReq(catalogUrl, { timeout: 30000 });
  if (resp.statusCode !== 200) throw new Error(`曲库地址 HTTP ${resp.statusCode}`);
  const raw = typeof resp.body === 'string' ? resp.body : resp.body.toString('utf8');
  let arr;
  try { arr = JSON.parse(raw); } catch (e) { throw new Error('曲库地址返回的不是 JSON 数组'); }
  if (!Array.isArray(arr)) throw new Error('曲库格式应为数组 [{id,title,singer,category,url}]');
  const list = arr.map((it, i) => ({
    songmid: String(it.id != null ? it.id : i),
    name: String(it.title || it.name || '').trim(),
    singer: String(it.singer || it.artist || '').trim(),
    category: String(it.category || '').trim() || '未分类',
    url: String(it.url || '').trim(),
  })).filter(s => s.name && s.url);
  catalogCache = { url: catalogUrl, at: Date.now(), list };
  return list;
}

// 点歌榜分类（双源：muse.db 曲库+排行榜 与 catalog.json 分类可同时启用）
// bangid 命名空间：muse_all / muse_rank_<歌单id>（muse.db 源）；cat_<分类>/__all__（catalog 源）
async function boards() {
  const out = [];
  const errors = [];
  // 自动发现（/data/muse.db → 镜像内置）也算就绪，不强制要求填配置
  if (muse.available()) {
    try {
      out.push({ bangid: 'muse_all', name: '全部歌曲' });
      out.push(...await muse.rankPlaylists());
    } catch (e) { errors.push('muse: ' + e.message); }
  }
  if (getConfig().catalogUrl) {
    try {
      const list = await loadCatalog();
      const cnt = {};
      list.forEach(s => { cnt[s.category] = (cnt[s.category] || 0) + 1; });
      const cats = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]);
      out.push({ bangid: '__all__', name: '全部歌曲' });
      cats.forEach(c => out.push({ bangid: 'cat_' + c, name: `${c}(${cnt[c]})` }));
    } catch (e) { errors.push('catalog: ' + e.message); }
  }
  if (!out.length) {
    throw new Error(errors.length ? errors.join('；') : '未配置麦动曲库地址（设置 → 麦动点歌）');
  }
  return out;
}

// 榜单列表：按 bangid 前缀分流到对应源；q 模糊搜歌名/歌手
async function boardSongs(bangid, page = 1, limit = 100, q = '') {
  if (bangid === 'muse_all') return muse.allSongs({ q, page, limit });
  if (/^muse_rank_/.test(bangid)) return muse.rankSongs(bangid.replace(/^muse_rank_/, ''), page, limit);
  let list = await loadCatalog();
  if (bangid && bangid !== '__all__') {
    const cat = String(bangid).replace(/^cat_/, '');
    list = list.filter(s => s.category === cat);
  }
  const kw = String(q || '').trim().toLowerCase();
  if (kw) list = list.filter(s => s.name.toLowerCase().includes(kw) || s.singer.toLowerCase().includes(kw));
  const total = list.length;
  const start = (Math.max(1, page) - 1) * limit;
  return { list: list.slice(start, start + limit), total, page: Math.max(1, page), limit };
}

// ---------- API 音源服务 ----------
async function apiSearch(q, page = 1) {
  const { apiBase } = getConfig();
  if (!apiBase) throw new Error('未配置麦动 API 音源地址（设置 → 麦动点歌）');
  const base = apiBase.replace(/\/+$/, '');
  const resp = await httpReq(`${base}/search?q=${encodeURIComponent(q)}&page=${page}`, { timeout: 30000 });
  if (resp.statusCode !== 200) throw new Error(`音源服务 HTTP ${resp.statusCode}`);
  let data = resp.body;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) {} }
  let songs = Array.isArray(data) ? data : (data && (data.songs || data.list || data.data)) || [];
  return {
    list: songs.map((s, i) => ({
      songmid: String(s.id != null ? s.id : s.songmid != null ? s.songmid : i),
      name: String(s.title || s.name || '').trim(),
      singer: String(s.singer || s.artist || '').trim(),
      album: String(s.album || '').trim(),
      pic: s.pic || s.cover || null,
    })).filter(s => s.name),
    total: songs.length, page, limit: songs.length,
  };
}

async function apiResolve(id, quality) {
  const { apiBase } = getConfig();
  const base = apiBase.replace(/\/+$/, '');
  const resp = await httpReq(`${base}/resolve?id=${encodeURIComponent(id)}&quality=${encodeURIComponent(quality)}`, { timeout: 60000 });
  if (resp.statusCode !== 200) throw new Error(`音源服务解析 HTTP ${resp.statusCode}`);
  let data = resp.body;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) {} }
  if (typeof data === 'string' && /^https?:/.test(data)) return data;
  const url = (data && data.url) || (data && data.data && (data.data.url || data.data)) || null;
  if (!url || !/^https?:/.test(String(url))) throw new Error('音源服务未返回有效直链');
  return String(url);
}

// ---------- 下载入库（复用 lxmusic 链路） ----------
const VIDEO_EXT = /\.(mp4|mkv|flv|mov|avi|webm|ts)(\?|$)/i;

function ffmpegRemuxToMp4(src, dst) {
  return new Promise((resolve, reject) => {
    // 优先流复制（快、无损）；容器/编码不兼容时失败，由调用方回退转码或报错
    const p = spawn('ffmpeg', ['-y', '-i', src, '-c', 'copy', '-movflags', '+faststart', dst]);
    let err = '';
    p.stderr.on('data', c => { err += c; if (err.length > 8000) err = err.slice(-4000); });
    p.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg 合成失败: ' + err.split('\n').slice(-3).join(' '))));
    p.on('error', reject);
  });
}

// entry: {songmid,name,singer,url?,pic?,format:'mp3'|'mv',src?:'muse'}
// src='muse'：url 为空时按歌曲编号走 ktv_api.js 实时换链（ts 签名直链会过期，
// 不能复用旧链接）；其余来源 url 为空时走 API 音源 resolve（quality: mv→mv，否则 320k）
async function downloadMd({ songmid, name, singer, url = null, pic = null, format = 'mp3', src = '' }) {
  // 下载目录分流（见 dlconfig.js）：MP3 → MP3_DIR（env，如 /mp3），MV(.mp4) → MV_DIR
  const mp3Root = dlcfg.getMp3Dir();
  const mvRoot = path.resolve(dlcfg.MV_DIR);
  const isVideoTarget = format === 'mv';
  const dlRoot = isVideoTarget ? mvRoot : mp3Root;
  if (!fs.existsSync(dlRoot) || !fs.existsSync(isVideoTarget ? mp3Root : mvRoot)) throw new Error('MV_DIR_UNAVAILABLE');
  const artist = sanitize(singer) || '未知歌手';
  const title = sanitize(name) || '未知歌名';
  const artistDir = path.join(dlRoot, artist);
  if (!fs.existsSync(artistDir)) fs.mkdirSync(artistDir, { recursive: true });
  if (!isVideoTarget && mp3Root !== mvRoot) {
    const d = path.join(mvRoot, artist); // 反向也预建，避免视频直链转存时目录缺失
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }

  let srcUrl = url;
  if (!srcUrl && src === 'muse') srcUrl = await muse.resolveMuseUrl(String(songmid));
  if (!srcUrl) srcUrl = await apiResolve(songmid, isVideoTarget ? 'mv' : '320k');
  const looksVideo = VIDEO_EXT.test(srcUrl);

  // 目标文件：MV 模式且不是纯音频直链 → .mp4（MV_DIR）；其余（含"下载格式=MP3
  // 但拿到 ts/mp4 视频"的情况，如麦动源只有 ts）→ 抽音频转 .mp3（MP3_DIR）
  const isVideo = isVideoTarget && !/\.(mp3|flac|ogg|m4a|wav|aac)(\?|$)/i.test(srcUrl);
  const ext = isVideo ? 'mp4' : 'mp3';
  const targetRoot = isVideo ? mvRoot : mp3Root;
  const rel = path.join(artist, `${artist} - ${title}.${ext}`);
  const finalPath = path.join(targetRoot, rel);
  // 按 filename（相对路径唯一键）查重——filepath 存的是绝对路径，用它查永远查不到
  const key = rel.replace(/\\/g, '/');
  const existed = db.prepare('SELECT * FROM songs WHERE filename=?').get(key);
  if (existed) return existed;

  const tmpPath = path.join(TMP_DIR, `md_${Date.now()}_${process.pid}`);
  const resp = await httpReq(srcUrl, { responseType: 'buffer', timeout: 300000 });
  if (resp.statusCode !== 200) throw new Error(`下载失败 HTTP ${resp.statusCode}`);
  const sniff = sniffAudio(resp.body);
  if (sniff.kind === 'text') throw new Error(`麦动源返回的不是音频/视频（接口可能失效）：${sniff.detail}`);
  if (sniff.kind === 'm3u8') throw new Error('麦动源返回 HLS(m3u8) 播放列表，暂不支持直接下载');
  // 内容分流按"目标格式"为准：MV 模式下 ts/mp4 等视频容器走视频分支（sniff 不
  // 识别 ts 魔数，按扩展名判）；MP3 模式即使拿到 ts/mp4 也抽音频转 mp3
  const bodyIsVideo = isVideoTarget && (isVideo || sniff.kind === 'unknown' && looksVideo);
  fs.writeFileSync(tmpPath, resp.body);
  try {
    if (!bodyIsVideo) {
      const isMp3 = sniff.kind === 'mp3';
      if (isMp3) moveFile(tmpPath, finalPath);
      else await ffmpegToMp3(tmpPath, finalPath);
    } else if (/\.mp4(\?|$)/i.test(srcUrl)) {
      moveFile(tmpPath, finalPath); // mp4 直存
    } else {
      await ffmpegRemuxToMp4(tmpPath, finalPath); // 其它容器尝试流复制转 mp4
    }
  } catch (e) { try { fs.unlinkSync(finalPath); } catch (e2) {} try { fs.unlinkSync(tmpPath); } catch (e3) {} throw e; }
  try { fs.unlinkSync(tmpPath); } catch (e) {}

  await scanLibrary();
  const row = db.prepare('SELECT * FROM songs WHERE filename=?').get(key);
  if (!row) throw new Error('入库失败（扫描未识别到新文件）');
  return row;
}

module.exports = { getConfig, setConfig, boards, boardSongs, apiSearch, apiResolve, downloadMd };
