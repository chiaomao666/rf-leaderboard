CREATE TABLE IF NOT EXISTS ranking_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL CHECK (mode IN ('1v1', '3v3', '5v5')),
  captured_at INTEGER NOT NULL,
  entry_count INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ranking_snapshots_mode_time ON ranking_snapshots(mode, captured_at DESC);
