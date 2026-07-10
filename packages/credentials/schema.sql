-- Shared D1 database bound to the portal and every MCP server as `CREDENTIALS_DB`.
-- One row per (server, key_name). `value` is AES-256-GCM ciphertext: base64(iv[12] || ciphertext+tag),
-- encrypted with the ENCRYPTION_KEY secret that is set once and shared across every worker in this repo.
CREATE TABLE IF NOT EXISTS credentials (
  server TEXT NOT NULL,
  key_name TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (server, key_name)
);
