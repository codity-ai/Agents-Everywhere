import { Database } from "bun:sqlite"

/**
 * Schema versions, applied in order and recorded in `schema_version`. Append
 * only: a shipped migration never changes, because a database that already ran
 * it will not run it again.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    os_shell TEXT NOT NULL,
    location_label TEXT,
    task TEXT NOT NULL,
    model_provider TEXT NOT NULL,
    model_name TEXT NOT NULL,
    llm_api_key_sealed TEXT,
    interactive INTEGER NOT NULL DEFAULT 0,
    permission_mode TEXT NOT NULL DEFAULT 'strict',
    permission_request_timeout_seconds INTEGER NOT NULL DEFAULT 900,
    declared_env_vars TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE agent_permissions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    path_pattern TEXT NOT NULL,
    access TEXT NOT NULL,
    kind TEXT NOT NULL,
    effect TEXT NOT NULL
  );
  CREATE INDEX agent_permissions_agent ON agent_permissions(agent_id);

  CREATE TABLE agent_secrets (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    reference TEXT NOT NULL,
    key_to_env_var TEXT NOT NULL,
    provider_config TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX agent_secrets_agent ON agent_secrets(agent_id);

  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    hostname TEXT,
    run_env TEXT NOT NULL DEFAULT '{}',
    kill_requested_at TEXT,
    started_at TEXT,
    ended_at TEXT,
    last_heartbeat_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX runs_agent ON runs(agent_id, created_at);
  CREATE INDEX runs_status ON runs(status);

  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX events_run ON events(run_id, seq);

  CREATE TABLE permission_requests (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    engine_request_id TEXT NOT NULL,
    permission TEXT NOT NULL,
    patterns TEXT NOT NULL DEFAULT '[]',
    metadata TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    decided_at TEXT,
    delivered_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (run_id, engine_request_id)
  );
  CREATE INDEX permission_requests_agent ON permission_requests(agent_id, status);

  CREATE TABLE admin (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    token_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    csrf_token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE agents ADD COLUMN rejection_yaml TEXT NOT NULL DEFAULT '';
  ALTER TABLE agents ADD COLUMN use_global_config INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE global_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    yaml TEXT NOT NULL,
    revision INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS runs_agent_pagination ON runs(agent_id, created_at DESC, id DESC);
  `,
]

export function openDatabase(file: string): Database {
  const db = new Database(file, { create: true, strict: true })
  // First, so a restart that overlaps the old process waits for its lock instead of failing.
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA foreign_keys = ON")
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")
  const row = db.query<{ version: number }, []>("SELECT version FROM schema_version").get()
  const current = row?.version ?? 0
  if (current > MIGRATIONS.length) {
    throw new Error(
      `The database at ${file} was written by a newer control plane (schema ${current}); upgrade before opening it.`,
    )
  }
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version])
      db.exec("DELETE FROM schema_version")
      db.query("INSERT INTO schema_version (version) VALUES (?)").run(version + 1)
    })()
  }
  return db
}

export const nowIso = () => new Date().toISOString()
