const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || '/data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'ktv.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS songs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  artist TEXT,
  filename TEXT UNIQUE NOT NULL,
  filepath TEXT NOT NULL,
  cover TEXT,
  duration INTEGER,
  pinyin TEXT,
  play_count INTEGER DEFAULT 0,
  audio_tracks INTEGER,
  media_type TEXT DEFAULT 'video',
  lyrics_path TEXT,
  lrc_karaoke INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id INTEGER NOT NULL,
  nickname TEXT DEFAULT '匿名歌手',
  is_top INTEGER DEFAULT 0,
  status TEXT DEFAULT 'waiting', -- waiting | playing | done
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (song_id) REFERENCES songs(id)
);

CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id INTEGER NOT NULL,
  nickname TEXT,
  played_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(song_id, device_id)
);

-- 简单的键值配置表。目前只用来存「曲库管理」的管理员密码哈希
-- (key = 'admin_password_hash')：密码不再通过安装/升级向导收集、也不再
-- 写进 docker-compose.yml 的环境变量，而是首次打开「曲库管理」时由用户
-- 自己设置，存在这张表里（跟随 /data 一起持久化，升级、容器重建都不受
-- 影响）。
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id INTEGER NOT NULL,
  score REAL NOT NULL,
  grade TEXT,
  device TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_scores_song ON scores(song_id, score DESC);
CREATE INDEX IF NOT EXISTS idx_scores_time ON scores(created_at DESC);
`);

// Bug修复：老版本数据库里没有 audio_tracks 列，CREATE TABLE IF NOT EXISTS 对已存在的
// 表不会补列，这里做一次幂等迁移，升级安装时也能补上，不影响已有数据。
try {
  const cols = db.prepare("PRAGMA table_info(songs)").all().map(c => c.name);
  if (!cols.includes('audio_tracks')) {
    db.exec('ALTER TABLE songs ADD COLUMN audio_tracks INTEGER');
  }
  if (!cols.includes('media_type')) {
    db.exec("ALTER TABLE songs ADD COLUMN media_type TEXT DEFAULT 'video'");
  }
  if (!cols.includes('lyrics_path')) {
    db.exec('ALTER TABLE songs ADD COLUMN lyrics_path TEXT');
  }
  if (!cols.includes('lrc_karaoke')) {
    // 逐字歌词标记：0=普通 LRC，1=含 <mm:ss.xx> 逐字标签（lrcx / .lrcx 文件）
    db.exec('ALTER TABLE songs ADD COLUMN lrc_karaoke INTEGER');
  }
  if (!cols.includes('lang')) {
    db.exec('ALTER TABLE songs ADD COLUMN lang TEXT');
  }
} catch (e) { console.error('歌曲媒体字段迁移失败:', e.message); }

// 40,000 首以上曲库的歌名搜索：优先使用 SQLite FTS5 trigram 索引，支持
// 中文/英文歌名的任意片段匹配，避免每次输入都对 songs 做全表 LIKE 扫描。
// 如果当前 SQLite 构建不带 FTS5，保留 LIKE 兜底，不影响原系统启动。
try {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_songs_artist_title ON songs(artist, title);
    CREATE INDEX IF NOT EXISTS idx_songs_play_count ON songs(play_count DESC, id DESC);
    CREATE VIRTUAL TABLE IF NOT EXISTS songs_fts USING fts5(
      title, artist, content='songs', content_rowid='id', tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS songs_fts_ai AFTER INSERT ON songs BEGIN
      INSERT INTO songs_fts(rowid, title, artist) VALUES (new.id, new.title, coalesce(new.artist, ''));
    END;
    CREATE TRIGGER IF NOT EXISTS songs_fts_ad AFTER DELETE ON songs BEGIN
      INSERT INTO songs_fts(songs_fts, rowid, title, artist)
      VALUES ('delete', old.id, old.title, coalesce(old.artist, ''));
    END;
    CREATE TRIGGER IF NOT EXISTS songs_fts_au AFTER UPDATE OF title, artist ON songs BEGIN
      INSERT INTO songs_fts(songs_fts, rowid, title, artist)
      VALUES ('delete', old.id, old.title, coalesce(old.artist, ''));
      INSERT INTO songs_fts(rowid, title, artist) VALUES (new.id, new.title, coalesce(new.artist, ''));
    END;
  `);
  const songCount = db.prepare('SELECT COUNT(*) AS c FROM songs').get().c;
  const ftsCount = db.prepare('SELECT COUNT(*) AS c FROM songs_fts').get().c;
  if (songCount !== ftsCount) db.prepare("INSERT INTO songs_fts(songs_fts) VALUES ('rebuild')").run();
  db.fts5Ready = true;
} catch (e) {
  db.fts5Ready = false;
  console.warn('FTS5 歌曲搜索索引不可用，将使用 LIKE 兼容搜索:', e.message);
}

