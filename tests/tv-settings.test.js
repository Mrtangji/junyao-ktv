// 回归测试：TV 播放时长配置（server/tvsettings.js）——默认值 / 持久化 / 部分更新 / 夹取 / 脏数据回落。
//
// 跑法（仓库根目录）：
//   NODE_PATH='C:\Users\Administrator\.workbuddy\binaries\node\workspace\node_modules' \
//   node tests/tv-settings.test.js
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const SERVER_DIR = path.join(__dirname, '..', 'app', 'docker', 'server');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvset-'));
process.env.DATA_DIR = tmp; // 必须在 require db 之前设置

const db = require(path.join(SERVER_DIR, 'db.js'));
const tvsettings = require(path.join(SERVER_DIR, 'tvsettings.js'));

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { (c ? pass++ : fail++); console.log(`${c ? '✓' : '✗'} ${n}${e ? ' — ' + e : ''}`); };

console.log('=== A. 默认值 ===');
{
  const d = tvsettings.get();
  ok('ctlHideMs 默认 3000', d.ctlHideMs === 3000, String(d.ctlHideMs));
  ok('scoreShowMs 默认 5000', d.scoreShowMs === 5000, String(d.scoreShowMs));
}

console.log('=== B. 保存后持久化（重新 get 读回）===');
{
  const s = tvsettings.set({ ctlHideMs: 4000, scoreShowMs: 7000 });
  ok('set 返回新 ctlHideMs', s.ctlHideMs === 4000, String(s.ctlHideMs));
  ok('set 返回新 scoreShowMs', s.scoreShowMs === 7000, String(s.scoreShowMs));
  const g = tvsettings.get();
  ok('get 读回持久化值', g.ctlHideMs === 4000 && g.scoreShowMs === 7000, JSON.stringify(g));
}

console.log('=== C. 部分更新不覆盖另一字段 ===');
{
  tvsettings.set({ ctlHideMs: 2500 });
  const g = tvsettings.get();
  ok('只改 ctlHideMs，scoreShowMs 保持 7000', g.ctlHideMs === 2500 && g.scoreShowMs === 7000, JSON.stringify(g));
}

console.log('=== D. 越界/非法值夹取 ===');
{
  tvsettings.set({ ctlHideMs: 100 }); // < MIN 500
  ok('低于下限 → 夹到 500', tvsettings.get().ctlHideMs === 500, String(tvsettings.get().ctlHideMs));
  tvsettings.set({ scoreShowMs: 999999 }); // > MAX 60000
  ok('高于上限 → 夹到 60000', tvsettings.get().scoreShowMs === 60000, String(tvsettings.get().scoreShowMs));
  tvsettings.set({ ctlHideMs: 'abc' }); // 非数值 → 默认
  ok('非数值 → 回落默认 3000', tvsettings.get().ctlHideMs === 3000, String(tvsettings.get().ctlHideMs));
}

console.log('=== E. 库里旧脏数据（0 秒）→ get 回落默认 ===');
{
  db.prepare("INSERT INTO settings(key,value) VALUES('tv_score_show_ms','0') ON CONFLICT(key) DO UPDATE SET value='0'").run();
  ok('库值 0（非法）→ get 回落默认 5000', tvsettings.get().scoreShowMs === 5000, String(tvsettings.get().scoreShowMs));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
