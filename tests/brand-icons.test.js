// 回归测试：品牌图标（浏览器 favicon / Android 启动图标）。
//
// 背景：原来三端页面一个 favicon 都没有（浏览器显示默认地球图标），
// Android 端 manifest 里写的是系统默认图标 @android:drawable/sym_def_app_icon，
// 且工程里连 res/ 目录都不存在 —— 装到手机/盒子上是"白板"图标。
//
// 本测试守着四件事，防止以后有人改页面/改 manifest 时把图标引用删掉：
//   1. 服务器把 /assets 静态目录挂上、/favicon.ico 根路径可直达；
//   2. app/docker/web/assets 下的图标文件齐全且规格正确（ICO 三帧、PNG 尺寸）；
//   3. tv / mobile / admin 三个页面的 <head> 都引用了这些图标；
//   4. Android 的 mipmap / drawable 各密度图标齐全，manifest 指向正确。
//
// 跑法（仓库根目录）：
//   NODE_PATH='C:\Users\Administrator\.workbuddy\binaries\node\workspace\node_modules' \
//   node tests/brand-icons.test.js
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const SERVER_DIR = path.join(ROOT, 'app', 'docker', 'server');
const WEB_ASSETS = path.join(ROOT, 'app', 'docker', 'web', 'assets');
const ANDROID_RES = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');
const MANIFEST = path.join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');

// ---------- 起真实 server/index.js（只桩掉 express / ws / selfsigned）----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-'));
const media = path.join(tmp, 'mv');
fs.mkdirSync(media, { recursive: true });
process.env.DATA_DIR = tmp;
process.env.MV_DIR = media;
process.env.MP3_DIR = media;
process.env.PORT = '18098';
process.env.HTTPS_PORT = '18446';
process.env.SCAN_ON_START = '0';

const mounts = [];                  // app.use('/x', mw) 记录
const routes = { get: {}, post: {}, delete: {}, put: {} };
function makeApp() {
  const app = function () {};
  const rec = (m) => (p, ...h) => { routes[m][p] = h[h.length - 1]; return app; };
  app.get = rec('get'); app.post = rec('post'); app.delete = rec('delete'); app.put = rec('put');
  app.all = rec('get');
  app.use = (...args) => {
    if (typeof args[0] === 'string' && args.length >= 2) mounts.push({ mountPath: args[0], mw: args[1] });
    return app;
  };
  app.set = () => app; app.engine = () => app;
  app.listen = () => ({ close() {} });
  return app;
}
const express = function () { return makeApp(); };
// express.static(dir) 返回的中间件上挂 __dir，便于断言挂的是哪个目录
express.static = (dir) => { const mw = () => {}; mw.__dir = dir; return mw; };
express.json = () => (q, s, n) => { q.body = q.body || {}; n && n(); };
express.urlencoded = () => (q, s, n) => { q.body = q.body || {}; n && n(); };
express.raw = () => () => {}; express.text = () => () => {};
class WebSocketServer { constructor() { this.clients = new Set(); } on() {} close() {} }
const realLoad = Module._load;
Module._load = function (request) {
  if (request === 'express') return express;
  if (request === 'ws') return { WebSocketServer, WebSocket: class {} };
  if (request === 'selfsigned') return { generate: () => ({ private: 'x', cert: 'y' }) };
  // lxmusic.js 顶层依赖 iconv-lite（酷我接口的 GBK 解码）。托管 node 工作区里
  // 没装它，本测试也不碰歌词解码，桩成直通即可。
  if (request === 'iconv-lite') {
    return { decode: (b) => (Buffer.isBuffer(b) ? b.toString('utf8') : String(b)),
             encode: (s) => Buffer.from(String(s)) };
  }
  return realLoad.apply(this, arguments);
};
process.chdir(SERVER_DIR);
require(path.join(SERVER_DIR, 'index.js'));

