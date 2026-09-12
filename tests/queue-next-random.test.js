// 回归测试：首页无播放列表时点切歌 → 随机播一首（/api/queue/next）。
//
// 跑法（仓库根目录）：
//   NODE_PATH='C:\Users\Administrator\.workbuddy\binaries\node\workspace\node_modules' \
//   node tests/queue-next-random.test.js
//
// 原理：真实 require server/index.js——只把 express / ws / selfsigned 三个包换成极简桩
// （本地没装 server 的 node_modules），其余模块与 SQLite 都是真的；express 桩成"记录路由"
// 的壳，然后直接调用它注册的 /api/queue/next 处理器，断言 SQLite 里的队列状态。
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const SERVER_DIR = path.join(__dirname, '..', 'app', 'docker', 'server');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qnext-'));
const media = path.join(tmp, 'mv');
fs.mkdirSync(media, { recursive: true });
process.env.DATA_DIR = tmp;
process.env.MV_DIR = media;
process.env.MP3_DIR = media;
process.env.PORT = '18099';
process.env.HTTPS_PORT = '18443';
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

function mockRes() {
  return {
    _json: null, _status: 200,
    json(o) { this._json = o; return this; },
    status(c) { this._status = c; return this; },
    send() { return this; }, end() { return this; },
  };
}
function callNext() {
  const h = routes.post['/api/queue/next'];
  if (!h) throw new Error('未注册 /api/queue/next');
  const res = mockRes();
  h({ body: {} }, res);
  return res._json;
}
function callOrder(songId, nickname) {
  const h = routes.post['/api/queue'];
  const res = mockRes();
  h({ body: { song_id: songId, nickname } }, res);
  return res._json;
}
const rows = (sql, ...a) => db.prepare(sql).all(...a);

const ins = db.prepare('INSERT INTO songs (title,artist,filename,filepath,media_type) VALUES (?,?,?,?,?)');
for (let i = 1; i <= 5; i++) ins.run('歌' + i, '歌手' + i, `歌手${i}/歌手${i} - 歌${i}.mp3`, path.join(media, `x${i}.mp3`), 'audio');
const IDS = rows('SELECT id FROM songs ORDER BY id').map(r => r.id);

(async () => {
  console.log('=== A. 队列全空（首页无播放列表）点切歌 → 随机播一首 ===');
  {
    const r = callNext();
    ok('返回 random=true 且带歌名（前端可提示）', r && r.random === true && !!r.title, JSON.stringify(r));
    const q = rows("SELECT * FROM queue WHERE status!='done'");
    ok('队列里出现 1 首「随机播放」且状态为 playing', q.length === 1 && q[0].status === 'playing' && q[0].nickname === '随机播放', JSON.stringify(q));
    const pc = db.prepare('SELECT play_count AS c FROM songs WHERE id=?').get(q[0].song_id);
    ok('随机播放不计 play_count（不搅乱热门榜）', pc.c === 0, `play_count=${pc.c}`);
    ok('未写 history（还没播完）', rows('SELECT * FROM history').length === 0);
  }

  console.log('=== C. 有队列时行为不变：切下一首，不随机 ===');
  {
    db.prepare('DELETE FROM queue').run();
    db.prepare('DELETE FROM history').run();
    callOrder(IDS[0], 'TV点歌');
    callOrder(IDS[1], 'TV点歌');
    const r = callNext();
    const q = rows("SELECT song_id,status FROM queue WHERE status!='done'");
    ok('不返回 random', !r.random, JSON.stringify(r));
    ok('第一首标记 done、第二首变为 playing', q.length === 1 && q[0].song_id === IDS[1] && q[0].status === 'playing', JSON.stringify(q));
    ok('切走的那首写入 history', rows('SELECT * FROM history WHERE song_id=?', IDS[0]).length === 1);
    const r2 = callNext();   // 手动队列已被切空，这一次仍按"手动切歌"语义 → 不随机
    ok('手动队列切空后再按不随机', r2.ok === true && !r2.random, JSON.stringify(r2));
    const r3 = callNext();
    ok('再按一次（此时队列全空）→ 随机播一首', r3.random === true && r3.song_id !== IDS[1], JSON.stringify(r3));
  }

  console.log('=== D. 随机时避开最近播过的歌 ===');
  {
    db.prepare('DELETE FROM queue').run();
    db.prepare('DELETE FROM history').run();
    for (let i = 0; i < 20; i++) db.prepare('INSERT INTO history (song_id,nickname) VALUES (?,?)').run(IDS[0], 'x');
    // 5 首歌时 offset = floor(r*5)：0 → 第 1 首(最近播过，应重抽)；0.5 → 第 3 首
    const seq = [0, 0.5];
    const orig = Math.random;
    Math.random = () => (seq.length ? seq.shift() : 0.5);
    let picked;
    try { picked = callNext(); } finally { Math.random = orig; }
    ok('第一次抽到最近播过的会自动重抽', picked && picked.song_id === IDS[2], JSON.stringify(picked) + ` (期望 id=${IDS[2]})`);
  }

  console.log('=== E. 随机播放的歌遇到手动点歌要让位（与「首页自动播放」一致）===');
  {
    db.prepare('DELETE FROM queue').run();
    db.prepare('DELETE FROM history').run();
    const r = callNext();
    ok('先随机播一首', r.random === true, JSON.stringify(r));
    const manual = IDS[4];
    const ordered = callOrder(manual, '客人甲');
    ok('手动点歌成功入队', ordered && ordered.ok === true, JSON.stringify(ordered));
    const q = rows("SELECT song_id,status,nickname FROM queue WHERE status!='done'");
    ok('手动点歌立刻打断随机播放并开播', q.length === 1 && q[0].song_id === manual && q[0].status === 'playing', JSON.stringify(q));
    const done = db.prepare("SELECT * FROM queue WHERE status='done'").get();
    ok('被让位的随机歌标记为 done', !!done && done.nickname === '随机播放');
    db.prepare('DELETE FROM queue').run();
  }

  console.log('=== B. 空队列但曲库为空 → 明确告知（而不是默默无反应）===');
  {
    db.prepare('DELETE FROM songs').run();
    const r = callNext();
    ok('返回 empty=true', r && r.ok === true && r.empty === true, JSON.stringify(r));
    ok('队列仍为空', rows('SELECT * FROM queue').length === 0);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常', e); process.exit(1); });
