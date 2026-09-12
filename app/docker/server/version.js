// 版本信息 —— 让「服务器上跑的是不是最新版」一眼可见。
//
// 为什么需要它：镜像 tag 是 latest，看起来永远是"最新"，但用户没法确认自己
// pull 到的到底是哪一次构建。commit sha + 构建时间才是唯一能对齐 GitHub 的
// 凭据。这里把这些信息收集起来，通过 GET /api/version 暴露，界面上直接显示。
//
// 取值优先级（越靠前越权威）：
//   1) 构建期注入的环境变量：CI 的 docker build --build-arg → Dockerfile 的 ENV
//   2) 镜像内 /app/VERSION（源码里是 app/docker/VERSION，改版本号只改这个文件）
//   3) server/package.json 的 version
//   4) 本地开发时（有 .git、有 git 命令）直接读当前提交，避免"本地跑看到的
//      版本号是假的"。镜像里既没有 .git 也没有 git 可执行文件，会自然跳过。
'use strict';

const fs = require('fs');
const path = require('path');

function safeRead(p) {
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch (e) {
    return '';
  }
}

function safeJson(p) {
  try {
    return JSON.parse(safeRead(p)) || {};
  } catch (e) {
    return {};
  }
}

const pkg = safeJson(path.join(__dirname, 'package.json'));

// —— 1) 构建期注入 ——
const envVersion = String(process.env.APP_VERSION || '').trim();
const envSha = String(process.env.BUILD_SHA || '').trim();
const envTime = String(process.env.BUILD_TIME || '').trim();
const envRef = String(process.env.BUILD_REF || '').trim();
const repo = String(process.env.BUILD_REPO || 'Mrtangji/junyao-ktv').trim();

// —— 2) VERSION 文件（镜像 /app/VERSION；本地 app/docker/VERSION）——
const fileVersion = safeRead(path.join(__dirname, '..', 'VERSION'));

// —— 3) 本地 git 兜底（镜像里没有 git，会抛异常走 catch）——
function git(args) {
  try {
    const { execFileSync } = require('child_process');
    return execFileSync('git', args, {
      cwd: __dirname,
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch (e) {
    return '';
  }
}

const version = envVersion || fileVersion || pkg.version || '0.0.0';
const shaFull = envSha || git(['rev-parse', 'HEAD']);
const sha = (shaFull || git(['rev-parse', '--short', 'HEAD']) || '').slice(0, 12);
const ref = envRef || git(['rev-parse', '--abbrev-ref', 'HEAD']);
const buildTime = envTime;

// —— 4) 界面上的"版本号"：提交时间的 12 位数字戳 ——
// 形如 260912221841（= 2026-09-12 22:18:41）。比 sha 好念、比可读时间串短，
// 只显示在「曲库管理」页面，用来确认"部署的到底是哪一次构建"。
// 固定按北京时间(+08:00)格式化：Docker 容器默认 TZ=UTC，直接用本地时间会整整差 8 小时。
function stampOf(ts) {
  const d = ts ? new Date(ts) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return String(bj.getUTCFullYear()).slice(-2) + p(bj.getUTCMonth() + 1) + p(bj.getUTCDate())
    + p(bj.getUTCHours()) + p(bj.getUTCMinutes()) + p(bj.getUTCSeconds());
}
// 优先用 CI 注入的构建时间；本地开发没有构建时间就退回 git 提交时间，
// 保证界面上始终有一个能和 GitHub 对齐的时间戳。
const gitCommitTime = envTime ? '' : git(['log', '-1', '--format=%cI']);
const stamp = stampOf(envTime || gitCommitTime);

// 构建来源：ci=CI 注入 / local-git=本地读到了 git / unknown=都拿不到
const source = envSha ? 'ci' : (sha ? 'local-git' : 'unknown');

const startedAt = Date.now();

// 带时区的可读时间（部署在 NAS 上，日志/界面都用本地时间才好对照）。
// 末尾显式带上 UTC 偏移，避免容器里 TZ 没生效时显示 UTC 时间而看不出来。
function fmtLocal(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  // getTimezoneOffset() 是"UTC 减本地"的分钟数，符号与直觉相反，取负还原
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const zone = `UTC${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${zone}`;
}

function shortSha() {
  return sha ? sha.slice(0, 7) : '';
}

/**
 * 一行式版本戳：优先用提交时间戳（260912221841），拿不到时退回「版本号 · 短sha」。
 */
function label() {
  if (stamp) return stamp;
  const s = shortSha();
  return s ? `${version} · ${s}` : version;
}

function getVersion() {
  return {
    // 版本号：CI 打 tag 时为 tag 名，main 推送时为镜像 tag（latest），
    // 本地开发时为 VERSION 文件/package.json 的值
    version,
    // 提交：短 sha 便于肉眼比对，全 sha 用于点开 GitHub 看那次提交
    sha: shortSha(),
    shaFull: shaFull || '',
    ref: ref || '',
    // 界面显示用的「版本号」＝提交时间戳（YYMMDDHHmmss，北京时间），例如 260912221841
    stamp,
    // 构建时间（CI 注入，UTC ISO）与本地时区可读串
    buildTime: buildTime || '',
    buildTimeLocal: fmtLocal(buildTime),
    // 本地开发时从 git 读到的提交时间（CI 构建为空）
    commitTime: gitCommitTime || '',
    source,
    node: process.version,
    repo,
    repoUrl: repo ? `https://github.com/${repo}` : '',
    commitUrl: (repo && shaFull) ? `https://github.com/${repo}/commit/${shaFull}` : '',
    // 本次进程启动时间与已运行时长
    startedAt,
    startedAtLocal: fmtLocal(startedAt),
    uptimeSec: Math.round(process.uptime()),
    label: label(),
  };
}

module.exports = { getVersion, label: label() };
