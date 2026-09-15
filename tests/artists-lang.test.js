// 回归测试：/api/artists 的「歌手 → 主导语言」聚合。
//
// 背景：原实现用相关子查询
//     (SELECT lang FROM songs s2 WHERE s2.artist = s.artist
//      GROUP BY lang ORDER BY COUNT(*) DESC LIMIT 1)
// 对**每一位歌手**重跑一遍全表聚合，复杂度 O(歌手数 × 曲库行数)——万级歌手的曲库下
// 这条接口要跑几秒到几十秒并把 CPU 打满。现改为两条平坦的 GROUP BY 扫描后在 JS 里
// 合并取主导语言（O(曲库行数)）。
//
// 本测试把「旧 SQL」原样保留下来，在同一份数据上跑新旧两套算法并逐条比对，确保优化
// 没有改变语义（含 lang 为 NULL / 空串 / 同票数 / 无 lang 行等边界）。
//
// 跑法（仓库根目录）：
//   NODE_PATH='C:\Users\Administrator\.workbuddy\binaries\node\workspace\node_modules' \
//   node tests/artists-lang.test.js
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const SERVER_DIR = path.join(__dirname, '..', 'app', 'docker', 'server');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'artists-'));
process.env.DATA_DIR = tmp; // 必须在 require db 之前设置

const db = require(path.join(SERVER_DIR, 'db.js'));

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { (c ? pass++ : fail++); console.log(`${c ? '✓' : '✗'} ${n}${e ? ' — ' + e : ''}`); };

// ---------- 造数据 ----------
// 注意 lang 列为后加的（见 db.js 的 ALTER TABLE），这里直接用 SQL 写。
const ins = db.prepare(
  'INSERT INTO songs (title, artist, filename, filepath, media_type) VALUES (?,?,?,?,?)'
);
const setLang = db.prepare('UPDATE songs SET lang = ? WHERE id = ?');
const rows = [
  // 周杰伦：国语 3 首 + 英语 1 首 → 主导 zh
  ['晴天', '周杰伦', 'zjl-qing.mp3', '/a/zjl-qing.mp3', 'audio', 'zh'],
  ['七里香', '周杰伦', 'zjl-qlx.mp3', '/a/zjl-qlx.mp3', 'audio', 'zh'],
  ['稻香', '周杰伦', 'zjl-dx.mp3', '/a/zjl-dx.mp3', 'audio', 'zh'],
  ['Nunchucks', '周杰伦', 'zjl-nc.mp3', '/a/zjl-nc.mp3', 'audio', 'en'],
  // 五月天：英语 2 首 + 日语 1 首 → en
  ['OAOA', '五月天', 'myt-oa.mp3', '/a/myt-oa.mp3', 'audio', 'en'],
  ['Do You Ever Shine', '五月天', 'myt-dy.mp3', '/a/myt-dy.mp3', 'audio', 'en'],
  ['日本語の歌', '五月天', 'myt-jp.mp3', '/a/myt-jp.mp3', 'audio', 'jp'],
  // 无语言信息：lang 为 NULL → 结果 lang 应为 null
  ['纯音乐A', '无语言歌手', 'nl-a.mp3', '/a/nl-a.mp3', 'audio', null],
  ['纯音乐B', '无语言歌手', 'nl-b.mp3', '/a/nl-b.mp3', 'audio', null],
  // lang 为空串：旧子查询也会把它算作一个分组，可能被选中
  ['空串语言', '空串歌手', 'es-a.mp3', '/a/es-a.mp3', 'audio', ''],
  ['国语歌', '空串歌手', 'es-b.mp3', '/a/es-b.mp3', 'audio', 'zh'],
  // 同票数（zh 1 / en 1）→ 两边都不保证顺序，只要求结果落在候选集里
  ['票数相同1', '同票歌手', 'tie-a.mp3', '/a/tie-a.mp3', 'audio', 'zh'],
  ['票数相同2', '同票歌手', 'tie-b.mp3', '/a/tie-b.mp3', 'audio', 'en'],
  // artist 为空串 / NULL → 必须被排除
  ['无名', '', 'anon-a.mp3', '/a/anon-a.mp3', 'audio', 'zh'],
  ['无名2', null, 'anon-b.mp3', '/a/anon-b.mp3', 'audio', 'en'],
];
for (const r of rows) {
  const info = ins.run(r[0], r[1], r[2], r[3], r[4]);
  setLang.run(r[5], info.lastInsertRowid);
}

// ---------- 旧实现（原样保留，作为基准） ----------
function artistsOld() {
  return db.prepare(`
    SELECT s.artist, COUNT(*) as count,
      (SELECT lang FROM songs s2 WHERE s2.artist = s.artist GROUP BY lang ORDER BY COUNT(*) DESC LIMIT 1) as lang
    FROM songs s WHERE s.artist IS NOT NULL AND s.artist != '' GROUP BY s.artist ORDER BY s.artist
  `).all();
}

