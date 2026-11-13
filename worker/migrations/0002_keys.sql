-- 書き込み用の鍵と招待（正本はこのD1。GitHubには置かない）
-- 鍵と招待コードそのものは保存せず、SHA-256 のハッシュ値だけを持つ。
CREATE TABLE IF NOT EXISTS write_keys (
  key_hash TEXT PRIMARY KEY,
  author TEXT NOT NULL,
  created TEXT NOT NULL,       -- UTC の日時（ISO 8601）
  invited_by TEXT NOT NULL,
  onboarded TEXT,              -- この鍵で初めてレシピを登録・改訂した日時。それまでは他の人を招待できない
  revoked TEXT                 -- 取り消した日時。有効なら NULL
);
CREATE INDEX IF NOT EXISTS idx_write_keys_author ON write_keys (author);

CREATE TABLE IF NOT EXISTS invites (
  code_hash TEXT PRIMARY KEY,
  author TEXT NOT NULL,        -- この招待で鍵を受け取る人の作者名
  created_by TEXT NOT NULL,
  created TEXT NOT NULL,
  expires TEXT NOT NULL,
  used TEXT                    -- 使った日時。未使用なら NULL
);
CREATE INDEX IF NOT EXISTS idx_invites_author ON invites (author);
