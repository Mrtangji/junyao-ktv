// 回归测试：老旧内核兼容层 /stream/:id?transcode=mp3
//
// 跑法（仓库根目录）：
//   NODE_PATH='C:\Users\Administrator\.workbuddy\binaries\node\workspace\node_modules' \
//   node tests/stream-transcode.test.js
//
// 原理：真实 require server/index.js（express/ws/selfsigned 换极简桩），用 ffmpeg 现场生成
// 一首单音轨 FLAC 和一首双音轨 FLAC，插进真实 SQLite，再直接调 /stream/:id 处理器，断言：
//   1) 不带 transcode 时 FLAC 仍按原格式直传（回归：无损保真路径没被改坏）
//   2) ?transcode=mp3 时实时转码成 audio/mpeg（旧 WebView 能出声的关键）
//   3) ?transcode=mp3&track=1 能选中第二条音轨（原/伴唱"换流重载"切换）
//   4) 转码结果落磁盘缓存(compat/<id>.mp3 / <id>.t1.mp3)，第二次请求走缓存
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const Module = require('module');
const { Writable } = require('stream');

const SERVER_DIR = path.join(__dirname, '..', 'app', 'docker', 'server');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strm-'));
const media = path.join(tmp, 'mv');
fs.mkdirSync(media, { recursive: true });
process.env.DATA_DIR = tmp;
process.env.MV_DIR = media;
process.env.MP3_DIR = media;
process.env.PORT = '18101';
process.env.HTTPS_PORT = '18445';
process.env.SCAN_ON_START = '0';

// ---------- 替身：express / ws / selfsigned ----------
const routes = { get: {}, post: {}, delete: {}, put: {} };
function makeApp() {
  const app = function () {};
  const rec = (m) => (p, ...h) => { routes[m][p] = h[h.length - 1]; return app; };
  app.get = rec('get'); app.post = rec('post'); app.delete = rec('delete'); app.put = rec('put');
  app.all = rec('get');
  app.use = () => app; app.set = () => app; app.engine = () => app;
  app.listen = () => ({ close() {} });
  return app;
}
const express = function () { return makeApp(); };
const noopMw = () => (q, s, n) => n && n();
express.static = noopMw;
express.json = () => (q, s, n) => { q.body = q.body || {}; n && n(); };
express.urlencoded = () => (q, s, n) => { q.body = q.body || {}; n && n(); };
express.raw = noopMw; express.text = noopMw;
class WebSocketServer { constructor() { this.clients = new Set(); } on() {} close() {} }
const selfsigned = { generate: () => ({ private: 'x', cert: 'y' }) };

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'express') return express;
  if (request === 'ws') return { WebSocketServer, WebSocket: class {} };
  if (request === 'selfsigned') return selfsigned;
  return realLoad.apply(this, arguments);
};

