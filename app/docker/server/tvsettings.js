// TV 全屏播放 / 评分面板的时长配置。
//
// 存在 SQLite 的 settings 键值表里（与管理员密码、麦动配置同一张表），跟随 /data
// 一起持久化：改一次后台设置，重启、升级、容器重建都不丢。
//   tv_ctl_hide_ms   —— 全屏控制栏唤出后「无操作自动隐藏」时长(ms)，默认 3000
//   tv_score_show_ms —— 歌曲结束「评分面板显示」时长(ms)，到时后自动进入下一首，默认 5000
//
// 生效优先级（TV 端 index.html 里实现）：URL 参数 ?ctlMs= / ?scoreMs= > 服务端这份配置 > 默认值。
// URL 参数优先级最高，是为了在某个盒子/某台电视上单独调试而不用改全局。
//
// 全屏控制栏、评分面板这类计时器上限设 60s：误填成毫秒以外的数（比如把「秒」当「毫秒」
// 填了 5）也不会离谱地一直不隐藏；下限 500ms，避免填 0 变成「闪一下就没」。
const db = require('./db');

const DEFAULTS = { ctlHideMs: 3000, scoreShowMs: 5000 };
const KEYS = { ctlHideMs: 'tv_ctl_hide_ms', scoreShowMs: 'tv_score_show_ms' };
const MIN_MS = 500;
const MAX_MS = 60000;

function _readMs(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return null;
  const n = parseInt(row.value, 10);
  return Number.isFinite(n) ? n : null;
}

function _clamp(v, def) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(MAX_MS, Math.max(MIN_MS, n));
}

// 返回当前生效配置（缺省/非法值回落到默认）
function get() {
  const out = {};
  for (const k of Object.keys(KEYS)) {
    const v = _readMs(KEYS[k]);
    out[k] = (v != null && v >= MIN_MS && v <= MAX_MS) ? v : DEFAULTS[k];
  }
  return out;
}

// 只更新显式传入的字段，返回更新后的完整配置
function set(patch) {
  const p = patch || {};
  const up = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  if (p.ctlHideMs !== undefined) up.run(KEYS.ctlHideMs, String(_clamp(p.ctlHideMs, DEFAULTS.ctlHideMs)));
  if (p.scoreShowMs !== undefined) up.run(KEYS.scoreShowMs, String(_clamp(p.scoreShowMs, DEFAULTS.scoreShowMs)));
  return get();
}

module.exports = { get, set, DEFAULTS, MIN_MS, MAX_MS };
