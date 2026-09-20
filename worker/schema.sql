CREATE TABLE IF NOT EXISTS ranking_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL CHECK (mode IN ('1v1', '3v3', '5v5')),
  captured_at INTEGER NOT NULL,
  entry_count INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ranking_snapshots_mode_time ON ranking_snapshots(mode, captured_at DESC);

-- 陣營參照清單（id -> 名稱/旗幟），全玩家共用、幾乎不會變動，用 id 當主鍵直接 upsert。
CREATE TABLE IF NOT EXISTS nations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  title TEXT,
  flag TEXT,
  color_icon TEXT,
  updated_at INTEGER NOT NULL
);