process.chdir(SERVER_DIR);
require(path.join(SERVER_DIR, 'index.js'));
const db = require(path.join(SERVER_DIR, 'db'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`); };

// 生成测试音频：单音轨 FLAC（无损，验证原生直传 vs 转码）+ 双音轨 M4A（FLAC 容器只支持
// 单音轨，多音轨必须用 MP4/M4A 容器；服务端转码分支只看 audio_tracks 字段，不看扩展名）
const singleFlac = path.join(media, 'single.flac');
const twoM4a = path.join(media, 'two.m4a');
cp.execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '1', '-c:a', 'flac', singleFlac], { stdio: 'ignore' });
cp.execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '1', '-map', '0', '-map', '1', '-c:a', 'aac', twoM4a], { stdio: 'ignore' });

const ins1 = db.prepare('INSERT INTO songs (title,artist,filename,filepath,media_type) VALUES (?,?,?,?,?)');
ins1.run('无损歌', '歌手A', '歌手A/无损歌.flac', singleFlac, 'audio');
const SINGLE_ID = db.prepare('SELECT last_insert_rowid() AS id').get().id;
const ins2 = db.prepare('INSERT INTO songs (title,artist,filename,filepath,media_type,audio_tracks) VALUES (?,?,?,?,?,?)');
ins2.run('双轨歌', '歌手B', '歌手B/双轨歌.m4a', twoM4a, 'audio', 2);
const TWO_ID = db.prepare('SELECT last_insert_rowid() AS id').get().id;

// 捕获式响应：既是可写流(承接 ffmpeg pipe)，又记录 writeHead 状态/头
function mockStreamRes() {
  const chunks = [];
  let status = 200, headers = null;
  const w = new Writable({ write(c, enc, cb) { chunks.push(c); cb(); } });
  w.writeHead = (s, h) => { status = s; headers = h; };
  w._status = () => status;
  w._headers = () => headers;
  w._buf = () => Buffer.concat(chunks);
  return w;
}
function callStream(id, query) {
  const h = routes.get['/stream/:id'];
  if (!h) throw new Error('未注册 /stream/:id');
  const res = mockStreamRes();
  const req = { params: { id: String(id) }, query: query || {}, headers: {} };
  h(req, res);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('转码超时')), 15000);
    res.on('finish', () => { clearTimeout(t); resolve(res); });
    res.on('close', () => { /* 可能由 handler 的 res.on('close') 触发，不等 */ });
    res.on('error', reject);
  });
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function waitForFile(p, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (fs.existsSync(p) && fs.statSync(p).size > 0) return true; } catch (e) {}
    await new Promise(r => setTimeout(r, 50));
  }
  try { return fs.existsSync(p) && fs.statSync(p).size > 0; } catch (e) { return false; }
}

(async () => {
  console.log('=== 0. 回归：无损 FLAC 不带 transcode 仍按原格式直传（无损保真路径未被改坏）===');
  {
    const res = await callStream(SINGLE_ID, {});
    ok('状态码 200', res._status() === 200, 'status=' + res._status());
    ok('Content-Type 仍为 audio/flac', res._headers() && res._headers()['Content-Type'] === 'audio/flac',
      JSON.stringify(res._headers() && res._headers()['Content-Type']));
  }

  console.log('=== 1. ?transcode=mp3：单音轨 FLAC 实时转码成 MP3 ===');
  {
    const res = await callStream(SINGLE_ID, { transcode: 'mp3' });
    ok('状态码 200', res._status() === 200, 'status=' + res._status());
    ok('Content-Type = audio/mpeg', res._headers() && res._headers()['Content-Type'] === 'audio/mpeg',
      JSON.stringify(res._headers() && res._headers()['Content-Type']));
    ok('Accept-Ranges = none（实时转码无法拖进度）', res._headers() && res._headers()['Accept-Ranges'] === 'none',
      JSON.stringify(res._headers() && res._headers()['Accept-Ranges']));
    const buf = res._buf();
    ok('返回了非空 MP3 数据', buf.length > 100, 'bytes=' + buf.length);
    ok('输出为合法 MP3（ID3v2 标签或 MP3 帧同步 0xFF）', (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) || buf[0] === 0xFF, '0x' + (buf[0] || 0).toString(16));
    const cache = path.join(tmp, 'compat', `${SINGLE_ID}.mp3`);
    ok('转码结果已落缓存 compat/<id>.mp3', await waitForFile(cache), 'cache=' + cache);

    // 第二次请求同一首：应直接走缓存（不必再起 ffmpeg）。验证缓存文件可被正常读流。
    await wait(50);
    const res2 = await callStream(SINGLE_ID, { transcode: 'mp3' });
    ok('二次请求仍返回 audio/mpeg', res2._headers() && res2._headers()['Content-Type'] === 'audio/mpeg');
    ok('二次请求支持 Range（缓存可寻址）', res2._headers() && res2._headers()['Accept-Ranges'] === 'bytes');
  }

  console.log('=== 2. ?transcode=mp3&track=1：双音轨 FLAC 选第二条音轨 ===');
  {
    const res = await callStream(TWO_ID, { transcode: 'mp3', track: '1' });
    await wait(400); // 等 ffmpeg 关闭 + 缓存落盘
    ok('状态码 200', res._status() === 200, 'status=' + res._status());
    ok('Content-Type = audio/mpeg', res._headers() && res._headers()['Content-Type'] === 'audio/mpeg');
    const buf = res._buf();
    ok('返回了非空 MP3 数据', buf.length > 100, 'bytes=' + buf.length);
    ok('输出为合法 MP3（ID3v2 标签或 MP3 帧同步 0xFF）', (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) || buf[0] === 0xFF, '0x' + (buf[0] || 0).toString(16));
    const cache = path.join(tmp, 'compat', `${TWO_ID}.t1.mp3`);
    ok('音轨选择缓存为独立文件 compat/<id>.t1.mp3', await waitForFile(cache), 'cache=' + cache);
    ok('默认音轨缓存 compat/<id>.mp3 与选轨缓存不同（互不污染）',
      !fs.existsSync(path.join(tmp, 'compat', `${TWO_ID}.mp3`)));
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常', e); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} process.exit(1); });
