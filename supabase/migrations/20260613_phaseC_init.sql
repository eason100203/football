-- matches 表新增欄位（Phase C）
ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS api_football_fixture_id INTEGER,
  ADD COLUMN IF NOT EXISTS home_is_giver BOOLEAN,
  ADD COLUMN IF NOT EXISTS score_full JSONB,
  ADD COLUMN IF NOT EXISTS score_half JSONB,
  ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;

-- bets 表新增欄位（Phase C）
ALTER TABLE bets
  ADD COLUMN IF NOT EXISTS inverse BOOLEAN DEFAULT FALSE;

-- 加 index 方便結算查詢
CREATE INDEX IF NOT EXISTS idx_matches_settled_at ON matches(settled_at);
CREATE INDEX IF NOT EXISTS idx_matches_fixture_id ON matches(api_football_fixture_id);
