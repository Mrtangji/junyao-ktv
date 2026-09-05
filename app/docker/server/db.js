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

module.exports = db;
