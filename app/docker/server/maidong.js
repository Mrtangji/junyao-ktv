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
// 下载入库复用 lxmusic 的链路：拉流 → sniffAudio 校验 → mp3 直存/转码、
// mp4 直存为 MV（其它容器 ffmpeg -c copy 尝试）→ /mv/歌手名/ → 扫描入库。

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const db = require('./db');
const { scanLibrary, MV_DIR } = require('./scanner');
const lx = require('./lxmusic');
const { httpReq, sniffAudio, moveFile, ffmpegToMp3, ffmpegMp3ToMv, downloadCover, sanitize, TMP_DIR } = lx.internals;

// ---------- 配置（存 settings 表，TV 页/下载共用） ----------
function getConfig() {
  const g = (k) => (db.prepare("SELECT value FROM settings WHERE key=?").get(k) || {}).value || '';
  return { catalogUrl: g('md_catalog_url'), apiBase: g('md_api_base') };
}
function setConfig({ catalogUrl, apiBase }) {
  const up = (k, v) => db.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(k, String(v || '').trim());
  if (catalogUrl !== undefined) up('md_catalog_url', catalogUrl);
  if (apiBase !== undefined) up('md_api_base', apiBase);
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

// 点歌榜分类（全部 + 各分类，按歌曲数降序）
async function boards() {
  const list = await loadCatalog();
  const cnt = {};
  list.forEach(s => { cnt[s.category] = (cnt[s.category] || 0) + 1; });
  const cats = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]);
  return [{ bangid: '__all__', name: '全部歌曲' }, ...cats.map(c => ({ bangid: 'cat_' + c, name: `${c}(${cnt[c]})` }))];
}

// 榜单列表：cat_前缀按分类过滤，__all__ 全部；q 模糊搜歌名/歌手
async function boardSongs(bangid, page = 1, limit = 100, q = '') {
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

// entry: {songmid,name,singer,url?,pic?,format:'mp3'|'mv'}
// url 为空时走 API 音源 resolve（quality: mv→mv，否则 320k）
async function downloadMd({ songmid, name, singer, url = null, pic = null, format = 'mp3' }) {
  if (!fs.existsSync(MV_DIR)) throw new Error('MV_DIR_UNAVAILABLE');
  const artist = sanitize(singer) || '未知歌手';
  const title = sanitize(name) || '未知歌名';
  const artistDir = path.join(MV_DIR, artist);
  if (!fs.existsSync(artistDir)) fs.mkdirSync(artistDir, { recursive: true });

  let srcUrl = url;
  if (!srcUrl) srcUrl = await apiResolve(songmid, format === 'mv' ? 'mv' : '320k');
  const looksVideo = VIDEO_EXT.test(srcUrl);

  // 目标文件：视频 → .mp4（MV）；音频 → .mp3
  const isVideo = looksVideo || format === 'mv' && !/\.(mp3|flac|ogg|m4a|wav|aac)(\?|$)/i.test(srcUrl);
  const ext = isVideo ? 'mp4' : 'mp3';
  const rel = path.join(artist, `${artist} - ${title}.${ext}`);
  const finalPath = path.join(MV_DIR, rel);
  const existed = db.prepare('SELECT * FROM songs WHERE filepath=?').get(rel.replace(/\\/g, '/'));
  if (existed) return existed;

  const tmpPath = path.join(TMP_DIR, `md_${Date.now()}_${process.pid}`);
  const resp = await httpReq(srcUrl, { responseType: 'buffer', timeout: 300000 });
  if (resp.statusCode !== 200) throw new Error(`下载失败 HTTP ${resp.statusCode}`);
  const sniff = sniffAudio(resp.body);
  if (sniff.kind === 'text') throw new Error(`麦动源返回的不是音频/视频（接口可能失效）：${sniff.detail}`);
  if (sniff.kind === 'm3u8') throw new Error('麦动源返回 HLS(m3u8) 播放列表，暂不支持直接下载');
  const bodyIsVideo = isVideo || sniff.kind === 'unknown' && looksVideo; // 视频魔数 sniff 不识别，按扩展名
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
  const row = db.prepare('SELECT * FROM songs WHERE filepath=?').get(rel.replace(/\\/g, '/'));
  if (!row) throw new Error('入库失败（扫描未识别到新文件）');
  return row;
}

module.exports = { getConfig, setConfig, boards, boardSongs, apiSearch, apiResolve, downloadMd };
