-- 豚宝宝 2FA 助手 - SQLite 数据库表结构（含登录鉴权与 AES-256-GCM 信封加密）
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    enc_dek TEXT NOT NULL DEFAULT '',
    enc_salt TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    secret TEXT NOT NULL,
    digits INTEGER NOT NULL DEFAULT 6,
    period INTEGER NOT NULL DEFAULT 30,
    algorithm TEXT NOT NULL DEFAULT 'SHA-1',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tokens_created_at ON tokens (created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