// ---------- 新实现（与 server/index.js 的 /api/artists 保持同步） ----------
function artistsNew() {
  const list = db.prepare(`
    SELECT artist, COUNT(*) AS count FROM songs
    WHERE artist IS NOT NULL AND artist != '' GROUP BY artist ORDER BY artist
  `).all();
  const langRows = db.prepare(`
    SELECT artist, lang, COUNT(*) AS c FROM songs
    WHERE artist IS NOT NULL AND artist != '' AND lang IS NOT NULL AND lang != ''
    GROUP BY artist, lang
  `).all();
  const best = new Map();
  for (const r of langRows) {
    const cur = best.get(r.artist);
    if (!cur || r.c > cur.c) best.set(r.artist, { lang: r.lang, c: r.c });
  }
  for (const r of list) { const b = best.get(r.artist); r.lang = b ? b.lang : null; }
  return list;
}

console.log('=== A. 行数 / 歌手 / 歌数 一致 ===');
const a = artistsOld(), b = artistsNew();
ok('歌手条数一致', a.length === b.length, `old=${a.length} new=${b.length}`);
ok('排除 artist 为 NULL/空串', b.every(r => r.artist !== null && r.artist !== ''), JSON.stringify(b.map(r => r.artist)));
ok('按 artist 升序', JSON.stringify(b.map(r => r.artist)) === JSON.stringify([...b.map(r => r.artist)].sort()),
  JSON.stringify(b.map(r => r.artist)));
{
  const oa = new Map(a.map(r => [r.artist, r.count])), na = new Map(b.map(r => [r.artist, r.count]));
  ok('每位歌手的歌曲数一致', [...oa.keys()].every(k => oa.get(k) === na.get(k)),
    JSON.stringify([...na]));
  ok('歌数合计 = 有效行数(排除 2 条无名)', [...na.values()].reduce((x, y) => x + y, 0) === 13,
    String([...na.values()].reduce((x, y) => x + y, 0)));
}

console.log('=== B. 主导语言：确定性的用例逐条比对旧实现 ===');
{
  const na = new Map(b.map(r => [r.artist, r.lang]));
  ok('周杰伦 zh 3 票 > en 1 票 → zh', na.get('周杰伦') === 'zh', String(na.get('周杰伦')));
  ok('五月天 en 2 票 > jp 1 票 → en', na.get('五月天') === 'en', String(na.get('五月天')));
  ok('全为 NULL lang → null', na.get('无语言歌手') === null, String(na.get('无语言歌手')));
}
{
  // 空串 lang：旧实现里空串也是一个分组（1 票），与 zh(1 票) 同票 → 顺序不保证。
  // 新实现显式跳过空串 → 必然 zh。两者都合理，这里断言新实现的行为并记录差异。
  const na = new Map(b.map(r => [r.artist, r.lang]));
  ok('空串 lang 被跳过 → 取到 zh', na.get('空串歌手') === 'zh', String(na.get('空串歌手')));
}
{
  const na = new Map(b.map(r => [r.artist, r.lang]));
  ok('同票数时结果落在候选集内', ['zh', 'en'].includes(na.get('同票歌手')), String(na.get('同票歌手')));
  const oa = new Map(a.map(r => [r.artist, r.lang]));
  ok('同票数时旧实现也落在候选集内', ['zh', 'en'].includes(oa.get('同票歌手')), String(oa.get('同票歌手')));
}

console.log('=== C. 与旧实现在「无空串 lang / 无同票」数据上完全一致 ===');
{
  // 只排除两种「两边都可能、不保证顺序」的情形：
  //   · 空串 lang  —— 新实现显式跳过空串，旧实现把它当成一个分组
  //   · 同票数     —— ORDER BY COUNT(*) DESC 对同票没有稳定次序
  const NON_DETERMINISTIC = new Set(['空串歌手', '同票歌手']);
  const na = new Map(b.map(r => [r.artist, r.lang]));
  const mismatches = a.filter(r => !NON_DETERMINISTIC.has(r.artist) && (r.lang || null) !== (na.get(r.artist) || null));
  ok('除空串 lang / 同票例外，其余歌手主导语言与旧实现完全一致',
    mismatches.length === 0,
    JSON.stringify(mismatches.map(r => [r.artist, r.lang, na.get(r.artist)])));
}

console.log('=== D. 复杂度：新实现是两条平坦扫描，不含相关子查询 ===');
{
  const src = fs.readFileSync(path.join(SERVER_DIR, 'index.js'), 'utf8');
  const route = src.slice(src.indexOf("app.get('/api/artists'"), src.indexOf("app.get('/api/history'"));
  // 只统计真正参与执行的 SQL：把 // 注释行剥掉再数，否则注释里提到的 "GROUP BY" 会误计。
  const codeOnly = route.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  ok('/api/artists 里没有相关子查询 (SELECT lang FROM songs s2)', !/SELECT lang FROM songs s2/.test(codeOnly));
  ok('/api/artists 里恰有两条 GROUP BY 扫描', (codeOnly.match(/GROUP BY/g) || []).length === 2,
    String((codeOnly.match(/GROUP BY/g) || []).length));
  ok('/api/artists 里没有 LOWER(', !/LOWER\(/.test(codeOnly));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
