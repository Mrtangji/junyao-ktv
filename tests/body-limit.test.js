// 回归测试：请求体上限 + 统一错误响应。
//
// 背景（真实故障）：把「歌手_按流行度.txt」这种一万三千行的歌手名单导入歌手批量下载时，
// 前端报 “启动失败：Unexpected token '<', "<!DOCTYPE "... is not valid JSON”。
// 真因是 express.json() 没设 limit，默认只收 100KB，而名单有 154KB → 服务端 413，
// 且 Express 默认 413 是 HTML 错误页 → 前端 .json() 拿到网页就炸，报错完全指错方向。
//
// 跑法（仓库根目录）：
//   NODE_PATH='C:\Users\Administrator\.workbuddy\binaries\node\workspace\node_modules' \
//   node tests/body-limit.test.js
//
// 原理：真 require server/index.js，只把 express / ws / selfsigned 换成桩；
// express 桩把 express.json 的配置和 4 参错误中间件都录下来，再直接调用断言。
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const SERVER_DIR = path.join(__dirname, '..', 'app', 'docker', 'server');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bodylimit-'));
const media = path.join(tmp, 'mv');
fs.mkdirSync(media, { recursive: true });
process.env.DATA_DIR = tmp;
process.env.MV_DIR = media;
process.env.MP3_DIR = media;
process.env.PORT = '18097';
process.env.HTTPS_PORT = '18445';
process.env.SCAN_ON_START = '0';

// ---------- 替身 ----------
const routes = { get: {}, post: {}, delete: {}, put: {} };
let jsonOptions = null;      // express.json(...) 的配置
let errorMw = null;          // 4 参错误中间件
function makeApp() {
  const app = function () {};
  const rec = (m) => (p, ...h) => { routes[m][p] = h[h.length - 1]; return app; };
  app.get = rec('get'); app.post = rec('post'); app.delete = rec('delete'); app.put = rec('put');
  app.all = rec('get');
  app.use = (...args) => {
    const fn = args[args.length - 1];
    // 错误中间件特征：4 个形参（err, req, res, next）
    if (typeof fn === 'function' && fn.length === 4) errorMw = fn;
    return app;
  };
  app.set = () => app; app.engine = () => app;
  app.listen = () => ({ close() {} });
  return app;
}
const express = function () { return makeApp(); };
const noopMw = () => (q, s, n) => n && n();
express.static = noopMw;
express.json = (o) => { jsonOptions = o || {}; return (q, s, n) => { q.body = q.body || {}; n && n(); }; };
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

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { (c ? pass++ : fail++); console.log(`${c ? '✓' : '✗'} ${n}${e ? ' — ' + e : ''}`); };
const mockRes = () => ({
  _json: null, _status: 200, headersSent: false,
  json(o) { this._json = o; return this; },
  status(c) { this._status = c; return this; },
  send() { return this; }, end() { return this; },
});

// "8mb" → 字节数
function parseLimit(s) {
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i);
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  const unit = (m[2] || 'b').toLowerCase();
  return n * ({ b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[unit]);
}

console.log('=== A. 请求体上限要放得下歌手名单 ===');
{
  ok('express.json() 传了 limit 配置', !!jsonOptions && jsonOptions.limit != null, JSON.stringify(jsonOptions));
  const bytes = parseLimit(jsonOptions && jsonOptions.limit);
  ok('limit 可解析且 ≥ 2MB', bytes >= 2 * 1024 * 1024, `${jsonOptions && jsonOptions.limit} = ${bytes} 字节`);
  // 实测名单：13026 行 / 154745 字节
  const listFile = 'D:/WorkBuddy/outputs/歌手_按流行度.txt';
  let size = 0;
  try { size = fs.statSync(listFile).size; } catch (e) { size = 154745; }
  ok('能装下实测的 13026 行名单（154KB）', bytes > size, `limit ${Math.round(bytes / 1024)}KB > 名单 ${Math.round(size / 1024)}KB`);
  ok('默认的 100KB 确实装不下（说明这个 bug 的成因）', size > 100 * 1024, `${Math.round(size / 1024)}KB > 100KB`);
}

console.log('=== B. 统一错误中间件：把 HTML 错误页换成 JSON ===');
{
  ok('4 参错误中间件已注册', typeof errorMw === 'function');

  // 1) 请求体过大（本次故障的真实场景）
  {
    const req = { method: 'POST', originalUrl: '/api/singer-batch/start' };
    const res = mockRes();
    let nextCalled = false;
    errorMw(Object.assign(new Error('request entity too large'), { type: 'entity.too.large', status: 413 }), req, res, () => { nextCalled = true; });
    ok('413：返回 JSON 而不是 HTML', res._status === 413 && !!res._json && typeof res._json.error === 'string', JSON.stringify(res._json));
    ok('413：错误文案说明是"请求体过大"并给出建议', /请求体过大/.test(res._json.error || '') && /拆成几批|分批/.test(res._json.error || ''), res._json.error);
    ok('413：不再走 next（不会落到 HTML 兜底页）', nextCalled === false);
  }

  // 2) JSON 格式错误
  {
    const res = mockRes();
    errorMw(Object.assign(new SyntaxError('Unexpected token } in JSON'), { type: 'entity.parse.failed', body: '{' }), { method: 'POST', originalUrl: '/api/x' }, res, () => {});
    ok('400：请求体不是合法 JSON', res._status === 400 && /合法 JSON/.test(res._json.error || ''), JSON.stringify(res._json));
  }

  // 3) 其它未预期错误
  {
    const res = mockRes();
    errorMw(new Error('内部炸了'), { method: 'GET', originalUrl: '/api/y' }, res, () => {});
    ok('500：兜底也返回 JSON', res._status === 500 && res._json.error === '内部炸了', JSON.stringify(res._json));
  }

  // 4) 响应已经开始发送时不能再改，交给 next
  {
    const res = mockRes();
    res.headersSent = true;
    let nextCalled = false;
    errorMw(new Error('晚到的错误'), { method: 'GET', originalUrl: '/api/z' }, res, () => { nextCalled = true; });
    ok('headersSent 时交给 next，不重复写响应', nextCalled === true && res._json === null);
  }
}

console.log('=== C. 前端能把这三种响应显示成人话 ===');
{
  // 模拟前端 admin 页面里的 Response.json 包装逻辑（与页面内实现同源）
  const wrap = (txt, status, url) => {
    try { return JSON.parse(txt); }
    catch (e) {
      const isHtml = /^\s*<(?:!doctype|html)/i.test(txt);
      if (isHtml) return { __err: `服务端没返回 JSON（HTTP ${status}${url ? ' · ' + url : ''}）：拿到的是网页而不是数据` };
      return { __err: `响应内容：${txt.slice(0, 40)}` };
    }
  };
  const htmlPage = wrap('<!DOCTYPE html><html><body>PayloadTooLargeError</body></html>', 413, '/api/x');
  ok('HTML 错误页被识别成"拿到的是网页"', /拿到的是网页/.test(htmlPage.__err || ''), htmlPage.__err);
  const json413 = wrap(JSON.stringify({ error: '请求体过大（上限 8mb）：名单太长了一次提交不下，请拆成几批分别导入' }), 413, '/api/x');
  ok('服务端改成 JSON 后，前端能直接显示原始原因', /请求体过大/.test(json413.error || ''), json413.error);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
