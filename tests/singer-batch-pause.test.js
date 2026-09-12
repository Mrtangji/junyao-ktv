// 回归测试：歌手批量下载「暂停 / 继续下载 / 断点续传 / 意外自动暂停」。
//
// 跑法（仓库根目录）：
//   NODE_PATH='C:\Users\Administrator\.workbuddy\binaries\node\workspace\node_modules' \
//   node tests/singer-batch-pause.test.js
//
// 原理：把 boardsdk.search 与 lxmusic.downloadSong 换成可控桩（不联网），
// 真跑 singer-batch 的任务主循环与快照读写逻辑，断言：
//   · 暂停能秒级停下并把断点写进 DATA_DIR/singer-batch-job.json
//   · 「继续」能从断点接着下（内存热恢复 & 进程重启后的冷恢复）
//   · 「停止」才是放弃（快照一并清掉）
//   · 连续失败 / 任务异常会自动转入暂停而不是把剩下的歌丢进失败名单
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

const SERVER_DIR = path.join(__dirname, '..', 'app', 'docker', 'server');
const SB_PATH = path.join(SERVER_DIR, 'singer-batch.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbpause-'));
process.env.DATA_DIR = tmp;
process.env.MV_DIR = path.join(tmp, 'mv');
process.env.MP3_DIR = path.join(tmp, 'mv');
fs.mkdirSync(process.env.MV_DIR, { recursive: true });
const JOB_FILE = path.join(tmp, 'singer-batch-job.json');

