// 容器内进程/CPU 采样（纯 /proc 读取，不依赖 top/ps — 镜像里没装 procps）。
//
// 为什么需要它：NAS 上"什么都没做但 CPU 一直占着"这类问题，光看容器整体
// 占用没法定位是谁在吃。而容器里又没有 top，用户只能靠猜。这里直接用
// /proc 自己算：
//   - 每个进程的 CPU 占用（读 utime+stime，两次采样求差）
//   - 容器的整体 CPU 用量（优先读 cgroup 计数，见下）
//   - 单独列出 ffmpeg 进程（命令行长什么样、跑了多久、是不是我们登记的）
// 这样 GET /api/diag 就能直接回答"到底是谁在占 CPU"。
//
// 两种统计方式，为什么优先 cgroup：
//   /proc 求和只认"两次采样之间都还活着"的进程。扫描曲库时每个文件要起一次
//   ffprobe，这种进程只活几十毫秒，绝大多数在第二次读 /proc 之前就已退出，
//   于是被整个漏掉——扫描期间容器占用会被严重低估。cgroup 的累计用量是内核
//   按 cgroup 记账的，子进程生灭一视同仁，算出来才是容器真实的占用。
//   因此：cgroup 可读就用 cgroup，读不到才退回 /proc 求和。
//
// 另外暴露宿主机负载：Linux 下 /proc/loadavg 不受 PID 命名空间影响，容器里
// 读到的就是宿主机整体的负载；os.cpus().length 同样是宿主机的核数（不是
// cgroup 限额）。两者相减就能判断"占用到底是不是本容器造成的"。
//
// 非 Linux（开发机 Windows）下 /proc 不存在：所有函数安全降级为空结果，
// 不抛异常、不影响服务启动。
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROC = '/proc';
const CLK_TCK = 100; // Linux 默认 USER_HZ，jiffies → 秒
const available = process.platform === 'linux' && fs.existsSync(PROC);

const r1 = n => Math.round(n * 10) / 10;

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

// ---------- cgroup 整体 CPU 计数 ----------
// 先按 /proc/self/cgroup 找到本容器 cgroup 在 /sys/fs/cgroup 下的挂载点：
//   cgroup v2（一条 "0::<path>"）/ v1（"<n>:cpuacct:<path>"）。
// cgroupns 为 private 时 path 就是 "/"（挂载根即本容器）；shared 时 path 形如
// /docker/<id>，此时若直接读 /sys/fs/cgroup/cpu.stat 会读到**宿主机整体**——
// 所以必须拼上 path，这是一种"把宿主机的占用误报成容器占用"的隐患。
function cgroupCpuPath() {
  if (!available) return null;
  let raw;
  try { raw = fs.readFileSync('/proc/self/cgroup', 'utf8'); } catch (e) { return null; }
  const v2 = /^0::(.*)$/m.exec(raw);
  if (v2) {
    const p = v2[1] === '/' ? '' : v2[1];
    return { file: '/sys/fs/cgroup' + p + '/cpu.stat', scale: 1e3, kind: 'v2' }; // usage_usec → 纳秒
  }
  const v1 = /^\d+:cpuacct:(.*)$/m.exec(raw);
  if (v1) {
    const p = v1[1] === '/' ? '' : v1[1];
    return { file: '/sys/fs/cgroup/cpuacct' + p + '/cpuacct.usage', scale: 1, kind: 'v1' }; // 已是纳秒
  }
  return null;
}

// 返回容器累计 CPU 用量（纳秒）；不可用返回 null
function cgroupCpuNs() {
  const info = cgroupCpuPath();
  if (!info) return null;
  try {
    const txt = fs.readFileSync(info.file, 'utf8');
    const m = /^\s*usage_usec\s+(\d+)/m.exec(txt);
    if (m && info.kind === 'v2') return Number(m[1]) * info.scale;
    const n = Number(txt.trim().split(/\s+/)[0]);
    if (Number.isFinite(n)) return n * info.scale;
  } catch (e) {}
  return null;
}

// 宿主机整体负载（容器内读到的是宿主机的值，不受 PID 命名空间隔离）
function hostLoad() {
  const cores = os.cpus().length || 1;
  const la = os.loadavg();
  return { cores, load1: r1(la[0]), load5: r1(la[1]), load15: r1(la[2]) };
}

// 两次采样计算 CPU 占用
// 返回 { cores, containerPct, containerCores, method, host, sampleMs, procs:[...] }
//   containerCores = 本容器占用了多少个核（1.0 = 满一个核）
//   containerPct   = containerCores/核数*100，即"占整机 CPU 的百分比"
//   host.load1     = 宿主机近 1 分钟的负载（≈ 被占用的核数），据此可判断
//                    "宿主机忙，但不是本容器造成的"
//   procs[].cpuPct = 单进程占用（% of 单核，100 = 满一个核）
async function sampleCpu({ sampleMs = 500, top = 15, withCmdline = true } = {}) {
  const cores = os.cpus().length || 1;
  const host = hostLoad();
  if (!available) return { available: false, cores, sampleMs: 0, containerPct: 0, containerCores: 0, method: 'none', host, procs: [] };

  const btime = bootTime();
  const cg0 = cgroupCpuNs();
  const first = new Map();
  for (const pid of pidList()) {
    const st = readStat(pid);
    if (st) first.set(st.pid, st);
  }
  const t0 = Date.now();
  await new Promise(r => setTimeout(r, sampleMs));
  const elapsed = (Date.now() - t0) / 1000;
  const nowSec = Date.now() / 1000;
  const cg1 = cgroupCpuNs();

  const procs = [];
  let totalPct = 0;
  for (const [pid, st] of first) {
    const cur = readStat(pid);
    if (!cur) continue; // 采样间隙内退出了（短命 ffprobe 多落在这里，故仅作参考）
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

  // 口径选择：cgroup 记账（含短命子进程）优先；否则退回 /proc 求和。
  // 合理性校验：算出的核数不该超过机器核数太多，否则说明读到了宿主机的
  // cgroup（cgroupns=shared 且路径判断失效），此时宁可用偏小但不会误报的
  // /proc 求和。
  let containerCores = totalPct / 100;
  let method = 'proc-sum';
  let cgroupPath = null;
  if (cg0 != null && cg1 != null && cg1 >= cg0) {
    const coresUsed = (cg1 - cg0) / 1e9 / elapsed;
    if (coresUsed <= cores * 1.5) {
      containerCores = coresUsed;
      method = 'cgroup';
      try { cgroupPath = cgroupCpuPath().file; } catch (e) {}
    }
  }

  return {
    available: true,
    cores,
    sampleMs: Math.round(elapsed * 1000),
    method,
    cgroupPath,
    containerCores: Math.round(containerCores * 100) / 100,
    // 容器内 CPU 用量 ÷ 机器核数 = 占整机 CPU 的百分比
    containerPct: r1(containerCores / cores * 100),
    host,
    procs: procs.slice(0, top),
  };
}

function killProc(pid, signal = 'SIGKILL') {
  try { process.kill(Number(pid), signal); return true; }
  catch (e) { return false; }
}

module.exports = { available, sampleCpu, listMediaProcs, killProc, parseStat, hostLoad, cgroupCpuNs, CLK_TCK };
