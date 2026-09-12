// 回归测试：歌手批量下载点「停止」必须立刻停（旧 bug：要等当前请求自己超时，最长 30s）。
//
// 跑法（仓库根目录或本目录均可）：
//   NODE_PATH='C:\Users\Administrator\.workbuddy\binaries\node\workspace\node_modules' \
//   node tests/singer-batch-stop.test.js
//
// 原理：起一个"只接受连接、永不回响应"的本地 HTTP 服务来复现"在途请求卡住"
// （音源接口慢/被风控时就是这样），再真跑 lxmusic / singer-batch 的模块代码。
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const cp = require('child_process');

const SERVER_DIR = path.join(__dirname, '..', 'app', 'docker', 'server');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbstop-'));
process.env.DATA_DIR = tmp;
process.env.MV_DIR = path.join(tmp, 'mv');
process.env.MP3_DIR = path.join(tmp, 'mv');
fs.mkdirSync(process.env.MV_DIR, { recursive: true });

// 必须在 require lxmusic 之前替换 spawn：模块加载时会解构 child_process.spawn
const spawned = [];
cp.spawn = (cmd, args) => {
  const ev = {};
  const child = {
    pid: 99999, killed: false, cmd, args,
    on(n, f) { (ev[n] = ev[n] || []).push(f); return this; },
    emit(n, ...a) { (ev[n] || []).forEach(f => f(...a)); },
    kill(sig) { child.killed = true; child.sig = sig; setImmediate(() => child.emit('close', 137)); return true; },
    stderr: { on() {} },
  };
  spawned.push(child);
  return child;
};

