-- D1 Migration: 新增 player_medals 資料表
-- 在 Cloudflare Dashboard → D1 → rf-ranking-monitor → Console 貼上執行（分三次）

-- 第一次：
CREATE TABLE IF NOT EXISTS player_medals (
  player_id   TEXT    NOT NULL,
  mode        TEXT    NOT NULL CHECK (mode IN ('1v1', '3v3')),
  rank        INTEGER NOT NULL,
  score       INTEGER NOT NULL DEFAULT 0,
  medal_id    INTEGER,
  captured_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, mode)
);

-- 第二次：
CREATE INDEX IF NOT EXISTS idx_player_medals_mode_score ON player_medals (mode, score DESC, rank ASC);

-- 第三次：
CREATE INDEX IF NOT EXISTS idx_player_medals_mode_rank ON player_medals (mode, rank ASC);