// 拼音列迁移 + 存量回灌：让点歌面板的「拼音首字母搜索」可用，而不必一次性
// 把整库拉到前端。pinyin 列在建表语句里已存在，这里补上 pinyin_initial(首字母)，
// 并为两张列建索引；对历史上拼音为空的存量歌曲一次性补算。
try {
  const cols = db.prepare("PRAGMA table_info(songs)").all().map(c => c.name);
  if (!cols.includes('pinyin_initial')) {
    db.exec('ALTER TABLE songs ADD COLUMN pinyin_initial TEXT');
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_songs_pinyin ON songs(pinyin);
    CREATE INDEX IF NOT EXISTS idx_songs_pinyin_initial ON songs(pinyin_initial);
  `);
  const { toPinyin, toPinyinInitial } = require('./pinyin');
  if (toPinyin) {
    const nullCount = db.prepare("SELECT COUNT(*) c FROM songs WHERE pinyin IS NULL OR pinyin_initial IS NULL").get().c;
    if (nullCount > 0) {
      // 一次性同步补算：4 万首约 1~2s，仅模块加载时跑一次，且仅在确有空值时执行。
      const pending = db.prepare('SELECT id, title FROM songs WHERE pinyin IS NULL OR pinyin_initial IS NULL').all();
      const upd = db.prepare('UPDATE songs SET pinyin = ?, pinyin_initial = ? WHERE id = ?');
      const tx = db.transaction(() => {
        for (const r of pending) upd.run(toPinyin(r.title), toPinyinInitial(r.title), r.id);
      });
      tx();
      console.log(`[pinyin] 已为 ${pending.length} 首存量歌曲补齐拼音`);
    }
  }
} catch (e) {
  console.error('拼音列迁移/回灌失败:', e.message);
}

// 语言列迁移 + 存量回灌：歌曲按语言(中文/粤语/英语/韩语/日语)分类，
// 供歌星/点歌/搜索面板按语言筛选。韩语(谚文)、日语(假名)、英语(纯拉丁)按字符
// 判定；粤语/中文同为汉字，靠「已知粤语歌手」名单判定(见 server/lang.js)。
try {
  // 复合索引而非单列索引：列表默认按 play_count DESC, id DESC 排序，单列
  // idx_songs_lang 只能定位到语言、排序仍要临时 B-tree 全量排序（实测 4 万首
  // 约 1.95ms）；把排序列一起放进索引后，ORDER BY 直接由索引顺序满足，
  // 实测降到 0.07ms（约 28 倍）。带 lang 前缀，纯 `WHERE lang=?` 也能命中。
  db.exec('CREATE INDEX IF NOT EXISTS idx_songs_lang_rank ON songs(lang, play_count DESC, id DESC)');
  const { detectLang } = require('./lang');
  const nullCount = db.prepare('SELECT COUNT(*) c FROM songs WHERE lang IS NULL').get().c;
  if (nullCount > 0) {
    // 一次性同步补算：4 万首约 1~2s，仅模块加载时跑一次，且仅在确有空值时执行。
    const pending = db.prepare('SELECT id, title, artist FROM songs WHERE lang IS NULL').all();
    const upd = db.prepare('UPDATE songs SET lang = ? WHERE id = ?');
    const tx = db.transaction(() => {
      for (const r of pending) upd.run(detectLang(r.title, r.artist), r.id);
    });
    tx();
    console.log(`[lang] 已为 ${pending.length} 首存量歌曲补齐语言标签`);
  }
} catch (e) {
  console.error('语言列迁移/回灌失败:', e.message);
}

module.exports = db;