const lxmusic = require(path.join(SERVER_DIR, 'lxmusic'));
const boardsdk = require(path.join(SERVER_DIR, 'boardsdk'));
const sb = require(path.join(SERVER_DIR, 'singer-batch'));
const { httpReq } = lxmusic.internals;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`); };

const hangSrv = http.createServer(() => { /* 故意不响应 */ });

(async () => {
  await new Promise(r => hangSrv.listen(0, '127.0.0.1', r));
  const HANG = `http://127.0.0.1:${hangSrv.address().port}/hang`;

  console.log('=== A. 取消必须在"响应头到达之前"就生效（核心 bug）===');
  {
    const ac = new AbortController();
    const t0 = Date.now();
    const p = httpReq(HANG, { signal: ac.signal, timeout: 30000 })
      .then(() => 'resolved', e => ({ stopped: !!e.__stopped, msg: e.message }));
    await sleep(150);
    ac.abort();
    const r = await Promise.race([p, sleep(1200).then(() => 'TIMEOUT_STILL_HANGING')]);
    const ms = Date.now() - t0;
    ok('在途未回响应时 abort → 立刻 reject', r !== 'TIMEOUT_STILL_HANGING' && r.stopped === true, `${ms}ms`);
    ok('耗时应 <500ms（不是等 30s 超时）', ms < 500, `${ms}ms`);
  }
  {
    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    const r = await httpReq(HANG, { signal: ac.signal, timeout: 30000 }).then(() => 'resolved', e => e.__stopped);
    ok('已 abort 的令牌 → 请求根本不发出，立即失败', r === true && Date.now() - t0 < 100, `${Date.now() - t0}ms`);
  }

  console.log('=== B. setCancelSignal：脚本内/内置源内的请求也能被掐断 ===');
  {
    const ac = new AbortController();
    lxmusic.setCancelSignal(ac.signal);
    const t0 = Date.now();
    const p = httpReq(HANG, { timeout: 30000 }).then(() => 'resolved', e => e.__stopped);  // 未显式传 signal
    await sleep(150);
    ac.abort();
    const r = await Promise.race([p, sleep(1000).then(() => 'HANGING')]);
    ok('未显式传 signal 的请求也随令牌中断', r === true, `${Date.now() - t0}ms`);
    const r2 = await httpReq(HANG, { timeout: 30000 }).then(() => 'resolved', e => e.__stopped);
    ok('令牌已 abort 后新建请求立即失败（不再发出去）', r2 === true);
    lxmusic.setCancelSignal(null);
    const okSrv = http.createServer((q, s) => { s.writeHead(200, { 'Content-Type': 'text/plain' }); s.end('hi'); });
    await new Promise(r => okSrv.listen(0, '127.0.0.1', r));
    const resp = await httpReq(`http://127.0.0.1:${okSrv.address().port}/ok`, { timeout: 3000 });
    ok('setCancelSignal(null) 后请求恢复正常（无粘性）', resp.statusCode === 200 && String(resp.body) === 'hi');
    okSrv.close();
  }

  console.log('=== C. ffmpeg 转码可被立即 kill ===');
  {
    const ac = new AbortController();
    const p = lxmusic.internals.ffmpegToMp3('/tmp/a.mp3', '/tmp/b.mp3', ac.signal)
      .then(() => 'resolved', e => (e && e.__stopped) ? 'stopped' : 'other:' + e.message);
    await sleep(80);
    ac.abort();
    const r = await Promise.race([p, sleep(800).then(() => 'NOT_KILLED')]);
    ok('abort 时 ffmpeg 子进程被 SIGKILL 并抛 __stopped', r === 'stopped' && spawned.some(c => c.killed && c.sig === 'SIGKILL'), r);
  }

  console.log('=== D. 歌手批量下载：点停止后很快变 running=false ===');
  {
    // 只替换"下载"这一步：真实的取链/抓流在测试里不可控，但信号传递链路是真的
    lxmusic.downloadSong = async (o) => { await httpReq(HANG, { signal: o.signal, timeout: 30000 }); return { id: 1 }; };
    lxmusic.findLocalSong = () => null;
    boardsdk.search = async (src, name, page) => page === 1
      ? { list: [{ songmid: 'x1', name: '东京百货', singer: name, duration: 240, src }], total: 1 }
      : { list: [], total: 1 };

    const st = await sb.start({ text: '郑融', src: 'kw', format: 'mp3', minDur: 0, maxDur: 0, useFilter: true, filterWords: '' });
    ok('start 返回 ok', st.ok === true, JSON.stringify(st));
    await sleep(400);
    ok('已进入 running', sb.status().running === true, JSON.stringify(sb.status().message));

    const t0 = Date.now();
    sb.stop();
    const s = sb.status();
    ok('stop() 后立刻进入 stopping 状态（前端能马上显示）', s.stopping === true && /停止/.test(s.message));

    let ms = 0;
    while (sb.status().running && Date.now() - t0 < 5000) { await sleep(25); ms = Date.now() - t0; }
    ok('运行状态在 1.5s 内结束（旧实现要等请求超时，最长 30s）', !sb.status().running && ms < 1500, `${ms}ms`);
    ok('未被记成"失败"（干净中断）', sb.status().failed === 0, `failed=${sb.status().failed}`);
    ok('令牌已复位（不残留）', lxmusic.internals.currentCancelSignal() === null);
  }

  console.log('=== E. 时长过滤单位 = 分钟；默认下载格式 = FLAC ===');
  {
    const seen = [];
    lxmusic.downloadSong = async (o) => { seen.push(o.name + '|' + o.format); return { id: 1 }; };
    boardsdk.search = async (src, name, page) => page === 1 ? {
      list: [
        { songmid: 'a', name: '短歌', singer: name, duration: 100, src },
        { songmid: 'b', name: '正常歌', singer: name, duration: 200, src },
        { songmid: 'c', name: '很长歌', singer: name, duration: 400, src },
      ], total: 3,
    } : { list: [], total: 3 };
    await sb.start({ text: '测试', src: 'kw', minDur: 3, maxDur: 5, useFilter: true, filterWords: '' });  // 不传 format
    let g = 0; while (sb.status().running && g++ < 200) await sleep(25);
    ok('minDur=3 / maxDur=5（分钟）→ 只留 200 秒那首', seen.length === 1 && seen[0] === '正常歌|flac', JSON.stringify(seen));
  }

  console.log('=== F. 过滤词里的 "+" ===');
  {
    const seen = [];
    lxmusic.downloadSong = async (o) => { seen.push(o.name); return { id: 1 }; };
    boardsdk.search = async (src, name, page) => page === 1 ? {
      list: [
        { songmid: 'a', name: '晴天', singer: name, duration: 200, src },
        { songmid: 'b', name: '告白气球+晴天', singer: name, duration: 200, src },
      ], total: 2,
    } : { list: [], total: 2 };
    await sb.start({ text: '测试', src: 'kw', format: 'mp3', minDur: 0, maxDur: 0, useFilter: true, filterWords: '' });
    let g = 0; while (sb.status().running && g++ < 200) await sleep(25);
    ok('歌名含 "+" 的被过滤掉', seen.length === 1 && seen[0] === '晴天', JSON.stringify(seen));
    ok('默认过滤词已包含 +', sb.DEFAULT_FILTER_WORDS.split(',').includes('+'));
  }

  console.log('=== G. 收集阶段（搜索请求在途）点停止也要快 ===');
  {
    // 模拟"平台接口慢/被风控"：搜索请求挂着，只有取消令牌能让它 reject。
    // 这是跑上万位歌手名单时最常碰到停止的时刻（大部分时间都在收集，而不是下载）。
    const stoppedErr = () => Object.assign(new Error('__SB_STOPPED__'), { __stopped: true });
    boardsdk.search = async () => {
      const sig = lxmusic.internals.currentCancelSignal();
      await new Promise((res, rej) => {
        if (!sig) return;                                  // 没有令牌（不该发生）就一直挂着
        if (sig.aborted) return rej(stoppedErr());
        sig.addEventListener('abort', () => rej(stoppedErr()));
        setTimeout(res, 30000);                            // 兜底：正常不该走到这里
      });
      return { list: [], total: 0 };
    };
    lxmusic.downloadSong = async () => ({ id: 1 });

    await sb.start({ text: '郑融', src: 'kw', format: 'mp3', minDur: 0, maxDur: 0, useFilter: true, filterWords: '' });
    await sleep(250);
    ok('已进入收集阶段', sb.status().running === true && /收集/.test(sb.status().message), sb.status().message);

    const t0 = Date.now();
    sb.stop();
    let ms = 0;
    while (sb.status().running && Date.now() - t0 < 5000) { await sleep(20); ms = Date.now() - t0; }
    ok('收集阶段点停止 → 快速结束（不等 30s 超时）', !sb.status().running && ms < 1500, `${ms}ms`);
    ok('未被记成搜索失败', sb.status().failed === 0, `failed=${sb.status().failed}`);
    ok('提示为"已停止"', /已停止/.test(sb.status().message), sb.status().message);
    ok('令牌已复位', lxmusic.internals.currentCancelSignal() === null);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  hangSrv.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常', e); process.exit(1); });