// ------------------------------------------------------------------ 断言
let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? '  → ' + extra : ''}`); }
}
/** 从 PNG 头直接读尺寸（IHDR 宽高在固定偏移），避免引依赖 */
function pngSize(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}
function exists(p) { return fs.existsSync(p); }

console.log('\n[1] 服务器路由：/assets 静态目录 + /favicon.ico 根路径');
const assetsMount = mounts.find(m => m.mountPath === '/assets');
ok(!!assetsMount, "挂了 app.use('/assets', ...)");
ok(assetsMount && path.resolve(assetsMount.mw.__dir) === WEB_ASSETS,
  '/assets 指向 app/docker/web/assets', assetsMount ? assetsMount.mw.__dir : '(无)');
const favHandler = routes.get['/favicon.ico'];
ok(typeof favHandler === 'function', "注册了 GET /favicon.ico");
let sentFile = null;
if (favHandler) favHandler({}, { sendFile: (f) => { sentFile = f; } });
ok(!!sentFile && exists(sentFile) && path.basename(sentFile) === 'favicon.ico',
  '/favicon.ico 实际发出的文件存在', String(sentFile));

console.log('\n[2] web 图标文件规格 → app/docker/web/assets/');
const mustFiles = ['favicon.ico', 'favicon.svg', 'apple-touch-icon.png',
  'icon-192.png', 'icon-512.png', 'site.webmanifest'];
for (const f of mustFiles) ok(exists(path.join(WEB_ASSETS, f)), `存在 ${f}`);
ok(pngSize(path.join(WEB_ASSETS, 'apple-touch-icon.png'))?.w === 180, 'apple-touch-icon 是 180×180',
  JSON.stringify(pngSize(path.join(WEB_ASSETS, 'apple-touch-icon.png'))));
ok(pngSize(path.join(WEB_ASSETS, 'icon-192.png'))?.w === 192, 'icon-192 是 192×192');
ok(pngSize(path.join(WEB_ASSETS, 'icon-512.png'))?.w === 512, 'icon-512 是 512×512');
{
  const ico = fs.readFileSync(path.join(WEB_ASSETS, 'favicon.ico'));
  const type = ico.readUInt16LE(2), count = ico.readUInt16LE(4);
  ok(type === 1 && count === 3, 'favicon.ico 是图标类型且含 3 帧', `type=${type} count=${count}`);
  const frames = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    frames.push({ w: ico.readUInt8(o) || 256, off: ico.readUInt32LE(o + 12), len: ico.readUInt32LE(o + 8) });
  }
  ok(frames.map(f => f.w).join(',') === '16,32,48', 'ICO 帧尺寸为 16/32/48', frames.map(f => f.w).join(','));
  ok(frames.every(f => ico.slice(f.off, f.off + 8).toString('hex') === '89504e470d0a1a0a'),
    '每帧都是 PNG 载荷（现代浏览器可直接解码）');
  ok(frames.every(f => f.off + f.len <= ico.length), '各帧偏移+长度未越界');
}
{
  const svg = fs.readFileSync(path.join(WEB_ASSETS, 'favicon.svg'), 'utf8');
  ok(/stroke="#ffffff"/.test(svg) && /linearGradient/.test(svg), 'favicon.svg 含 K 描边与品牌渐变');
}
{
  const mf = JSON.parse(fs.readFileSync(path.join(WEB_ASSETS, 'site.webmanifest'), 'utf8'));
  ok(!!mf.name && Array.isArray(mf.icons) && mf.icons.length >= 2, 'webmanifest 名称与图标项齐全');
  ok(mf.icons.some(i => i.purpose === 'maskable'), 'webmanifest 含 maskable 图标（安卓桌面快捷方式用）');
  ok(!!mf.theme_color, 'webmanifest 有 theme_color');
}

console.log('\n[3] 三个端页面的 <head> 都引用图标');
for (const page of ['tv', 'mobile', 'admin']) {
  const html = fs.readFileSync(path.join(ROOT, 'app', 'docker', 'web', page, 'index.html'), 'utf8');
  const head = html.slice(0, html.indexOf('</head>'));
  ok(head.includes('rel="icon"') && head.includes('/assets/favicon.ico'), `${page}: rel=icon → favicon.ico`);
  ok(head.includes('/assets/favicon.svg'), `${page}: 引用 favicon.svg`);
  ok(head.includes('rel="apple-touch-icon"') && head.includes('/assets/apple-touch-icon.png'),
    `${page}: apple-touch-icon`);
  ok(head.includes('rel="manifest"') && head.includes('/assets/site.webmanifest'), `${page}: PWA manifest`);
}

console.log('\n[4] Android 启动图标资源 + manifest 指向');
{
  const mf = fs.readFileSync(MANIFEST, 'utf8');
  ok(/android:icon="@mipmap\/ic_launcher"/.test(mf), 'manifest android:icon 指向 @mipmap/ic_launcher');
  ok(/android:roundIcon="@mipmap\/ic_launcher_round"/.test(mf), 'manifest android:roundIcon 指向 @mipmap/ic_launcher_round');
  ok(!/@android:drawable\/sym_def_app_icon/.test(mf), '不再使用系统默认图标 sym_def_app_icon');
}
const LEGACY = [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]];
for (const [dpi, size] of LEGACY) {
  const a = path.join(ANDROID_RES, `mipmap-${dpi}`, 'ic_launcher.png');
  const b = path.join(ANDROID_RES, `mipmap-${dpi}`, 'ic_launcher_round.png');
  ok(pngSize(a)?.w === size, `mipmap-${dpi}/ic_launcher.png = ${size}px`, JSON.stringify(pngSize(a)));
  ok(pngSize(b)?.w === size, `mipmap-${dpi}/ic_launcher_round.png = ${size}px`);
}
const ADAPTIVE = [['mdpi', 108], ['hdpi', 162], ['xhdpi', 216], ['xxhdpi', 324], ['xxxhdpi', 432]];
for (const [dpi, size] of ADAPTIVE) {
  const bg = path.join(ANDROID_RES, `drawable-${dpi}`, 'ic_launcher_background.png');
  const fg = path.join(ANDROID_RES, `drawable-${dpi}`, 'ic_launcher_foreground.png');
  ok(pngSize(bg)?.w === size, `drawable-${dpi}/ic_launcher_background.png = ${size}px`, JSON.stringify(pngSize(bg)));
  ok(pngSize(fg)?.w === size, `drawable-${dpi}/ic_launcher_foreground.png = ${size}px`);
}
{
  const xml = fs.readFileSync(path.join(ANDROID_RES, 'mipmap-anydpi-v26', 'ic_launcher.xml'), 'utf8');
  ok(/<adaptive-icon/.test(xml), 'mipmap-anydpi-v26/ic_launcher.xml 是自适应图标');
  ok(xml.includes('@drawable/ic_launcher_background') && xml.includes('@drawable/ic_launcher_foreground'),
    '自适应图标引用了背景/前景 drawable');
  ok(/<monochrome/.test(xml), '含 Android 13 主题图标单色层');
  ok(exists(path.join(ANDROID_RES, 'mipmap-anydpi-v26', 'ic_launcher_round.xml')), '存在 ic_launcher_round.xml');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
