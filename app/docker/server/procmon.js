// 容器内进程/CPU 采样（纯 /proc 读取，不依赖 top/ps — 镜像里没装 procps）。
//
// 为什么需要它：NAS 上"什么都没做但 CPU 一直占着"这类问题，光看容器整体
// 占用没法定位是谁在吃。而容器里又没有 top，用户只能靠猜。这里直接用
// /proc 自己算：
//   - 每个进程的 CPU 占用（读 utime+stime，两次采样求差）
//   - 所有进程 CPU 之和 ÷ 机器核数 = 容器对整机的占用百分比
//   - 单独列出 ffmpeg 进程（命令行长什么样、跑了多久、是不是我们登记的）
// 这样 GET /api/diag 就能直接回答"到底是谁在占 CPU"。
//
// 非 Linux（开发机 Windows）下 /proc 不存在：所有函数安全降级为空结果，
// 不抛异常、不影响服务启动。
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROC = '/proc';
const CLK_TCK = 100; // Linux 默认 USER_HZ，jiffies → 秒
const available = process.platform === 'linux' && fs.existsSync(PROC);

// 解析 /proc/<pid>/stat。格式：pid (comm) state ppid ... utime stime ... starttime ...
// comm 里可能带空格/括号，所以从最后一个 ')' 处切开，不能按空格 split 整行。
function parseStat(line) {
  const open = line.indexOf('(');
  const close = line.lastIndexOf(')');
  if (open < 0 || close < 0) return null;
  const pid = Number(line.slice(0, open).trim());
  const name = line.slice(open + 1, close);
  const rest = line.slice(close + 2).trim().split(/\s+/);
  // rest[0]=state(field3) → field N 对应 rest[N-3]
  const state = rest[0];
  const utime = Number(rest[11]);   // field 14
  const stime = Number(rest[12]);   // field 15
  const startJiffies = Number(rest[19]); // field 22
  if (!Number.isFinite(pid) || !Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return { pid, name, state, utime, stime, startJiffies };
}

function readStat(pid) {
  try { return parseStat(fs.readFileSync(path.join(PROC, String(pid), 'stat'), 'utf8')); }
  catch (e) { return null; }
}

function readCmdline(pid, max = 240) {
  try {
    const b = fs.readFileSync(path.join(PROC, String(pid), 'cmdline'));
    return b.toString('utf8').split('\0').filter(Boolean).join(' ').slice(0, max);
  } catch (e) { return ''; }
}

function pidList() {
  if (!available) return [];
  try { return fs.readdirSync(PROC).filter(n => /^\d+$/.test(n)); }
  catch (e) { return []; }
}

// 系统启动时刻（epoch 秒），用于算进程存活时长
function bootTime() {
  if (!available) return 0;
  try {
    const m = /^btime\s+(\d+)/m.exec(fs.readFileSync(path.join(PROC, 'stat'), 'utf8'));
    return m ? Number(m[1]) : 0;
  } catch (e) { return 0; }
}

function isFfmpeg(name) {
  return /^ffmpeg$/i.test(name) || /^ffprobe$/i.test(name);
}

// 列出容器内当前所有 ffmpeg / ffprobe 进程（含命令行与存活秒数）
function listMediaProcs() {
  if (!available) return [];
  const btime = bootTime();
  const now = Date.now() / 1000;
  const out = [];
  for (const pid of pidList()) {
    const st = readStat(pid);
    if (!st || !isFfmpeg(st.name)) continue;
    const startedAt = btime ? btime + st.startJiffies / CLK_TCK : 0;
    out.push({
      pid: st.pid,
      name: st.name,
      state: st.state,
      cmdline: readCmdline(st.pid),
      ageSec: startedAt ? Math.round(now - startedAt) : -1,
    });
  }
  return out;
}

// 两次采样计算各进程 CPU 占用（% of 单核，1 核满 = 100）
// 返回 { cores, containerPct, sampleMs, procs:[{pid,name,state,cpuPct,cmdline,ageSec}] }
async function sampleCpu({ sampleMs = 500, top = 15, withCmdline = true } = {}) {
  const cores = os.cpus().length || 1;
  if (!available) return { available: false, cores, sampleMs: 0, containerPct: 0, procs: [] };

  const btime = bootTime();
  const first = new Map();
  for (const pid of pidList()) {
    const st = readStat(pid);
    if (st) first.set(st.pid, st);
  }
  const t0 = Date.now();
  await new Promise(r => setTimeout(r, sampleMs));
  const elapsed = (Date.now() - t0) / 1000;
  const nowSec = Date.now() / 1000;

  const procs = [];
  let totalPct = 0;
  for (const [pid, st] of first) {
    const cur = readStat(pid);
    if (!cur) continue; // 采样间隙内退出了
    const dJiffies = (cur.utime + cur.stime) - (st.utime + st.stime);
    if (dJiffies <= 0) continue;
    const cpuPct = (dJiffies / CLK_TCK) / elapsed * 100;
    totalPct += cpuPct;
    const startedAt = btime ? btime + cur.startJiffies / CLK_TCK : 0;
    procs.push({
      pid: cur.pid,
      name: cur.name,
      state: cur.state,
      cpuPct: Math.round(cpuPct * 10) / 10,
      ageSec: startedAt ? Math.round(nowSec - startedAt) : -1,
      cmdline: withCmdline ? readCmdline(cur.pid) : '',
    });
  }
  procs.sort((a, b) => b.cpuPct - a.cpuPct);
  return {
    available: true,
    cores,
    sampleMs: Math.round(elapsed * 1000),
    // 容器内所有进程占用之和 ÷ 核数 = 占整机 CPU 的百分比
    containerPct: Math.round(totalPct / cores * 10) / 10,
    procs: procs.slice(0, top),
  };
}

function killProc(pid, signal = 'SIGKILL') {
  try { process.kill(Number(pid), signal); return true; }
  catch (e) { return false; }
}

module.exports = { available, sampleCpu, listMediaProcs, killProc, parseStat, CLK_TCK };
