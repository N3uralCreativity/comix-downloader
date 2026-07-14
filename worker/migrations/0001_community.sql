CREATE TABLE IF NOT EXISTS user_tenure (
  user_hash TEXT PRIMARY KEY
    CHECK (length(user_hash) BETWEEN 8 AND 64 AND user_hash NOT GLOB '*[^0-9a-f]*'),
  first_seen TEXT NOT NULL CHECK (length(first_seen) = 10)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS chapter_flags (
  chapter TEXT NOT NULL
    CHECK (length(chapter) BETWEEN 8 AND 64 AND chapter NOT GLOB '*[^0-9a-f]*'),
  user_hash TEXT NOT NULL
    CHECK (length(user_hash) BETWEEN 8 AND 64 AND user_hash NOT GLOB '*[^0-9a-f]*'),
  type TEXT NOT NULL CHECK (type IN ('broken', 'missing', 'wrong')),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  PRIMARY KEY (chapter, user_hash)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS chapter_flags_active_counts
  ON chapter_flags (chapter, expires_at, type);

CREATE INDEX IF NOT EXISTS chapter_flags_expiry
  ON chapter_flags (expires_at);