const lxmusic = require(path.join(SERVER_DIR, 'lxmusic'));
const boardsdk = require(path.join(SERVER_DIR, 'boardsdk'));
let sb = require(SB_PATH);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`); };
// 轮询等待条件成立（默认 8s）
async function until(fn, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); }
  return fn();
}
const STOPPED = () => Object.assign(new Error('__SB_STOPPED__'), { __stopped: true });
const jobJson = () => JSON.parse(fs.readFileSync(JOB_FILE, 'utf8'));

(async () => {
  // 每次重新加载模块会触发启动恢复；先清掉可能残留的快照，保证起点干净
  try { fs.unlinkSync(JOB_FILE); } catch (e) {}

  boardsdk.lyricText = async () => null;   // 歌词是附属信息，测试里不发网络请求

  console.log('=== A. 暂停：秒级停下 + 断点落盘 ===');
  {
    // downloadSong 挂住不返回，直到 signal 被 abort（复现"正在下载中"的时刻）
    lxmusic.downloadSong = (o) => new Promise((res, rej) => {
      const sig = o.signal;
      if (!sig || sig.aborted) return rej(STOPPED());
      sig.addEventListener('abort', () => rej(STOPPED()));
    });
    boardsdk.search = async (src, name, page) => page === 1
      ? { list: [{ songmid: 'x1', name: '东京百货', singer: name, duration: 240, src }], total: 1 }
      : { list: [], total: 1 };

    const r = await sb.start({ text: '郑融', src: 'kw', format: 'mp3', minDur: 0, maxDur: 0, useFilter: true, filterWords: '' });
    ok('start 返回 ok', r.ok === true, JSON.stringify(r));
    await sleep(300);
    ok('已进入 running', sb.status().phase === 'running', sb.status().message);

    const t0 = Date.now();
    const pr = sb.pause();
    const s = sb.status();
    ok('pause() 立即返回 ok', pr.ok === true, JSON.stringify(pr));
    ok('状态立刻变成 paused（前端能马上显示）', s.phase === 'paused' && s.paused === true && s.resumable === true);
    ok('message 提示已暂停', /暂停/.test(s.message), s.message);
    ok('仍算 running（任务还挂在内存里，属"热暂停"）', s.running === true);
    const stoppedMs = Date.now() - t0;
    ok('暂停应秒级生效（<500ms）', stoppedMs < 500, `${stoppedMs}ms`);
    // 等主循环真的挂起在检查点上
    await until(() => !sb.status().stopping, 1500);
    ok('断点快照已落盘', fs.existsSync(JOB_FILE));
    const j = jobJson();
    ok('快照记录了歌手名单', Array.isArray(j.names) && j.names[0] === '郑融');
    ok('快照记录了剩余待下的歌（含被打断这首）', (j.pendingSongs || []).length === 1 && j.pendingSongs[0].name === '东京百货');
    ok('快照记录了任务配置（格式/平台/时长秒数）', j.opts.format === 'mp3' && j.opts.src === 'kw' && j.opts.minDurSec === 0);
    ok('state 暴露剩余量给前端', sb.status().pendingSongs === 1 && sb.status().remainingSingers === 1);
  }

  console.log('=== B. 继续下载（热恢复：主循环还在内存里）===');
  {
    const seen = [];
    lxmusic.downloadSong = async (o) => { seen.push(o.name); return { id: 1 }; };
    const r = await sb.resume();
    ok('resume() 返回 hot', r.ok === true && r.resumed === 'hot', JSON.stringify(r));
    ok('拿到新中断令牌（旧令牌已被暂停作废）', lxmusic.internals.currentCancelSignal() !== null);
    const done = await until(() => sb.status().phase === 'done');
    ok('任务接着跑完', done && sb.status().phase === 'done', sb.status().message);
    ok('被打断的那首重新下载成功', seen.length === 1 && seen[0] === '东京百货', JSON.stringify(seen));
    ok('完成后清掉断点快照', !fs.existsSync(JOB_FILE));
    ok('令牌已复位（不残留）', lxmusic.internals.currentCancelSignal() === null);
  }

  console.log('=== C. 暂停后「停止」才是放弃（断点一并清掉）===');
  {
    lxmusic.downloadSong = (o) => new Promise((res, rej) => {
      const sig = o.signal;
      if (!sig || sig.aborted) return rej(STOPPED());
      sig.addEventListener('abort', () => rej(STOPPED()));
    });
    boardsdk.search = async (src, name, page) => page === 1
      ? { list: [{ songmid: 'y1', name: '慢慢', singer: name, duration: 240, src }], total: 1 }
      : { list: [], total: 1 };
    await sb.start({ text: '郑融', src: 'kw', format: 'mp3', minDur: 0, maxDur: 0, useFilter: true, filterWords: '' });
    await until(() => sb.status().phase === 'running', 3000);
    sb.pause();
    await sleep(150);
    ok('暂停后快照存在', fs.existsSync(JOB_FILE));
    sb.stop();
    const ended = await until(() => !sb.status().running, 3000);
    ok('停止后任务结束', ended && sb.status().phase === 'done');
    ok('停止后快照被删除（放弃任务）', !fs.existsSync(JOB_FILE));
    ok('提示为"已停止"而不是"完成"', /已停止/.test(sb.status().message), sb.status().message);
  }

  console.log('=== D. 冷恢复：服务重启后从快照接着下（restoreJobOnBoot）===');
  {
    // 模拟进程重启：磁盘上留下一份"下到一半"的任务
    fs.writeFileSync(JOB_FILE, JSON.stringify({
      v: 1, names: ['冷启动歌手', '第二歌手'],
      opts: { src: 'kw', format: 'mp3', sqOnly: false, autoPage: true, maxSingers: 2, useFilter: true, filterWords: '', minDurSec: 0, maxDurSec: 0 },
      singerIndex: 0,
      pendingSongs: [{ songmid: 'p1', name: '冷的歌', singer: '冷启动歌手', src: 'kw', duration: 200 }],
      stats: { done: 3, failed: 0, skipped: 1, noLossless: 0, fallback: 0, failedList: [] },
      reason: '服务重启', savedAt: '',
    }), 'utf8');
    // 真正地重新加载模块，触发启动恢复逻辑
    delete require.cache[require.resolve(SB_PATH)];
    sb = require(SB_PATH);
    const s0 = sb.status();
    ok('启动即读到快照 → paused / resumable', s0.phase === 'paused' && s0.paused === true && s0.resumable === true, s0.message);
    ok('已完成的统计被继承（done=3 / skipped=1）', s0.done === 3 && s0.skipped === 1);
    ok('剩余量正确（1 首待下 / 2 个歌手）', s0.pendingSongs === 1 && s0.remainingSingers === 2);
    ok('不会自动开跑（等用户点继续）', s0.running === false);

    const seen = [];
    lxmusic.downloadSong = async (o) => { seen.push(o.name); return { id: 1 }; };
    boardsdk.search = async (src, name, page) => page === 1
      ? { list: [{ songmid: 's_' + name, name: name + '的歌', singer: name, duration: 200, src }], total: 1 }
      : { list: [], total: 1 };
    const r = await sb.resume();
    ok('resume() 返回 cold（从磁盘断点冷启动）', r.ok === true && r.resumed === 'cold', JSON.stringify(r));
    const done = await until(() => sb.status().phase === 'done', 10000);
    ok('断点续传跑完', done, sb.status().message);
    ok('先补下断点里那首，再继续后面的歌手', seen[0] === '冷的歌' && seen.length === 2, JSON.stringify(seen));
    ok('统计是累加的（3 + 2 = 5）', sb.status().done === 5, `done=${sb.status().done}`);
    ok('跑完后快照被清理', !fs.existsSync(JOB_FILE));
  }

  console.log('=== E. 连续失败 → 自动暂停保留断点（不把整批丢进失败）===');
  {
    lxmusic.downloadSong = async () => { throw new Error('模拟网络中断'); };
    boardsdk.search = async (src, name, page) => {
      if (src === 'kw') return page === 1
        ? { list: Array.from({ length: 10 }, (_, i) => ({ songmid: 'f' + i, name: '失败歌' + i, singer: name, duration: 200, src })), total: 10 }
        : { list: [], total: 0 };
      return { list: [], total: 0 };   // 其它平台也没有候选 → 换源同样失败
    };
    await sb.start({ text: '测试歌手', src: 'kw', format: 'mp3', minDur: 0, maxDur: 0, useFilter: true, filterWords: '' });
    const paused = await until(() => sb.status().phase === 'paused', 15000);
    const s = sb.status();
    ok('连续失败后自动进入暂停', paused && s.phase === 'paused', s.message);
    ok('提示是"自动暂停"并说明原因', /连续/.test(s.pausedReason || '') || /连续/.test(s.message), s.message);
    ok('失败数达到阈值（5）', s.failed >= 5, `failed=${s.failed}`);
    ok('剩余的歌还在断点里（没被丢掉）', s.pendingSongs > 0, `pendingSongs=${s.pendingSongs}`);
    ok('断点快照已保存', fs.existsSync(JOB_FILE) && (jobJson().pendingSongs || []).length > 0);
    // 收尾：放弃
    sb.stop();
    await until(() => !sb.status().running, 3000);
  }

  console.log('=== F. 任务意外抛异常 → 自动暂停（冷），可再继续 ===');
  {
    lxmusic.downloadSong = async () => ({ id: 1 });
    boardsdk.search = async (src, name, page) => page === 1
      ? { list: [{ songmid: 'z1', name: '意外歌', singer: name, duration: 200, src }], total: 1 }
      : { list: [], total: 1 };
    const realFind = lxmusic.findLocalSong;
    lxmusic.findLocalSong = () => { throw new Error('模拟曲库读取异常'); };
    await sb.start({ text: '意外歌手', src: 'kw', format: 'mp3', minDur: 0, maxDur: 0, useFilter: true, filterWords: '' });
    const paused = await until(() => sb.status().phase === 'paused', 8000);
    const s = sb.status();
    ok('异常后转入暂停而不是任务终止', paused && s.phase === 'paused', s.message);
    ok('提示含"意外"字样', /意外/.test(s.message), s.message);
    ok('running=false / resumable=true（等用户继续）', s.running === false && s.resumable === true);
    ok('断点快照保留', fs.existsSync(JOB_FILE));
    // 恢复环境后继续
    lxmusic.findLocalSong = realFind;
    const r = await sb.resume();
    ok('resume() 从冷断点重启', r.ok === true && r.resumed === 'cold', JSON.stringify(r));
    const done = await until(() => sb.status().phase === 'done', 8000);
    ok('继续后正常跑完', done && sb.status().done >= 1, sb.status().message);
  }

  console.log('=== G. 冷状态（只剩快照）下「停止」= 放弃并清理 ===');
  {
    fs.writeFileSync(JOB_FILE, JSON.stringify({
      v: 1, names: ['未完成的歌手'],
      opts: { src: 'kw', format: 'flac', sqOnly: false, autoPage: true, maxSingers: 2, useFilter: true, filterWords: '', minDurSec: 0, maxDurSec: 0 },
      singerIndex: 0, pendingSongs: [{ songmid: 'q1', name: '残留歌', singer: '未完成的歌手', src: 'kw' }],
      stats: { done: 1, failed: 0, skipped: 0, noLossless: 0, fallback: 0, failedList: [] },
      reason: '服务重启', savedAt: '',
    }), 'utf8');
    delete require.cache[require.resolve(SB_PATH)];
    sb = require(SB_PATH);
    ok('冷启动后处于可继续状态', sb.status().phase === 'paused' && sb.status().resumable === true);
    const r = sb.stop();
    ok('stop() 返回 discarded（走的是"放弃"分支）', r.ok === true && r.discarded === true, JSON.stringify(r));
    ok('快照被删除', !fs.existsSync(JOB_FILE));
    ok('状态回到 idle，不再显示可继续', sb.status().phase === 'idle' && sb.status().resumable === false);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常', e); process.exit(1); });
