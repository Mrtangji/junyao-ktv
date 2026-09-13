// 回归测试：四平台榜单加 12s 超时兜底 + /api/lx/boards/health 连通性自检。
//
// 背景（真实故障）：TV 点唱榜里除麦动(md)外的 kw/wy/tx/kg 四平台榜单加载失败。
// 调查结论：代码本体与 PC 版 lx-music-desktop 逐行一致、完全正确；失败根因是
// 部署服务器到四平台外部接口（wbd.kuwo.cn / music.163.com / u.y.qq.com /
// mobilecdnbj.kugou.com）的网络不通/超时。本测试锁定两层防护：
//   · 平台接口失败/挂起时，/api/lx/board 必须在 12s 内返回“本站热门”兜底，
//     绝不让前端 fetch 超时成“榜单加载失败”；
//   · /api/lx/boards/health 从服务器侧实测四平台可达性，区分“网络问题 vs 代码问题”。
//
// 跑法（仓库根目录）：
//   NODE_PATH='C:\Users\Administrator\.workbuddy\binaries\node\workspace\node_modules' \
//   node tests/board-fallback.test.js
//
// 原理：真 require server/index.js，只把 express / ws / selfsigned 换成桩；
// boardsdk 用真实模块，仅替换 boardSongs 模拟“连得上 / 连不上”两种情形。
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const SERVER_DIR = path.join(__dirname, '..', 'app', 'docker', 'server');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boardfb-'));
const media = path.join(tmp, 'mv');
fs.mkdirSync(media, { recursive: true });
process.env.DATA_DIR = tmp;
process.env.MV_DIR = media;
process.env.MP3_DIR = media;
process.env.PORT = '18098';
process.env.HTTPS_PORT = '18446';
process.env.SCAN_ON_START = '0';

// ---------- 替身 ----------
const routes = { get: {}, post: {}, delete: {}, put: {} };
function makeApp() {
  const app = function () {};
  const rec = (m) => (p, ...h) => { routes[m][p] = h[h.length - 1]; return app; };
  app.get = rec('get'); app.post = rec('post'); app.delete = rec('delete'); app.put = rec('put');
  app.all = rec('get');
  app.use = () => app;
  app.set = () => app; app.engine = () => app;
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
Module._load = function (request) {
  if (request === 'express') return express;
  if (request === 'ws') return { WebSocketServer, WebSocket: class {} };
  if (request === 'selfsigned') return selfsigned;
  return realLoad.apply(this, arguments);
};

process.chdir(SERVER_DIR);
require(path.join(SERVER_DIR, 'index.js'));
const boardsdk = require(path.join(SERVER_DIR, 'boardsdk.js')); // 同一缓存实例，仅替换 boardSongs

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { (c ? pass++ : fail++); console.log(`${c ? '✓' : '✗'} ${n}${e ? ' — ' + e : ''}`); };
const mockRes = () => {
  const o = { _json: null, statusCode: 200, headersSent: false };
  o.json = (j) => { o._json = j; return o; };
  o.status = (c) => { o.statusCode = c; return o; };
  o.send = () => o; o.end = () => o;
  return o;
};

async function runBoard(src, stub) {
  const orig = boardsdk.boardSongs;
  boardsdk.boardSongs = stub;
  const res = mockRes();
  await routes.get['/api/lx/board']({ query: { src, bangid: '255', page: '1', limit: '3' } }, res);
  boardsdk.boardSongs = orig;
  return res._json;
}
async function runHealth(stub) {
  const orig = boardsdk.boardSongs;
  boardsdk.boardSongs = stub;
  const res = mockRes();
  await routes.get['/api/lx/boards/health']({}, res);
  boardsdk.boardSongs = orig;
  return res._json;
}

(async () => {
  console.log('=== A. /api/lx/board 直连成功 → 返回真实榜单 ===');
  {
    const fake = { list: [{ name: '晴天', singer: '周杰伦' }, { name: '七里香', singer: '周杰伦' }], total: 2, page: 1, limit: 100 };
    const r = await runBoard('kw', async () => fake);
    ok('返回对象且含 list 数组', !!r && Array.isArray(r.list), r && String(r.list && r.list.length));
    ok('list 经过本地标记处理（每项带 localMp3 字段）', !!r && r.list.every(x => 'localMp3' in x));
    ok('成功路径不标 fallback', !!r && r.fallback !== true);
  }

  console.log('=== B. /api/lx/board 平台接口失败 → 兜底本站热门（不再“加载失败”）===');
  {
    const r = await runBoard('wy', async () => { throw new Error('network unreachable'); });
    ok('兜底下返回对象', !!r);
    ok('标 fallback=true', !!r && r.fallback === true);
    ok('list 仍是数组（不挂起、不 502、不抛错）', !!r && Array.isArray(r.list));
    ok('兜底带可读原因 fallbackReason', !!r && typeof r.fallbackReason === 'string' && r.fallbackReason.length > 0);
  }

  console.log('=== C. 非 kw 源（tx/kg）失败也走同一兜底 ===');
  {
    const r = await runBoard('tx', async () => { throw new Error('timeout'); });
    ok('tx 失败也兜底', !!r && r.fallback === true && Array.isArray(r.list));
    const r2 = await runBoard('kg', async () => { throw new Error('timeout'); });
    ok('kg 失败也兜底', !!r2 && r2.fallback === true && Array.isArray(r2.list));
  }

  console.log('=== D. /api/lx/boards/health 连通性自检 ===');
  {
    const down = await runHealth(async () => { throw new Error('unreachable'); });
    ok('down：全部来源 ok=false（服务器侧不可达）', ['kw', 'wy', 'tx', 'kg'].every(s => down[s] && down[s].ok === false), JSON.stringify(Object.keys(down)));
    ok('down：健康端点带排查提示 _hint', !!down._hint);
    const up = await runHealth(async () => ({ list: [{ name: 'a', singer: 'b' }], total: 1, page: 1, limit: 3 }));
    ok('up：全部来源 ok=true（服务器侧可达）', ['kw', 'wy', 'tx', 'kg'].every(s => up[s] && up[s].ok === true));
    ok('up：ok=true 时回带 count', !!up.kw && typeof up.kw.count === 'number');
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
