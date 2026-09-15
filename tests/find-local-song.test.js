// 回归测试：findLocalSong 改用 fts5 trigram 子串索引后语义不变。
//
// 背景：歌手批量下载会对每一首歌调一次 findLocalSong（数万次），原实现用
//   SELECT * FROM songs WHERE title LIKE ? 对全库做全表扫（4 万曲库每次约 1.6~2ms，
//   不命中最坏 ~1.6ms）。现对 ≥3 字歌名改走 songs_fts 的 trigram 子串索引
//   （命中 ~0.3ms、不命中 ~0.01ms）。本测试锁住"fts 路径 == 老 LIKE 路径"的等价性，
//   并覆盖特殊字符歌名（fts5 MATCH 语法符）与 exts/mediaType 过滤。
//
// 跑法（仓库根目录）：
//   NODE_PATH='C:\Users\Administrator\.workbuddy\binaries\node\workspace\node_modules' \
//   node tests/find-local-song.test.js
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const SERVER_DIR = path.join(__dirname, '..', 'app', 'docker', 'server');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fls-'));
process.env.DATA_DIR = tmp; // 必须在 require db 之前设置

const db = require(path.join(SERVER_DIR, 'db.js'));
const lx = require(path.join(SERVER_DIR, 'lxmusic.js'));

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { (c ? pass++ : fail++); console.log(`${c ? '✓' : '✗'} ${n}${e ? ' — ' + e : ''}`); };

// ---------- 造数据 ----------
console.log('fts5Ready =', db.fts5Ready);
const ins = db.prepare(
  'INSERT INTO songs (title, artist, filename, filepath, media_type, pinyin, pinyin_initial, lang) ' +
  'VALUES (@title,@artist,@filename,@filepath,@media_type,@pinyin,@pinyin_initial,@lang)'
);
const seed = [
  ['晴天', '周杰伦', 'zjl-qing.mp3', 'audio', 'zh'],
  ['七里香', '周杰伦', 'zjl-qlx.mp3', 'audio', 'zh'],
  ['歌(remix)版', '周杰伦', 'zjl-rm.mp3', 'audio', 'zh'],           // 含 fts5 语法符 ()
  ['爱你一万年', '周杰伦', 'zjl-an.mp3', 'audio', 'zh'],
  ['晴天', '刘瑞', 'lr-qing.mp3', 'audio', 'zh'],                   // 同名不同歌手
  ['OAOA', '五月天', 'myt-oa.flac', 'audio', 'en'],                 // FLAC
  ['OAOA', '五月天', 'myt-oa.mp4', 'video', 'en'],                  // 同名的 MV
  ['Do You Ever Shine', '五月天', 'myt-dy.mp3', 'audio', 'en'],
  ['日本語の歌', '五月天', 'myt-jp.mp3', 'audio', 'jp'],
];
for (const [title, artist, filename, media_type, lang] of seed) {
  ins.run({ title, artist, filename, filepath: '/x/' + filename, media_type, pinyin: title, pinyin_initial: title, lang });
}
if (db.fts5Ready) db.prepare("INSERT INTO songs_fts(songs_fts) VALUES ('rebuild')").run();

// 在某歌名上跑 fts 路径与老 LIKE 路径，断言两者返回的对象一致（同 id 或同为空）
function equiv(name, singer, filter, label) {
  const ftsOn = lx.findLocalSong(name, singer, filter);
  const saved = db.fts5Ready;
  db.fts5Ready = false;                 // 强制走老 LIKE 兜底
  const likeRes = lx.findLocalSong(name, singer, filter);
  db.fts5Ready = saved;
  const a = ftsOn ? ftsOn.id : null;
  const b = likeRes ? likeRes.id : null;
  ok(label, a === b, `fts=${a} like=${b}`);
}

// 1) fts 路径与老 LIKE 路径等价（覆盖各种情形）
equiv('晴天', null, undefined, '同名多歌手/无 singer → 取首行一致');
equiv('晴天', '周杰伦', undefined, '带 singer 过滤一致');
equiv('歌(remix)版', '周杰伦', undefined, '含 fts5 语法符 () 的歌名一致');
equiv('爱你一万年', '周杰伦', undefined, '普通中文歌名一致');
equiv('OAOA', null, { exts: ['flac'] }, 'exts=flac 过滤一致');
equiv('OAOA', null, { mediaTypes: ['video'] }, 'mediaTypes=video 过滤一致');
equiv('不存在的歌xyz', null, undefined, '不命中 → 都返回 null');

// 2) 显式断言关键语义
ok('晴天+周杰伦 命中且歌手正确',
  (() => { const r = lx.findLocalSong('晴天', '周杰伦'); return r && r.artist === '周杰伦' && r.title === '晴天'; })());
ok('晴天 不带 singer 返回某条晴天',
  (() => { const r = lx.findLocalSong('晴天'); return r && r.title === '晴天'; })());
ok('OAOA+exts flac 只返回 flac 行',
  (() => { const r = lx.findLocalSong('OAOA', null, { exts: ['flac'] }); return r && r.filename.endsWith('.flac'); })());
ok('OAOA+mediaTypes video 只返回 video 行',
  (() => { const r = lx.findLocalSong('OAOA', null, { mediaTypes: ['video'] }); return r && r.media_type === 'video'; })());
ok('完全不存在的歌名 → null',
  lx.findLocalSong('这首歌库里绝对没有', null) === null);
ok('空名 → null', lx.findLocalSong('   ', null) === null);
// 子串匹配（findLocalSong 用 LIKE '%title%'，fts trigram 同样是子串）
ok('子串「一万年」能命中《爱你一万年》',
  (() => { const r = lx.findLocalSong('一万年', '周杰伦'); return r && r.title === '爱你一万年'; })());

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAIL'} — pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
