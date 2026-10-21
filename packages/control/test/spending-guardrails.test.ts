import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "fs"
import os from "os"
import path from "path"
import { openDatabase } from "../src/db"
import { Store, arePayloadsEquivalent, MAX_PAYLOAD_EQUIVALENCE_DEPTH } from "../src/store"
import { AGENT_DEFAULT_FIELDS, parseGlobalYaml } from "../src/configuration"
import { createBootstrapToken, loadKeys } from "../src/crypto"
import { RuntimeApi } from "../src/runtime"
import { HttpError } from "../src/http"
import { RUNNER_CAPABILITY_GUARDRAILS, type HandshakeResponse, type HeartbeatResponse, type RunStatus } from "@agents-everywhere/harness/protocol"
import { z } from "zod"

describe("Phase 2 — Spending Guardrails Database and Configuration", () => {
  let tmpDir: string
  let dbFile: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "guardrails-test-"))
    dbFile = path.join(tmpDir, "control.db")
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("database migration", () => {
    test("fresh database applies all migrations up to version 6", () => {
      const db = openDatabase(dbFile)
      const versionRow = db.query<{ version: number }, []>("SELECT version FROM schema_version").get()
      expect(versionRow?.version).toBe(6)

      // Verify columns exist on fresh schema
      const agentCols = db.query<{ name: string }, []>("PRAGMA table_info(agents)").all()
      expect(agentCols.some((c) => c.name === "spend_limit_usd")).toBe(true)

      const runCols = db.query<{ name: string }, []>("PRAGMA table_info(runs)").all()
      expect(runCols.some((c) => c.name === "spend_limit_usd")).toBe(true)
      expect(runCols.some((c) => c.name === "kill_reason")).toBe(true)

      const eventCols = db.query<{ name: string }, []>("PRAGMA table_info(events)").all()
      expect(eventCols.some((c) => c.name === "client_event_id")).toBe(true)

      // Verify incoming indexes from main exist on fresh schema
      const eventIndices = db.query<{ name: string }, []>("PRAGMA index_list(events)").all()
      expect(eventIndices.some((i) => i.name === "events_created")).toBe(true)

      const runIndices = db.query<{ name: string }, []>("PRAGMA index_list(runs)").all()
      expect(runIndices.some((i) => i.name === "runs_started")).toBe(true)
      expect(runIndices.some((i) => i.name === "runs_ended")).toBe(true)
      db.close()
    })

    test("existing version 1 database migrates safely and preserves existing rows", () => {
      // Step 1: Manually create a version 1 database
      const rawDb = new Database(dbFile, { create: true, strict: true })
      rawDb.exec("PRAGMA foreign_keys = ON")
      rawDb.exec("CREATE TABLE schema_version (version INTEGER NOT NULL)")
      rawDb.exec(`
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
      `)
      rawDb.exec("INSERT INTO schema_version (version) VALUES (1)")

      rawDb
        .query(
          `INSERT INTO agents (id, label, os_shell, task, model_provider, model_name, created_at, updated_at)
           VALUES ('agent_v1', 'V1 Agent', 'linux_bash', 'v1 task', 'anthropic', 'claude', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
        )
        .run()
      rawDb
        .query(
          `INSERT INTO runs (id, agent_id, status, created_at)
           VALUES ('run_v1', 'agent_v1', 'running', '2026-01-01T00:00:00Z')`,
        )
        .run()
      rawDb
        .query(
          `INSERT INTO events (id, run_id, event_type, payload, tokens_in, tokens_out, cost_usd, created_at)
           VALUES ('evt_v1', 'run_v1', 'step', '{}', 10, 5, 0.001, '2026-01-01T00:00:00Z')`,
        )
        .run()
      rawDb.close()

      // Step 2: Open with openDatabase, upgrading from v1 to v6
      const upgradedDb = openDatabase(dbFile)
      const versionRow = upgradedDb.query<{ version: number }, []>("SELECT version FROM schema_version").get()
      expect(versionRow?.version).toBe(6)

      // Step 3: Verify records survived and schema columns/indexes were added
      const agent = upgradedDb
        .query<{ id: string; label: string; rejection_yaml: string; spend_limit_usd: number | null }, []>(
          "SELECT id, label, rejection_yaml, spend_limit_usd FROM agents WHERE id = 'agent_v1'",
        )
        .get()
      expect(agent?.label).toBe("V1 Agent")
      expect(agent?.rejection_yaml).toBe("")
      expect(agent?.spend_limit_usd).toBeNull()

      const run = upgradedDb
        .query<{ id: string; spend_limit_usd: number | null; kill_reason: string | null }, []>(
          "SELECT id, spend_limit_usd, kill_reason FROM runs WHERE id = 'run_v1'",
        )
        .get()
      expect(run?.spend_limit_usd).toBeNull()
      expect(run?.kill_reason).toBeNull()

      const eventIndices = upgradedDb.query<{ name: string }, []>("PRAGMA index_list(events)").all()
      expect(eventIndices.some((i) => i.name === "events_created")).toBe(true)
      expect(eventIndices.some((i) => i.name === "idx_events_run_client_event_id")).toBe(true)

      const runIndices = upgradedDb.query<{ name: string }, []>("PRAGMA index_list(runs)").all()
      expect(runIndices.some((i) => i.name === "runs_started")).toBe(true)
      expect(runIndices.some((i) => i.name === "runs_ended")).toBe(true)

      upgradedDb.close()
    })

    test("existing version 2 database migrates safely and preserves existing rows", () => {
      // Step 1: Manually create a version 2 database with schema 0 and 1
      const rawDb = new Database(dbFile, { create: true, strict: true })
      rawDb.exec("PRAGMA foreign_keys = ON")
      rawDb.exec("CREATE TABLE schema_version (version INTEGER NOT NULL)")
      rawDb.exec(`
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
          updated_at TEXT NOT NULL,
          rejection_yaml TEXT NOT NULL DEFAULT '',
          use_global_config INTEGER NOT NULL DEFAULT 0
        );
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
        CREATE TABLE global_config (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          yaml TEXT NOT NULL,
          revision INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );
      `)
      rawDb.exec("INSERT INTO schema_version (version) VALUES (2)")

      // Insert pre-existing agent and run without spend_limit_usd
      rawDb
        .query(
          `INSERT INTO agents (id, label, os_shell, task, model_provider, model_name, created_at, updated_at)
           VALUES ('agent_v2', 'Legacy Agent', 'linux_bash', 'legacy task', 'anthropic', 'claude', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
        )
        .run()
      rawDb
        .query(
          `INSERT INTO runs (id, agent_id, status, created_at)
           VALUES ('run_v2', 'agent_v2', 'running', '2026-01-01T00:00:00Z')`,
        )
        .run()
      rawDb
        .query(
          `INSERT INTO events (id, run_id, event_type, payload, tokens_in, tokens_out, cost_usd, created_at)
           VALUES ('evt_v2', 'run_v2', 'step', '{}', 10, 5, 0.001, '2026-01-01T00:00:00Z')`,
        )
        .run()
      rawDb.close()

      // Step 2: Open with openDatabase, which should trigger Migrations 2, 3, 4, and 5
      const upgradedDb = openDatabase(dbFile)
      const versionRow = upgradedDb.query<{ version: number }, []>("SELECT version FROM schema_version").get()
      expect(versionRow?.version).toBe(6)

      // Step 3: Verify legacy records survived with spend_limit_usd === null
      const legacyAgent = upgradedDb
        .query<{ id: string; label: string; spend_limit_usd: number | null }, []>(
          "SELECT id, label, spend_limit_usd FROM agents WHERE id = 'agent_v2'",
        )
        .get()
      expect(legacyAgent).not.toBeNull()
      expect(legacyAgent?.label).toBe("Legacy Agent")
      expect(legacyAgent?.spend_limit_usd).toBeNull()

      const legacyRun = upgradedDb
        .query<{ id: string; spend_limit_usd: number | null; kill_reason: string | null }, []>(
          "SELECT id, spend_limit_usd, kill_reason FROM runs WHERE id = 'run_v2'",
        )
        .get()
      expect(legacyRun).not.toBeNull()
      expect(legacyRun?.spend_limit_usd).toBeNull()
      expect(legacyRun?.kill_reason).toBeNull()

      const legacyEvent = upgradedDb
        .query<{ id: string; client_event_id: string | null }, []>(
          "SELECT id, client_event_id FROM events WHERE id = 'evt_v2'",
        )
        .get()
      expect(legacyEvent).not.toBeNull()
      expect(legacyEvent?.client_event_id).toBeNull()

      const eventIndices = upgradedDb.query<{ name: string }, []>("PRAGMA index_list(events)").all()
      expect(eventIndices.some((i) => i.name === "events_created")).toBe(true)
      expect(eventIndices.some((i) => i.name === "idx_events_run_client_event_id")).toBe(true)

      const runIndices = upgradedDb.query<{ name: string }, []>("PRAGMA index_list(runs)").all()
      expect(runIndices.some((i) => i.name === "runs_started")).toBe(true)
      expect(runIndices.some((i) => i.name === "runs_ended")).toBe(true)

      upgradedDb.close()
    })

    test("existing version 3 database (with pagination index) migrates safely to version 6", () => {
      // Step 1: Create a version 3 database
      const rawDb = new Database(dbFile, { create: true, strict: true })
      rawDb.exec("PRAGMA foreign_keys = ON")
      rawDb.exec("CREATE TABLE schema_version (version INTEGER NOT NULL)")
      rawDb.exec(`
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
          updated_at TEXT NOT NULL,
          rejection_yaml TEXT NOT NULL DEFAULT '',
          use_global_config INTEGER NOT NULL DEFAULT 0
        );
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
        CREATE TABLE global_config (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          yaml TEXT NOT NULL,
          revision INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS runs_agent_pagination ON runs(agent_id, created_at DESC, id DESC);
      `)
      rawDb.exec("INSERT INTO schema_version (version) VALUES (3)")

      rawDb
        .query(
          `INSERT INTO agents (id, label, os_shell, task, model_provider, model_name, created_at, updated_at)
           VALUES ('agent_v3', 'V3 Agent', 'linux_bash', 'v3 task', 'anthropic', 'claude', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
        )
        .run()
      rawDb
        .query(
          `INSERT INTO runs (id, agent_id, status, created_at)
           VALUES ('run_v3', 'agent_v3', 'running', '2026-01-01T00:00:00Z')`,
        )
        .run()
      rawDb.close()

      // Step 2: Open with openDatabase, upgrading from v3 to v6
      const upgradedDb = openDatabase(dbFile)
      const versionRow = upgradedDb.query<{ version: number }, []>("SELECT version FROM schema_version").get()
      expect(versionRow?.version).toBe(6)

      // Step 3: Verify records and schema
      const agent = upgradedDb
        .query<{ id: string; spend_limit_usd: number | null }, []>(
          "SELECT id, spend_limit_usd FROM agents WHERE id = 'agent_v3'",
        )
        .get()
      expect(agent?.spend_limit_usd).toBeNull()

      const run = upgradedDb
        .query<{ id: string; spend_limit_usd: number | null; kill_reason: string | null }, []>(
          "SELECT id, spend_limit_usd, kill_reason FROM runs WHERE id = 'run_v3'",
        )
        .get()
      expect(run?.spend_limit_usd).toBeNull()
      expect(run?.kill_reason).toBeNull()

      const eventIndices = upgradedDb.query<{ name: string }, []>("PRAGMA index_list(events)").all()
      expect(eventIndices.some((i) => i.name === "events_created")).toBe(true)
      expect(eventIndices.some((i) => i.name === "idx_events_run_client_event_id")).toBe(true)

      const runIndices = upgradedDb.query<{ name: string }, []>("PRAGMA index_list(runs)").all()
      expect(runIndices.some((i) => i.name === "runs_started")).toBe(true)
      expect(runIndices.some((i) => i.name === "runs_ended")).toBe(true)

      upgradedDb.close()
    })

    test("existing version 4 database (with activity metric indexes) migrates safely to version 6", () => {
      // Step 1: Create a version 4 database
      const rawDb = new Database(dbFile, { create: true, strict: true })
      rawDb.exec("PRAGMA foreign_keys = ON")
      rawDb.exec("CREATE TABLE schema_version (version INTEGER NOT NULL)")
      rawDb.exec(`
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
          updated_at TEXT NOT NULL,
          rejection_yaml TEXT NOT NULL DEFAULT '',
          use_global_config INTEGER NOT NULL DEFAULT 0
        );
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
        CREATE TABLE global_config (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          yaml TEXT NOT NULL,
          revision INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS runs_agent_pagination ON runs(agent_id, created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS events_created ON events(created_at);
        CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at);
        CREATE INDEX IF NOT EXISTS runs_ended ON runs(ended_at);
      `)
      rawDb.exec("INSERT INTO schema_version (version) VALUES (4)")

      rawDb
        .query(
          `INSERT INTO agents (id, label, os_shell, task, model_provider, model_name, created_at, updated_at)
           VALUES ('agent_v4', 'V4 Agent', 'linux_bash', 'v4 task', 'anthropic', 'claude', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
        )
        .run()
      rawDb
        .query(
          `INSERT INTO runs (id, agent_id, status, created_at)
           VALUES ('run_v4', 'agent_v4', 'running', '2026-01-01T00:00:00Z')`,
        )
        .run()
      rawDb.close()

      // Step 2: Open with openDatabase, upgrading from v4 to v6
      const upgradedDb = openDatabase(dbFile)
      const versionRow = upgradedDb.query<{ version: number }, []>("SELECT version FROM schema_version").get()
      expect(versionRow?.version).toBe(6)

      // Step 3: Verify records and schema
      const agent = upgradedDb
        .query<{ id: string; spend_limit_usd: number | null }, []>(
          "SELECT id, spend_limit_usd FROM agents WHERE id = 'agent_v4'",
        )
        .get()
      expect(agent?.spend_limit_usd).toBeNull()

      const run = upgradedDb
        .query<{ id: string; spend_limit_usd: number | null; kill_reason: string | null }, []>(
          "SELECT id, spend_limit_usd, kill_reason FROM runs WHERE id = 'run_v4'",
        )
        .get()
      expect(run?.spend_limit_usd).toBeNull()
      expect(run?.kill_reason).toBeNull()

      const eventIndices = upgradedDb.query<{ name: string }, []>("PRAGMA index_list(events)").all()
      expect(eventIndices.some((i) => i.name === "events_created")).toBe(true)
      expect(eventIndices.some((i) => i.name === "idx_events_run_client_event_id")).toBe(true)

      const runIndices = upgradedDb.query<{ name: string }, []>("PRAGMA index_list(runs)").all()
      expect(runIndices.some((i) => i.name === "runs_started")).toBe(true)
      expect(runIndices.some((i) => i.name === "runs_ended")).toBe(true)

      upgradedDb.close()
    })

    test("existing version 5 database (with spend_limit_usd columns) migrates safely to version 6", () => {
      // Step 1: Create a version 5 database (includes spend_limit_usd on agents and runs)
      const rawDb = new Database(dbFile, { create: true, strict: true })
      rawDb.exec("PRAGMA foreign_keys = ON")
      rawDb.exec("CREATE TABLE schema_version (version INTEGER NOT NULL)")
      rawDb.exec(`
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
          updated_at TEXT NOT NULL,
          rejection_yaml TEXT NOT NULL DEFAULT '',
          use_global_config INTEGER NOT NULL DEFAULT 0,
          spend_limit_usd REAL
        );
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
          created_at TEXT NOT NULL,
          spend_limit_usd REAL
        );
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
        CREATE TABLE global_config (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          yaml TEXT NOT NULL,
          revision INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS runs_agent_pagination ON runs(agent_id, created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS events_created ON events(created_at);
        CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at);
        CREATE INDEX IF NOT EXISTS runs_ended ON runs(ended_at);
      `)
      rawDb.exec("INSERT INTO schema_version (version) VALUES (5)")

      rawDb
        .query(
          `INSERT INTO agents (id, label, os_shell, task, model_provider, model_name, created_at, updated_at, spend_limit_usd)
           VALUES ('agent_v5', 'V5 Agent', 'linux_bash', 'v5 task', 'anthropic', 'claude', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 25.50)`,
        )
        .run()
      rawDb
        .query(
          `INSERT INTO runs (id, agent_id, status, created_at, spend_limit_usd)
           VALUES ('run_v5', 'agent_v5', 'running', '2026-01-01T00:00:00Z', 25.50)`,
        )
        .run()
      rawDb
        .query(
          `INSERT INTO events (id, run_id, event_type, payload, tokens_in, tokens_out, cost_usd, created_at)
           VALUES ('evt_v5', 'run_v5', 'step', '{}', 10, 5, 0.001, '2026-01-01T00:00:00Z')`,
        )
        .run()
      rawDb.close()

      // Step 2: Open with openDatabase, upgrading from v5 to v6
      const upgradedDb = openDatabase(dbFile)
      const versionRow = upgradedDb.query<{ version: number }, []>("SELECT version FROM schema_version").get()
      expect(versionRow?.version).toBe(6)

      // Step 3: Verify existing data and new columns/indexes
      const agent = upgradedDb
        .query<{ id: string; spend_limit_usd: number | null }, []>(
          "SELECT id, spend_limit_usd FROM agents WHERE id = 'agent_v5'",
        )
        .get()
      expect(agent?.spend_limit_usd).toBe(25.50)

      const run = upgradedDb
        .query<{ id: string; spend_limit_usd: number | null; kill_reason: string | null }, []>(
          "SELECT id, spend_limit_usd, kill_reason FROM runs WHERE id = 'run_v5'",
        )
        .get()
      expect(run?.spend_limit_usd).toBe(25.50)
      expect(run?.kill_reason).toBeNull()

      const event = upgradedDb
        .query<{ id: string; client_event_id: string | null }, []>(
          "SELECT id, client_event_id FROM events WHERE id = 'evt_v5'",
        )
        .get()
      expect(event?.client_event_id).toBeNull()

      const eventIndices = upgradedDb.query<{ name: string }, []>("PRAGMA index_list(events)").all()
      expect(eventIndices.some((i) => i.name === "idx_events_run_client_event_id")).toBe(true)

      upgradedDb.close()
    })

    test("migration idempotency: reopening an already-migrated database does not re-apply migrations or bump version", () => {
      const db1 = openDatabase(dbFile)
      expect(db1.query<{ version: number }, []>("SELECT version FROM schema_version").get()?.version).toBe(6)
      db1
        .query(
          `INSERT INTO agents (id, label, os_shell, task, model_provider, model_name, created_at, updated_at, spend_limit_usd)
           VALUES ('agent_idem', 'Idem Agent', 'linux_bash', 'task', 'anthropic', 'claude', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 10.0)`,
        )
        .run()
      db1.close()

      // Reopening must not fail, duplicate migrations, or change version
      const db2 = openDatabase(dbFile)
      expect(db2.query<{ version: number }, []>("SELECT version FROM schema_version").get()?.version).toBe(6)
      const agent = db2
        .query<{ id: string; spend_limit_usd: number }, []>("SELECT id, spend_limit_usd FROM agents WHERE id = 'agent_idem'")
        .get()
      expect(agent?.spend_limit_usd).toBe(10.0)
      db2.close()
    })

    test("reopening database written by newer control plane throws clear upgrade error", () => {
      const rawDb = new Database(dbFile, { create: true, strict: true })
      rawDb.exec("CREATE TABLE schema_version (version INTEGER NOT NULL)")
      rawDb.exec("INSERT INTO schema_version (version) VALUES (99)")
      rawDb.close()

      expect(() => openDatabase(dbFile)).toThrow(/newer control plane \(schema 99\)/)
    })
  })

  describe("configuration validation", () => {
    const SpendLimitSchema = z.object({
      spend_limit_usd: AGENT_DEFAULT_FIELDS.spend_limit_usd,
    })

    test("accepts valid positive numbers and null/undefined", () => {
      expect(SpendLimitSchema.parse({ spend_limit_usd: 10 }).spend_limit_usd).toBe(10)
      expect(SpendLimitSchema.parse({ spend_limit_usd: 0.5 }).spend_limit_usd).toBe(0.5)
      expect(SpendLimitSchema.parse({ spend_limit_usd: 100_000 }).spend_limit_usd).toBe(100_000)
      expect(SpendLimitSchema.parse({ spend_limit_usd: null }).spend_limit_usd).toBeNull()
      expect(SpendLimitSchema.parse({}).spend_limit_usd).toBeUndefined()
    })

    test("rejects zero", () => {
      const result = SpendLimitSchema.safeParse({ spend_limit_usd: 0 })
      expect(result.success).toBe(false)
    })

    test("rejects negative numbers", () => {
      const result = SpendLimitSchema.safeParse({ spend_limit_usd: -5 })
      expect(result.success).toBe(false)
    })

    test("rejects non-finite values (Infinity, NaN)", () => {
      expect(SpendLimitSchema.safeParse({ spend_limit_usd: Infinity }).success).toBe(false)
      expect(SpendLimitSchema.safeParse({ spend_limit_usd: -Infinity }).success).toBe(false)
      expect(SpendLimitSchema.safeParse({ spend_limit_usd: NaN }).success).toBe(false)
    })

    test("rejects values exceeding max cap", () => {
      const result = SpendLimitSchema.safeParse({ spend_limit_usd: 100_001 })
      expect(result.success).toBe(false)
    })

    test("global config accepts optional defaults.spend_limit_usd", () => {
      const validYaml = `
version: 1
permissions: []
defaults:
  spend_limit_usd: 25.50
`
      const parsed = parseGlobalYaml(validYaml)
      expect(parsed.defaults.spend_limit_usd).toBe(25.5)
    })

    test("global config rejects invalid defaults.spend_limit_usd (e.g. zero or negative)", () => {
      const zeroYaml = `
version: 1
permissions: []
defaults:
  spend_limit_usd: 0
`
      expect(() => parseGlobalYaml(zeroYaml)).toThrow()

      const negativeYaml = `
version: 1
permissions: []
defaults:
  spend_limit_usd: -10
`
      expect(() => parseGlobalYaml(negativeYaml)).toThrow()
    })
  })

  describe("run-level budget snapshots and isolation", () => {
    test("run snapshots agent spend_limit_usd at creation and remains stable when agent updates", () => {
      const db = openDatabase(dbFile)
      const store = new Store(db)

      // 1. Create an agent with spend_limit_usd = 12.50
      const agentId = store.createAgent(
        {
          label: "Budgeted Agent",
          os_shell: "linux_bash",
          location_label: "worker-1",
          task: "Run tasks within budget",
          model_provider: "anthropic",
          model_name: "claude-3-5-sonnet",
          llm_api_key_sealed: null,
          interactive: false,
          permission_mode: "strict",
          permission_request_timeout_seconds: 900,
          declared_env_vars: [],
          spend_limit_usd: 12.5,
        },
        [],
        [],
      )

      const agent = store.getAgent(agentId)!
      expect(agent.spend_limit_usd).toBe(12.5)

      // 2. Create a pending run
      const runId = store.createPendingRun(agentId)
      const run1 = store.getRun(runId)!
      expect(run1.spend_limit_usd).toBe(12.5)

      // 3. Update the agent's spend_limit_usd to 50.00
      store.updateAgent(agentId, { spend_limit_usd: 50.0 })

      // Verify agent was updated
      const updatedAgent = store.getAgent(agentId)!
      expect(updatedAgent.spend_limit_usd).toBe(50.0)

      // 4. CRITICAL ISOLATION CHECK: Verify the existing run's snapshot is STILL 12.50
      const run1AfterAgentUpdate = store.getRun(runId)!
      expect(run1AfterAgentUpdate.spend_limit_usd).toBe(12.5)

      // 5. A newly created run gets the updated snapshot (50.00)
      const runId2 = store.createPendingRun(agentId)
      const run2 = store.getRun(runId2)!
      expect(run2.spend_limit_usd).toBe(50.0)

      db.close()
    })

    test("agent with null spend_limit_usd creates runs with null spend_limit_usd", () => {
      const db = openDatabase(dbFile)
      const store = new Store(db)

      const agentId = store.createAgent(
        {
          label: "Unlimited Agent",
          os_shell: "linux_bash",
          location_label: null,
          task: "Run without limits",
          model_provider: "anthropic",
          model_name: "claude-3-5-sonnet",
          llm_api_key_sealed: null,
          interactive: false,
          permission_mode: "strict",
          permission_request_timeout_seconds: 900,
          declared_env_vars: [],
          spend_limit_usd: null,
        },
        [],
        [],
      )

      const runId = store.createPendingRun(agentId)
      const run = store.getRun(runId)!
      expect(run.spend_limit_usd).toBeNull()

      db.close()
    })

    test("runUsage accurately aggregates known cost and tracks unpriced usage", () => {
      const db = openDatabase(dbFile)
      const store = new Store(db)

      const agentId = store.createAgent(
        {
          label: "Usage Agent",
          os_shell: "linux_bash",
          location_label: null,
          task: "Track usage",
          model_provider: "anthropic",
          model_name: "claude-3-5-sonnet",
          llm_api_key_sealed: null,
          interactive: false,
          permission_mode: "strict",
          permission_request_timeout_seconds: 900,
          declared_env_vars: [],
          spend_limit_usd: 20.0,
        },
        [],
        [],
      )

      const runId = store.createPendingRun(agentId)

      // Initially no usage
      expect(store.runUsage(runId)).toEqual({ total_cost: 0, unpriced_count: 0 })

      // Add event with priced cost
      store.addEvent(runId, "step", { message: "step 1" }, { tokensIn: 100, tokensOut: 50, costUsd: 0.05 })
      expect(store.runUsage(runId)).toEqual({ total_cost: 0.05, unpriced_count: 0 })

      // Add another event with priced cost
      store.addEvent(runId, "step", { message: "step 2" }, { tokensIn: 200, tokensOut: 100, costUsd: 0.15 })
      expect(store.runUsage(runId).total_cost).toBeCloseTo(0.2, 5)
      expect(store.runUsage(runId).unpriced_count).toBe(0)

      // Add an unpriced event (tokens > 0, costUsd is null)
      store.addEvent(runId, "step", { message: "step 3 unpriced" }, { tokensIn: 300, tokensOut: 150, costUsd: null })
      const usage = store.runUsage(runId)
      expect(usage.total_cost).toBeCloseTo(0.2, 5)
      expect(usage.unpriced_count).toBe(1)

      // Add a non-usage event (tokens 0, costUsd null) — should NOT count as unpriced usage step
      store.addEvent(runId, "step", { kind: "notice", message: "notice" }, { tokensIn: 0, tokensOut: 0, costUsd: null })
      expect(store.runUsage(runId).unpriced_count).toBe(1)

      db.close()
    })
  })

  describe("Phase 3 — Protocol and Handshake Integration", () => {
    function setupRuntime() {
      const db = openDatabase(dbFile)
      const store = new Store(db)
      const keys = loadKeys(tmpDir)
      const runtime = new RuntimeApi(store, keys, () => {})
      return { db, store, keys, runtime }
    }

    async function callHandshake(
      runtime: RuntimeApi,
      token: string,
      body: { hostname?: string | null; run_env?: Record<string, unknown> },
    ) {
      const req = new Request("http://localhost/agents/runtime/handshake", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      })
      return runtime.handshake(req)
    }

    test("handshake returns the correct run-level budget", async () => {
      const { db, store, keys, runtime } = setupRuntime()
      const agentId = store.createAgent(
        {
          label: "Budgeted Agent",
          os_shell: "linux_bash",
          location_label: null,
          task: "task with limit",
          model_provider: "anthropic",
          model_name: "claude-3-5-sonnet",
          llm_api_key_sealed: null,
          interactive: false,
          permission_mode: "strict",
          permission_request_timeout_seconds: 900,
          declared_env_vars: [],
          spend_limit_usd: 15.5,
        },
        [],
        [],
      )
      const runId = store.createPendingRun(agentId)
      const { token } = createBootstrapToken(keys, agentId, runId)

      const res = await callHandshake(runtime, token, {
        hostname: "host-1",
        run_env: {
          platform: "linux",
          capabilities: [RUNNER_CAPABILITY_GUARDRAILS],
        },
      })
      expect(res.status).toBe(200)
      const data = (await res.json()) as HandshakeResponse
      expect(data.run_id).toBe(runId)
      expect(data.spend_limit_usd).toBe(15.5)

      db.close()
    })

    test("a null budget preserves existing behavior", async () => {
      const { db, store, keys, runtime } = setupRuntime()
      const agentId = store.createAgent(
        {
          label: "Unbudgeted Agent",
          os_shell: "linux_bash",
          location_label: null,
          task: "unlimited task",
          model_provider: "anthropic",
          model_name: "claude-3-5-sonnet",
          llm_api_key_sealed: null,
          interactive: false,
          permission_mode: "strict",
          permission_request_timeout_seconds: 900,
          declared_env_vars: [],
          spend_limit_usd: null,
        },
        [],
        [],
      )
      const runId = store.createPendingRun(agentId)
      const { token } = createBootstrapToken(keys, agentId, runId)

      const res = await callHandshake(runtime, token, {
        hostname: "host-2",
        run_env: {
          platform: "linux",
          capabilities: [RUNNER_CAPABILITY_GUARDRAILS],
        },
      })
      expect(res.status).toBe(200)
      const data = (await res.json()) as HandshakeResponse
      expect(data.spend_limit_usd).toBeNull()

      db.close()
    })

    test("changing an agent's budget does not change an existing run's handshake budget", async () => {
      const { db, store, keys, runtime } = setupRuntime()
      const agentId = store.createAgent(
        {
          label: "Agent 10",
          os_shell: "linux_bash",
          location_label: null,
          task: "task",
          model_provider: "anthropic",
          model_name: "claude-3-5-sonnet",
          llm_api_key_sealed: null,
          interactive: false,
          permission_mode: "strict",
          permission_request_timeout_seconds: 900,
          declared_env_vars: [],
          spend_limit_usd: 10.0,
        },
        [],
        [],
      )
      const runId = store.createPendingRun(agentId)
      const { token } = createBootstrapToken(keys, agentId, runId)

      // Later update the agent configuration to 100.00
      store.updateAgent(agentId, { spend_limit_usd: 100.0 })

      // Connecting runner on the existing run must receive the run's snapshotted budget (10.00)
      const res = await callHandshake(runtime, token, {
        hostname: "host-3",
        run_env: {
          platform: "linux",
          capabilities: [RUNNER_CAPABILITY_GUARDRAILS],
        },
      })
      expect(res.status).toBe(200)
      const data = (await res.json()) as HandshakeResponse
      expect(data.spend_limit_usd).toBe(10.0)

      db.close()
    })

    test("a runner without the required capability cannot start a budgeted run", async () => {
      const { db, store, keys, runtime } = setupRuntime()
      const agentId = store.createAgent(
        {
          label: "Budgeted Agent",
          os_shell: "linux_bash",
          location_label: null,
          task: "task",
          model_provider: "anthropic",
          model_name: "claude-3-5-sonnet",
          llm_api_key_sealed: null,
          interactive: false,
          permission_mode: "strict",
          permission_request_timeout_seconds: 900,
          declared_env_vars: [],
          spend_limit_usd: 25.0,
        },
        [],
        [],
      )
      const runId = store.createPendingRun(agentId)
      const { token } = createBootstrapToken(keys, agentId, runId)

      // Connecting runner only declares legacy capabilities, missing spending_guardrails
      let thrown: HttpError | null = null
      try {
        await callHandshake(runtime, token, {
          hostname: "legacy-host",
          run_env: {
            platform: "linux",
            capabilities: ["transcript", "messages"],
          },
        })
      } catch (err) {
        thrown = err as HttpError
      }

      expect(thrown).not.toBeNull()
      expect(thrown?.status).toBe(400)
      expect(thrown?.message).toContain("spending guardrails")

      // The run in the database must be marked failed
      const run = store.getRun(runId)
      expect(run?.status).toBe("failed")
      expect(run?.ended_at).not.toBeNull()

      db.close()
    })

    test("existing unbudgeted handshake behavior remains compatible without guardrails capability", async () => {
      const { db, store, keys, runtime } = setupRuntime()
      const agentId = store.createAgent(
        {
          label: "Legacy Agent",
          os_shell: "linux_bash",
          location_label: null,
          task: "task",
          model_provider: "anthropic",
          model_name: "claude-3-5-sonnet",
          llm_api_key_sealed: null,
          interactive: false,
          permission_mode: "strict",
          permission_request_timeout_seconds: 900,
          declared_env_vars: [],
          spend_limit_usd: null,
        },
        [],
        [],
      )
      const runId = store.createPendingRun(agentId)
      const { token } = createBootstrapToken(keys, agentId, runId)

      // Older runner provides no capabilities array
      const res = await callHandshake(runtime, token, {
        hostname: "legacy-runner",
        run_env: { platform: "linux" },
      })
      expect(res.status).toBe(200)
      const data = (await res.json()) as HandshakeResponse
      expect(data.spend_limit_usd).toBeNull()

      const run = store.getRun(runId)
      expect(run?.status).toBe("handshaked")

      db.close()
    })

    test("malformed or missing capability data is handled safely", async () => {
      const { db, store, keys, runtime } = setupRuntime()

      // 1. Missing run_env on budgeted run
      const agent1 = store.createAgent(
        {
          label: "Agent 1",
          os_shell: "linux_bash",
          location_label: null,
          task: "task",
          model_provider: "anthropic",
          model_name: "claude-3-5-sonnet",
          llm_api_key_sealed: null,
          interactive: false,
          permission_mode: "strict",
          permission_request_timeout_seconds: 900,
          declared_env_vars: [],
          spend_limit_usd: 5.0,
        },
        [],
        [],
      )
      const run1 = store.createPendingRun(agent1)
      const tok1 = createBootstrapToken(keys, agent1, run1).token
      await expect(callHandshake(runtime, tok1, {})).rejects.toThrow()
      expect(store.getRun(run1)?.status).toBe("failed")

      // 2. capabilities is null on budgeted run
      const run2 = store.createPendingRun(agent1)
      const tok2 = createBootstrapToken(keys, agent1, run2).token
      await expect(callHandshake(runtime, tok2, { run_env: { capabilities: null } })).rejects.toThrow()
      expect(store.getRun(run2)?.status).toBe("failed")

      // 3. capabilities is a string instead of an array on budgeted run
      const run3 = store.createPendingRun(agent1)
      const tok3 = createBootstrapToken(keys, agent1, run3).token
      await expect(
        callHandshake(runtime, tok3, { run_env: { capabilities: "spending_guardrails" } }),
      ).rejects.toThrow()
      expect(store.getRun(run3)?.status).toBe("failed")

      // 4. capabilities contains mixed invalid types along with the valid capability
      const run4 = store.createPendingRun(agent1)
      const tok4 = createBootstrapToken(keys, agent1, run4).token
      const res = await callHandshake(runtime, tok4, {
        run_env: { capabilities: [123, null, RUNNER_CAPABILITY_GUARDRAILS, { foo: "bar" }] },
      })
      expect(res.status).toBe(200)
      const data = (await res.json()) as HandshakeResponse
      expect(data.spend_limit_usd).toBe(5.0)
      expect(store.getRun(run4)?.status).toBe("handshaked")

      db.close()
    })
  })

  describe("Phase 5 — Server-Side Enforcement and Authoritative Deduplication", () => {
    function setupRuntime() {
      const db = openDatabase(dbFile)
      const store = new Store(db)
      const keys = loadKeys(tmpDir)
      const runtime = new RuntimeApi(store, keys, () => {})
      return { db, store, keys, runtime }
    }

    function callEvent(runtime: RuntimeApi, runToken: string, body: unknown) {
      const req = new Request("http://localhost/agents/runtime/events", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${runToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      })
      return runtime.event(req)
    }

    function callFinish(runtime: RuntimeApi, runToken: string, body: unknown) {
      const req = new Request("http://localhost/agents/runtime/finish", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${runToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      })
      return runtime.finish(req)
    }

    function callHandshake(runtime: RuntimeApi, bootstrapToken: string, body: unknown) {
      const req = new Request("http://localhost/agents/runtime/handshake", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bootstrapToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      })
      return runtime.handshake(req)
    }

    function callHeartbeat(runtime: RuntimeApi, runToken: string, body: unknown = {}) {
      const req = new Request("http://localhost/agents/runtime/heartbeat", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${runToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      })
      return runtime.heartbeat(req)
    }

    async function setupActiveRun(
      runtime: RuntimeApi,
      store: Store,
      keys: ReturnType<typeof loadKeys>,
      spendLimitUsd: number | null = 10.0,
    ) {
      const agentId = store.createAgent(
        {
          label: "Test Agent",
          os_shell: "linux_bash",
          location_label: null,
          task: "task",
          model_provider: "anthropic",
          model_name: "claude-3-5-sonnet",
          llm_api_key_sealed: null,
          interactive: false,
          permission_mode: "strict",
          permission_request_timeout_seconds: 900,
          declared_env_vars: [],
          spend_limit_usd: spendLimitUsd,
        },
        [],
        [],
      )
      const runId = store.createPendingRun(agentId)
      const bootstrapToken = createBootstrapToken(keys, agentId, runId).token
      const handshakeRes = await callHandshake(runtime, bootstrapToken, {
        hostname: "test-host",
        run_env: { capabilities: [RUNNER_CAPABILITY_GUARDRAILS] },
      })
      const handshakeData = (await handshakeRes.json()) as HandshakeResponse
      const runToken = handshakeData.run_token
      await callHeartbeat(runtime, runToken)
      return { agentId, runId, runToken }
    }

    test("1. A new usage event is persisted and accounted for exactly once", async () => {
      const { db, store, keys, runtime } = setupRuntime()
      const { runId, runToken } = await setupActiveRun(runtime, store, keys, 10.0)

      const res = await callEvent(runtime, runToken, {
        event_id: "evt_single_1",
        event_type: "step",
        payload: { message: "step 1" },
        tokens_in: 100,
        tokens_out: 50,
        cost_usd: 0.25,
      })
      expect(res.status).toBe(200)

      const usage = store.runUsage(runId)
      expect(usage.total_cost).toBe(0.25)
      expect(usage.unpriced_count).toBe(0)

      const rows = store.events(runId)
      const match = rows.filter((r) => r.client_event_id === "evt_single_1")
      expect(match.length).toBe(1)
      expect(match[0].cost_usd).toBe(0.25)
      db.close()
    })

    test("2. Replaying the same event ID does not increase usage", async () => {
      const { db, store, keys, runtime } = setupRuntime()
      const { runId, runToken } = await setupActiveRun(runtime, store, keys, 10.0)

      const eventPayload = {
        event_id: "evt_replay_1",
        event_type: "step",
        payload: { message: "step replay" },
        tokens_in: 200,
        tokens_out: 100,
        cost_usd: 0.5,
      }

      const res1 = await callEvent(runtime, runToken, eventPayload)
      expect(res1.status).toBe(200)
      expect(store.runUsage(runId).total_cost).toBe(0.5)

      // Replay identical event
      const res2 = await callEvent(runtime, runToken, eventPayload)
      expect(res2.status).toBe(200)
      expect(store.runUsage(runId).total_cost).toBe(0.5)

      // Only one row in events table
      const rows = store.events(runId).filter((r) => r.client_event_id === "evt_replay_1")
      expect(rows.length).toBe(1)
      db.close()
    })

    test("3. Distinct event IDs remain distinct", async () => {
      const { db, store, keys, runtime } = setupRuntime()
      const { runId, runToken } = await setupActiveRun(runtime, store, keys, 10.0)

      await callEvent(runtime, runToken, {
        event_id: "evt_distinct_1",
        event_type: "step",
        payload: { message: "step 1" },
        tokens_in: 100,
        tokens_out: 50,
        cost_usd: 0.25,
      })

      await callEvent(runtime, runToken, {
        event_id: "evt_distinct_2",
        event_type: "step",
        payload: { message: "step 2" },
        tokens_in: 150,
        tokens_out: 75,
        cost_usd: 0.35,
      })

      const usage = store.runUsage(runId)
      expect(usage.total_cost).toBeCloseTo(0.6, 5)

      const rows = store.events(runId)
      expect(rows.some((r) => r.client_event_id === "evt_distinct_1")).toBe(true)
      expect(rows.some((r) => r.client_event_id === "evt_distinct_2")).toBe(true)
      db.close()
    })

    test("4. A malformed or cross-run event identity is rejected safely", async () => {
      const { db, store, keys, runtime } = setupRuntime()
      const { runId, runToken } = await setupActiveRun(runtime, store, keys, 10.0)

      // Empty string
      await expect(
        callEvent(runtime, runToken, {
          event_id: "",
          event_type: "step",
          payload: {},
        }),
      ).rejects.toThrow()

      // Whitespace string
      await expect(
        callEvent(runtime, runToken, {
          event_id: "   ",
          event_type: "step",
          payload: {},
        }),
      ).rejects.toThrow()

      // Invalid characters
      await expect(
        callEvent(runtime, runToken, {
          event_id: "invalid event id with spaces!",
          event_type: "step",
          payload: {},
        }),
      ).rejects.toThrow()

      // Cross-run event identity (prefix does not match current runId)
      await expect(
        callEvent(runtime, runToken, {
          event_id: "other_run_12345:evt_1",
          event_type: "step",
          payload: {},
        }),
      ).rejects.toThrow()

      // Valid scoped identity matching current runId succeeds
      const validScoped = await callEvent(runtime, runToken, {
        event_id: `${runId}:evt_scoped_ok`,
        event_type: "step",
        payload: { message: "scoped ok" },
        tokens_in: 10,
        tokens_out: 5,
        cost_usd: 0.01,
      })
      expect(validScoped.status).toBe(200)

      db.close()
    })

    test("5. Budget below the limit does not trigger a halt", async () => {
      const { db, store, keys, runtime } = setupRuntime()
      const { runId, runToken } = await setupActiveRun(runtime, store, keys, 10.0)

      const res = await callEvent(runtime, runToken, {
        event_id: "evt_under_limit",
        event_type: "step",
        payload: {},
        cost_usd: 4.5,
      })
      expect(res.status).toBe(200)

      const run = store.getRun(runId)
      expect(run?.kill_requested_at).toBeNull()
      expect(run?.kill_reason).toBeNull()

      const beatRes = await callHeartbeat(runtime, runToken)
      const beatData = (await beatRes.json()) as HeartbeatResponse
      expect(beatData.kill).toBe(false)
      db.close()
    })

    test("6. Budget exactly reached triggers budget_exceeded", async () => {
      const { db, store, keys, runtime } = setupRuntime()
      const { runId, runToken } = await setupActiveRun(runtime, store, keys, 5.0)

      const res = await callEvent(runtime, runToken, {
        event_id: "evt_exact_budget",
        event_type: "step",
        payload: {},
        cost_usd: 5.0,
      })
      expect(res.status).toBe(200)

      const run = store.getRun(runId)
      expect(run?.kill_requested_at).not.toBeNull()
      expect(run?.kill_reason).toBe("budget_exceeded")

      const beatRes = await callHeartbeat(runtime, runToken)
      const beatData = (await beatRes.json()) as HeartbeatResponse
      expect(beatData.kill).toBe(true)
      db.close()
    })

    test("7. Spending above the limit triggers budget_exceeded", async () => {
      const { db, store, keys, runtime } = setupRuntime()
      const { runId, runToken } = await setupActiveRun(runtime, store, keys, 5.0)

      const res = await callEvent(runtime, runToken, {
        event_id: "evt_over_budget",
        event_type: "step",
        payload: {},
        cost_usd: 7.5,
      })
      expect(res.status).toBe(200)

      const run = store.getRun(runId)
      expect(run?.kill_requested_at).not.toBeNull()
      expect(run?.kill_reason).toBe("budget_exceeded")
      db.close()
    })

    test("8. Unknown USD cost with positive tokens triggers unpriced_usage_halt for a budgeted run", async () => {
      const { db, store, keys, runtime } = setupRuntime()
      const { runId, runToken } = await setupActiveRun(runtime, store, keys, 10.0)

      const res = await callEvent(runtime, runToken, {
        event_id: "evt_unpriced_positive_tokens",
        event_type: "step",
        payload: {},
        tokens_in: 50,
        tokens_out: 25,
        cost_usd: null,
      })
      expect(res.status).toBe(200)

      const run = store.getRun(runId)
      expect(run?.kill_requested_at).not.toBeNull()
      expect(run?.kill_reason).toBe("unpriced_usage_halt")

      const beatRes = await callHeartbeat(runtime, runToken)
      const beatData = (await beatRes.json()) as HeartbeatResponse
      expect(beatData.kill).toBe(true)
      db.close()
    })

    test("9. Unknown-cost usage does not incorrectly halt an unbudgeted run", async () => {
      const { db, store, keys, runtime } = setupRuntime()
      const { runId, runToken } = await setupActiveRun(runtime, store, keys, null)

      const res = await callEvent(runtime, runToken, {
        event_id: "evt_unpriced_unbudgeted",
        event_type: "step",
        payload: {},
        tokens_in: 500,
        tokens_out: 250,
        cost_usd: null,
      })
      expect(res.status).toBe(200)

      const run = store.getRun(runId)
      expect(run?.kill_requested_at).toBeNull()
      expect(run?.kill_reason).toBeNull()

      const beatRes = await callHeartbeat(runtime, runToken)
      const beatData = (await beatRes.json()) as HeartbeatResponse
      expect(beatData.kill).toBe(false)
      db.close()
    })

    test("10. Duplicate unknown-cost events do not repeat side effects", async () => {
      const { db, store, keys, runtime } = setupRuntime()
      const { runId, runToken } = await setupActiveRun(runtime, store, keys, 10.0)

      const payload = {
        event_id: "evt_unpriced_dup",
        event_type: "step",
        payload: {},
        tokens_in: 30,
        tokens_out: 15,
        cost_usd: null,
      }

      await callEvent(runtime, runToken, payload)
      expect(store.runUsage(runId).unpriced_count).toBe(1)
      const killTime = store.getRun(runId)?.kill_requested_at

      // Replay
      await callEvent(runtime, runToken, payload)
      expect(store.runUsage(runId).unpriced_count).toBe(1)
      expect(store.getRun(runId)?.kill_requested_at).toBe(killTime)
      db.close()
    })

    test("11. Concurrent usage submissions cannot double-count or bypass enforcement", async () => {
      const { db, store, keys, runtime } = setupRuntime()
      const { runId, runToken } = await setupActiveRun(runtime, store, keys, 1.0)

      // 5 distinct events of 0.30 each (total 1.50, exceeding 1.00 budget)
      // plus 5 duplicates submitted concurrently
      const tasks: Promise<Response>[] = []
      for (let i = 0; i < 5; i++) {
        const id = `evt_concurrent_${i}`
        const body = {
          event_id: id,
          event_type: "step",
          payload: { index: i },
          tokens_in: 10,
          tokens_out: 10,
          cost_usd: 0.3,
        }
        tasks.push(callEvent(runtime, runToken, body))
        // Duplicate submission
        tasks.push(callEvent(runtime, runToken, body))
      }

      const results = await Promise.all(tasks)
      for (const res of results) {
        expect(res.status).toBe(200)
      }

      // Exactly 5 distinct events should be accounted: 5 * 0.30 = 1.50
      const usage = store.runUsage(runId)
      expect(usage.total_cost).toBeCloseTo(1.5, 5)

      // Enforcement must be triggered
      const run = store.getRun(runId)
      expect(run?.kill_requested_at).not.toBeNull()
      expect(run?.kill_reason).toBe("budget_exceeded")
      db.close()
    })

    test("12. A runner receives a pending stop request through the supported protocol", async () => {
      const { db, store, keys, runtime } = setupRuntime()
      const { runId, runToken } = await setupActiveRun(runtime, store, keys, 2.0)

      // Before halt: kill is false
      const beat1 = await (await callHeartbeat(runtime, runToken)).json() as HeartbeatResponse
      expect(beat1.kill).toBe(false)

      // Trigger server-side halt
      await callEvent(runtime, runToken, {
        event_id: "evt_stop_beat",
        event_type: "step",
        payload: {},
        cost_usd: 2.5,
      })

      // Next heartbeat receives kill: true
      const beat2 = await (await callHeartbeat(runtime, runToken)).json() as HeartbeatResponse
      expect(beat2.kill).toBe(true)
      db.close()
    })

    test("13. Repeated kill requests are idempotent", async () => {
      const { db, store, keys, runtime } = setupRuntime()
      const { runId } = await setupActiveRun(runtime, store, keys, 5.0)

      const first = store.requestKill(runId, "budget_exceeded")
      expect(first).toBe("signaled")
      const firstTimestamp = store.getRun(runId)?.kill_requested_at
      expect(firstTimestamp).not.toBeNull()

      const second = store.requestKill(runId, "budget_exceeded")
      expect(second).toBe("signaled")
      expect(store.getRun(runId)?.kill_requested_at).toBe(firstTimestamp)
      expect(store.getRun(runId)?.kill_reason).toBe("budget_exceeded")
      db.close()
    })

    test("14. A terminal budget status cannot be overwritten by a delayed success finish", async () => {
      const { db, store, keys, runtime } = setupRuntime()
      const { runId, runToken } = await setupActiveRun(runtime, store, keys, 5.0)

      // Server halt triggered by budget exceeded
      await callEvent(runtime, runToken, {
        event_id: "evt_over_finish",
        event_type: "step",
        payload: {},
        cost_usd: 5.5,
      })
      expect(store.getRun(runId)?.kill_reason).toBe("budget_exceeded")

      // Delayed finish claiming "succeeded"
      const finishRes = await callFinish(runtime, runToken, {
        status: "succeeded",
        message: "Completed before noticing kill.",
      })
      expect(finishRes.status).toBe(200)
      const data = (await finishRes.json()) as { status: string }
      expect(data.status).toBe("budget_exceeded")

      const finalRun = store.getRun(runId)
      expect(finalRun?.status).toBe("budget_exceeded")
      expect(finalRun?.status).not.toBe("succeeded")
      db.close()
    })

    test("15. Duplicate finish requests are safe", async () => {
      const { db, store, keys, runtime } = setupRuntime()
      const { runId, runToken } = await setupActiveRun(runtime, store, keys, null)

      const res1 = await callFinish(runtime, runToken, {
        status: "failed",
        message: "First exit",
      })
      expect(res1.status).toBe(200)
      expect(store.getRun(runId)?.status).toBe("failed")

      // Second finish call on terminal run
      const res2 = await callFinish(runtime, runToken, {
        status: "failed",
        message: "Second exit attempt",
      })
      expect(res2.status).toBe(200)
      expect(store.getRun(runId)?.status).toBe("failed")
      db.close()
    })

    test("16. Runner restarts do not erase authoritative server-side accounting", async () => {
      const { db, store, keys, runtime } = setupRuntime()
      const { runId, runToken } = await setupActiveRun(runtime, store, keys, 10.0)

      await callEvent(runtime, runToken, {
        event_id: "evt_pre_restart",
        event_type: "step",
        payload: {},
        cost_usd: 3.5,
      })
      expect(store.runUsage(runId).total_cost).toBe(3.5)

      // Runner restarts and reconnects for same run
      await callHeartbeat(runtime, runToken)
      expect(store.runUsage(runId).total_cost).toBe(3.5)

      // Subsequent event adds to persisted total
      await callEvent(runtime, runToken, {
        event_id: "evt_post_restart",
        event_type: "step",
        payload: {},
        cost_usd: 2.0,
      })
      expect(store.runUsage(runId).total_cost).toBe(5.5)
      db.close()
    })

    test("17. Existing handshake capability checks still work", async () => {
      const { db, store, keys, runtime } = setupRuntime()

      // Budgeted run with runner lacking capability is refused
      const agent1 = store.createAgent(
        {
          label: "Agent 1",
          os_shell: "linux_bash",
          location_label: null,
          task: "task",
          model_provider: "anthropic",
          model_name: "claude-3-5-sonnet",
          llm_api_key_sealed: null,
          interactive: false,
          permission_mode: "strict",
          permission_request_timeout_seconds: 900,
          declared_env_vars: [],
          spend_limit_usd: 5.0,
        },
        [],
        [],
      )
      const run1 = store.createPendingRun(agent1)
      const tok1 = createBootstrapToken(keys, agent1, run1).token
      await expect(
        callHandshake(runtime, tok1, { hostname: "host", run_env: { capabilities: [] } }),
      ).rejects.toThrow()
      expect(store.getRun(run1)?.status).toBe("failed")

      // Unbudgeted run without capability succeeds
      const agent2 = store.createAgent(
        {
          label: "Agent 2",
          os_shell: "linux_bash",
          location_label: null,
          task: "task",
          model_provider: "anthropic",
          model_name: "claude-3-5-sonnet",
          llm_api_key_sealed: null,
          interactive: false,
          permission_mode: "strict",
          permission_request_timeout_seconds: 900,
          declared_env_vars: [],
          spend_limit_usd: null,
        },
        [],
        [],
      )
      const run2 = store.createPendingRun(agent2)
      const tok2 = createBootstrapToken(keys, agent2, run2).token
      const res2 = await callHandshake(runtime, tok2, { hostname: "host", run_env: { capabilities: [] } })
      expect(res2.status).toBe(200)
      expect(store.getRun(run2)?.status).toBe("handshaked")
      db.close()
    })

    test("18. Database migration preserves prior data and works on fresh initialization", () => {
      // Tested in describe("database migration"):
      // - Fresh DB initialization creates schema v6 with client_event_id and kill_reason
      // - Legacy v2/v3/v4 database migrates up to v6 while preserving existing rows
      const db = openDatabase(dbFile)
      const version = db.query<{ version: number }, []>("SELECT version FROM schema_version").get()
      expect(version?.version).toBe(6)
      db.close()
    })

    test("19. Existing unbudgeted-run tests continue to pass", async () => {
      const { db, store, keys, runtime } = setupRuntime()
      const { runId, runToken } = await setupActiveRun(runtime, store, keys, null)

      // Post multiple steps, including unpriced tokens
      await callEvent(runtime, runToken, {
        event_id: "evt_unbudgeted_1",
        event_type: "step",
        payload: { step: 1 },
        tokens_in: 500,
        tokens_out: 250,
        cost_usd: null,
      })
      await callEvent(runtime, runToken, {
        event_id: "evt_unbudgeted_2",
        event_type: "step",
        payload: { step: 2 },
        tokens_in: 100,
        tokens_out: 50,
        cost_usd: 0.1,
      })

      const run = store.getRun(runId)
      expect(run?.kill_requested_at).toBeNull()

      const finishRes = await callFinish(runtime, runToken, {
        status: "succeeded",
        message: "Unbudgeted task completed.",
      })
      expect(finishRes.status).toBe(200)
      expect(store.getRun(runId)?.status).toBe("succeeded")
      db.close()
    })

    test("TASK 3: unbudgeted runs can report usage without client event IDs and persist correctly", async () => {
      const { db, store, keys, runtime } = setupRuntime()
      const { runId, runToken } = await setupActiveRun(runtime, store, keys, null)

      // 1. Post usage event with tokens and cost, completely omitting event_id and id
      const res1 = await callEvent(runtime, runToken, {
        event_type: "step",
        payload: { step: 1, message: "unbudgeted usage without id" },
        tokens_in: 500,
        tokens_out: 250,
        cost_usd: 0.05,
      })
      expect(res1.status).toBe(200)

      // 2. Post unpriced token usage without event_id and id
      const res2 = await callEvent(runtime, runToken, {
        event_type: "step",
        payload: { step: 2, message: "unbudgeted unpriced usage" },
        tokens_in: 100,
        tokens_out: 50,
        cost_usd: null,
      })
      expect(res2.status).toBe(200)

      // 3. Post event with explicit null event_id
      const res3 = await callEvent(runtime, runToken, {
        event_id: null,
        event_type: "step",
        payload: { step: 3, message: "explicit null id" },
        tokens_in: 50,
        tokens_out: 25,
        cost_usd: 0.01,
      })
      expect(res3.status).toBe(200)

      // 4. Verify all events are persisted and client_event_id is NULL
      const events = store.events(runId)
      expect(events.length).toBe(3)
      for (const evt of events) {
        expect(evt.client_event_id).toBeNull()
      }

      // 5. Verify run usage calculation reflects reported usage without halting
      const usage = store.runUsage(runId)
      expect(usage.total_cost).toBe(0.06)
      expect(usage.unpriced_count).toBe(1)

      const run = store.getRun(runId)
      expect(run?.kill_requested_at).toBeNull()
      expect(run?.kill_reason).toBeNull()
      expect(run?.status).toBe("running")

      db.close()
    })

    describe("Fix 2 — Usage-Bearing Events ID Validation", () => {
      test("usage-bearing events with missing, null, empty, or malformed IDs are rejected with 400", async () => {
        const { db, store, keys, runtime } = setupRuntime()
        const { runId, runToken } = await setupActiveRun(runtime, store, keys, 10.0)

        // Missing ID with positive tokens
        await expect(
          callEvent(runtime, runToken, {
            event_type: "step",
            payload: { message: "missing id with tokens" },
            tokens_in: 10,
            tokens_out: 5,
            cost_usd: null,
          }),
        ).rejects.toThrow("Usage-bearing event requires a valid event ID")

        // Null ID with positive tokens
        await expect(
          callEvent(runtime, runToken, {
            event_id: null,
            event_type: "step",
            payload: { message: "null id with tokens" },
            tokens_in: 10,
            tokens_out: 5,
            cost_usd: null,
          }),
        ).rejects.toThrow("Usage-bearing event requires a valid event ID")

        // Missing ID with reported non-null cost ($0.00 is non-null reported cost)
        await expect(
          callEvent(runtime, runToken, {
            event_type: "step",
            payload: { message: "missing id with zero cost" },
            tokens_in: 0,
            tokens_out: 0,
            cost_usd: 0,
          }),
        ).rejects.toThrow("Usage-bearing event requires a valid event ID")

        // Missing ID with positive cost
        await expect(
          callEvent(runtime, runToken, {
            event_type: "step",
            payload: { message: "missing id with cost" },
            tokens_in: 0,
            tokens_out: 0,
            cost_usd: 0.05,
          }),
        ).rejects.toThrow("Usage-bearing event requires a valid event ID")

        // Empty string ID
        await expect(
          callEvent(runtime, runToken, {
            event_id: "",
            event_type: "step",
            payload: { message: "empty id" },
            tokens_in: 10,
            tokens_out: 5,
            cost_usd: 0.01,
          }),
        ).rejects.toThrow()

        // Whitespace ID
        await expect(
          callEvent(runtime, runToken, {
            event_id: "    ",
            event_type: "step",
            payload: { message: "whitespace id" },
            tokens_in: 10,
            tokens_out: 5,
            cost_usd: 0.01,
          }),
        ).rejects.toThrow()

        // Non-string ID
        await expect(
          callEvent(runtime, runToken, {
            event_id: 12345 as any,
            event_type: "step",
            payload: { message: "number id" },
            tokens_in: 10,
            tokens_out: 5,
            cost_usd: 0.01,
          }),
        ).rejects.toThrow("Event ID must be a string")

        // Malformed characters in ID
        await expect(
          callEvent(runtime, runToken, {
            event_id: "invalid ID with spaces!",
            event_type: "step",
            payload: { message: "invalid chars" },
            tokens_in: 10,
            tokens_out: 5,
            cost_usd: 0.01,
          }),
        ).rejects.toThrow("Malformed event ID")

        // Cross-run scope
        await expect(
          callEvent(runtime, runToken, {
            event_id: "other_run_9999:evt_1",
            event_type: "step",
            payload: { message: "cross run" },
            tokens_in: 10,
            tokens_out: 5,
            cost_usd: 0.01,
          }),
        ).rejects.toThrow("Cross-run or invalidly scoped event ID")

        // Malformed scoped ID (empty remainder)
        await expect(
          callEvent(runtime, runToken, {
            event_id: `${runId}:`,
            event_type: "step",
            payload: { message: "empty remainder" },
            tokens_in: 10,
            tokens_out: 5,
            cost_usd: 0.01,
          }),
        ).rejects.toThrow("Malformed scoped event ID")

        // Non-usage event without ID is accepted (backward compatibility)
        const nonUsageRes = await callEvent(runtime, runToken, {
          event_type: "step",
          payload: { kind: "notice", message: "Notice without usage" },
          tokens_in: 0,
          tokens_out: 0,
          cost_usd: null,
        })
        expect(nonUsageRes.status).toBe(200)

        // Valid usage-bearing event with ID succeeds
        const validRes = await callEvent(runtime, runToken, {
          event_id: "evt_valid_check_1",
          event_type: "step",
          payload: { message: "Valid step" },
          tokens_in: 100,
          tokens_out: 50,
          cost_usd: 0.05,
        })
        expect(validRes.status).toBe(200)
        expect(store.runUsage(runId).total_cost).toBe(0.05)

        db.close()
      })
    })

    describe("Fix 3 — Validate Duplicate Event Payloads", () => {
      test("identical duplicate event payload returns idempotent 200 response", async () => {
        const { db, store, keys, runtime } = setupRuntime()
        const { runId, runToken } = await setupActiveRun(runtime, store, keys, 10.0)

        const payload = {
          event_id: "evt_dup_payload_1",
          event_type: "step",
          payload: { kind: "usage", message: "Step finished" },
          tokens_in: 100,
          tokens_out: 50,
          cost_usd: 0.05,
        }

        const res1 = await callEvent(runtime, runToken, payload)
        expect(res1.status).toBe(200)
        expect(store.runUsage(runId).total_cost).toBe(0.05)

        const res2 = await callEvent(runtime, runToken, payload)
        expect(res2.status).toBe(200)
        expect(store.runUsage(runId).total_cost).toBe(0.05)

        const rows = store.events(runId).filter((r) => r.client_event_id === "evt_dup_payload_1")
        expect(rows.length).toBe(1)
        db.close()
      })

      test("duplicate event ID with conflicting cost is rejected with 409 Conflict", async () => {
        const { db, store, keys, runtime } = setupRuntime()
        const { runId, runToken } = await setupActiveRun(runtime, store, keys, 10.0)

        const res1 = await callEvent(runtime, runToken, {
          event_id: "evt_conflict_cost",
          event_type: "step",
          payload: { message: "test" },
          tokens_in: 100,
          tokens_out: 50,
          cost_usd: 0.1,
        })
        expect(res1.status).toBe(200)
        expect(store.runUsage(runId).total_cost).toBe(0.1)

        // Conflicting cost (0.2 instead of 0.1)
        await expect(
          callEvent(runtime, runToken, {
            event_id: "evt_conflict_cost",
            event_type: "step",
            payload: { message: "test" },
            tokens_in: 100,
            tokens_out: 50,
            cost_usd: 0.2,
          }),
        ).rejects.toThrow("Conflicting event payload")

        // Usage must NOT be altered
        expect(store.runUsage(runId).total_cost).toBe(0.1)
        db.close()
      })

      test("duplicate event ID with conflicting token counts is rejected with 409 Conflict", async () => {
        const { db, store, keys, runtime } = setupRuntime()
        const { runId, runToken } = await setupActiveRun(runtime, store, keys, 10.0)

        const res1 = await callEvent(runtime, runToken, {
          event_id: "evt_conflict_tokens",
          event_type: "step",
          payload: { message: "test" },
          tokens_in: 100,
          tokens_out: 50,
          cost_usd: 0.1,
        })
        expect(res1.status).toBe(200)

        // Conflicting tokens_in
        await expect(
          callEvent(runtime, runToken, {
            event_id: "evt_conflict_tokens",
            event_type: "step",
            payload: { message: "test" },
            tokens_in: 999,
            tokens_out: 50,
            cost_usd: 0.1,
          }),
        ).rejects.toThrow("Conflicting event payload")

        // Conflicting tokens_out
        await expect(
          callEvent(runtime, runToken, {
            event_id: "evt_conflict_tokens",
            event_type: "step",
            payload: { message: "test" },
            tokens_in: 100,
            tokens_out: 999,
            cost_usd: 0.1,
          }),
        ).rejects.toThrow("Conflicting event payload")

        db.close()
      })

      test("duplicate event ID with conflicting event_type or payload is rejected with 409 Conflict", async () => {
        const { db, store, keys, runtime } = setupRuntime()
        const { runId, runToken } = await setupActiveRun(runtime, store, keys, 10.0)

        const res1 = await callEvent(runtime, runToken, {
          event_id: "evt_conflict_type_payload",
          event_type: "step",
          payload: { step: 1, action: "read" },
          tokens_in: 100,
          tokens_out: 50,
          cost_usd: 0.1,
        })
        expect(res1.status).toBe(200)

        // Conflicting event_type
        await expect(
          callEvent(runtime, runToken, {
            event_id: "evt_conflict_type_payload",
            event_type: "summary",
            payload: { step: 1, action: "read" },
            tokens_in: 100,
            tokens_out: 50,
            cost_usd: 0.1,
          }),
        ).rejects.toThrow("Conflicting event payload")

        // Conflicting payload content
        await expect(
          callEvent(runtime, runToken, {
            event_id: "evt_conflict_type_payload",
            event_type: "step",
            payload: { step: 2, action: "write" },
            tokens_in: 100,
            tokens_out: 50,
            cost_usd: 0.1,
          }),
        ).rejects.toThrow("Conflicting event payload")

        db.close()
      })

      test("concurrent identical submissions succeed idempotently; concurrent conflicting submissions reject safely", async () => {
        const { db, store, keys, runtime } = setupRuntime()
        const { runId, runToken } = await setupActiveRun(runtime, store, keys, 10.0)

        // Concurrent identical submissions
        const identicalEvents = Array.from({ length: 5 }, () =>
          callEvent(runtime, runToken, {
            event_id: "evt_concurrent_identical",
            event_type: "step",
            payload: { message: "same" },
            tokens_in: 50,
            tokens_out: 25,
            cost_usd: 0.05,
          }),
        )

        const identicalResults = await Promise.all(identicalEvents)
        for (const res of identicalResults) {
          expect(res.status).toBe(200)
        }
        expect(store.runUsage(runId).total_cost).toBe(0.05)

        // Concurrent conflicting submissions with distinct costs
        const conflictingPromises = [
          callEvent(runtime, runToken, {
            event_id: "evt_concurrent_conflict",
            event_type: "step",
            payload: { message: "conflict" },
            tokens_in: 50,
            tokens_out: 25,
            cost_usd: 0.05,
          }),
          callEvent(runtime, runToken, {
            event_id: "evt_concurrent_conflict",
            event_type: "step",
            payload: { message: "conflict" },
            tokens_in: 50,
            tokens_out: 25,
            cost_usd: 0.5,
          }),
          callEvent(runtime, runToken, {
            event_id: "evt_concurrent_conflict",
            event_type: "step",
            payload: { message: "conflict" },
            tokens_in: 50,
            tokens_out: 25,
            cost_usd: 5.0,
          }),
        ]

        const outcomes = await Promise.allSettled(conflictingPromises)
        const fulfilled = outcomes.filter((o) => o.status === "fulfilled")
        const rejected = outcomes.filter((o) => o.status === "rejected")

        expect(fulfilled.length).toBe(1)
        expect(rejected.length).toBe(2)
        // Stored usage has exactly the single succeeded cost
        expect(store.runUsage(runId).total_cost).toBeCloseTo(0.1, 5)

        db.close()
      })
    })

    describe("Fix 4 — Atomic Finish Transitions", () => {
      test("duplicate finish requests are safe and idempotent", async () => {
        const { db, store, keys, runtime } = setupRuntime()
        const { runId, runToken } = await setupActiveRun(runtime, store, keys, null)

        const res1 = await callFinish(runtime, runToken, {
          status: "failed",
          message: "First exit",
        })
        expect(res1.status).toBe(200)
        const data1 = (await res1.json()) as { status: string }
        expect(data1.status).toBe("failed")

        const res2 = await callFinish(runtime, runToken, {
          status: "failed",
          message: "Repeated exit",
        })
        expect(res2.status).toBe(200)
        const data2 = (await res2.json()) as { status: string }
        expect(data2.status).toBe("failed")

        expect(store.getRun(runId)?.status).toBe("failed")
        db.close()
      })

      test("concurrent finish requests with conflicting statuses resolve deterministically without overwriting terminal state", async () => {
        const { db, store, keys, runtime } = setupRuntime()
        const { runId, runToken } = await setupActiveRun(runtime, store, keys, null)

        // Race succeeded vs failed concurrently
        const [resA, resB] = await Promise.all([
          callFinish(runtime, runToken, { status: "succeeded", message: "Task completed" }),
          callFinish(runtime, runToken, { status: "failed", message: "Task failed" }),
        ])

        expect(resA.status).toBe(200)
        expect(resB.status).toBe(200)
        const dataA = (await resA.json()) as { status: RunStatus }
        const dataB = (await resB.json()) as { status: RunStatus }

        // Both responses MUST agree on the single authoritative terminal status
        expect(dataA.status).toBe(dataB.status)
        const finalStatus = store.getRun(runId)?.status
        expect(finalStatus).toBe(dataA.status)
        expect(["succeeded", "failed"].includes(finalStatus!)).toBe(true)

        // Attempting an endRun or finish cannot overwrite the established terminal status
        const postFinish = store.endRun(runId, "running" as any)
        expect(postFinish).toBe(false)
        expect(store.getRun(runId)?.status).toBe(finalStatus)

        db.close()
      })

      test("authoritative budget-halt precedence is preserved over finish requests", async () => {
        const { db, store, keys, runtime } = setupRuntime()
        const { runId, runToken } = await setupActiveRun(runtime, store, keys, 5.0)

        // Spend triggers budget exceeded kill_reason
        await callEvent(runtime, runToken, {
          event_id: "evt_budget_over_finish",
          event_type: "step",
          payload: {},
          cost_usd: 5.5,
        })
        expect(store.getRun(runId)?.kill_reason).toBe("budget_exceeded")

        // Concurrent finish requests claiming succeeded and failed
        const [res1, res2] = await Promise.all([
          callFinish(runtime, runToken, { status: "succeeded", message: "Done" }),
          callFinish(runtime, runToken, { status: "failed", message: "Done" }),
        ])

        expect(res1.status).toBe(200)
        expect(res2.status).toBe(200)
        const data1 = (await res1.json()) as { status: string }
        const data2 = (await res2.json()) as { status: string }

        expect(data1.status).toBe("budget_exceeded")
        expect(data2.status).toBe("budget_exceeded")
        expect(store.getRun(runId)?.status).toBe("budget_exceeded")

        db.close()
      })

      test("operator-kill precedence is preserved over finish requests", async () => {
        const { db, store, keys, runtime } = setupRuntime()
        const { runId, runToken } = await setupActiveRun(runtime, store, keys, 10.0)

        // Operator signals kill
        store.requestKill(runId, "operator_kill")
        expect(store.getRun(runId)?.kill_reason).toBe("operator_kill")

        // Runner attempts to finish as succeeded
        const finishRes = await callFinish(runtime, runToken, {
          status: "succeeded",
          message: "Finished anyway",
        })
        expect(finishRes.status).toBe(200)
        const data = (await finishRes.json()) as { status: string }
        expect(data.status).toBe("killed")
        expect(store.getRun(runId)?.status).toBe("killed")

        db.close()
      })
    })

    describe("Fix 5 — Reaping Preserves Budget-Halt Reasons", () => {
      test("reaping a budget-halted run preserves budget_exceeded status and reason", () => {
        const { db, store } = setupRuntime()
        const agentId = store.createAgent(
          {
            label: "Agent",
            os_shell: "linux_bash",
            location_label: null,
            task: "task",
            model_provider: "anthropic",
            model_name: "claude",
            llm_api_key_sealed: null,
            interactive: false,
            permission_mode: "strict",
            permission_request_timeout_seconds: 900,
            declared_env_vars: [],
            spend_limit_usd: 1.0,
          },
          [],
          [],
        )
        const runId = store.createPendingRun(agentId)
        store.claimPendingRun(runId, agentId, "host", {})
        store.requestKill(runId, "budget_exceeded")

        // Set time far in past so reaper considers it silent
        db.query("UPDATE runs SET last_heartbeat_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(runId)

        const reaped = store.reapSilentRuns(new Date(), "Lost contact")
        expect(reaped).toBe(1)

        const run = store.getRun(runId)
        expect(run?.status).toBe("budget_exceeded")
        expect(run?.status).not.toBe("failed")

        const errorEvents = store.events(runId).filter((e) => e.event_type === "error")
        expect(errorEvents.length).toBe(1)
        expect(errorEvents[0].payload).toContain("budget_exceeded")

        db.close()
      })

      test("reaping an unpriced-usage-halted run preserves unpriced_usage_halt status and reason", () => {
        const { db, store } = setupRuntime()
        const agentId = store.createAgent(
          {
            label: "Agent",
            os_shell: "linux_bash",
            location_label: null,
            task: "task",
            model_provider: "anthropic",
            model_name: "claude",
            llm_api_key_sealed: null,
            interactive: false,
            permission_mode: "strict",
            permission_request_timeout_seconds: 900,
            declared_env_vars: [],
            spend_limit_usd: 1.0,
          },
          [],
          [],
        )
        const runId = store.createPendingRun(agentId)
        store.claimPendingRun(runId, agentId, "host", {})
        store.requestKill(runId, "unpriced_usage_halt")

        db.query("UPDATE runs SET last_heartbeat_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(runId)

        const reaped = store.reapSilentRuns(new Date(), "Lost contact")
        expect(reaped).toBe(1)

        const run = store.getRun(runId)
        expect(run?.status).toBe("unpriced_usage_halt")
        expect(run?.status).not.toBe("failed")

        const errorEvents = store.events(runId).filter((e) => e.event_type === "error")
        expect(errorEvents.length).toBe(1)
        expect(errorEvents[0].payload).toContain("unpriced_usage_halt")

        db.close()
      })

      test("reaping an operator-killed run preserves operator cancellation precedence (killed status)", () => {
        const { db, store } = setupRuntime()
        const agentId = store.createAgent(
          {
            label: "Agent",
            os_shell: "linux_bash",
            location_label: null,
            task: "task",
            model_provider: "anthropic",
            model_name: "claude",
            llm_api_key_sealed: null,
            interactive: false,
            permission_mode: "strict",
            permission_request_timeout_seconds: 900,
            declared_env_vars: [],
            spend_limit_usd: 1.0,
          },
          [],
          [],
        )
        const runId = store.createPendingRun(agentId)
        store.claimPendingRun(runId, agentId, "host", {})
        store.requestKill(runId, "operator_kill")

        db.query("UPDATE runs SET last_heartbeat_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(runId)

        const reaped = store.reapSilentRuns(new Date(), "Lost contact")
        expect(reaped).toBe(1)

        const run = store.getRun(runId)
        expect(run?.status).toBe("killed")
        expect(run?.status).not.toBe("failed")

        const errorEvents = store.events(runId).filter((e) => e.event_type === "error")
        expect(errorEvents.length).toBe(1)
        expect(errorEvents[0].payload).toContain("operator_kill")

        db.close()
      })

      test("reaping an ordinary silent run without kill reason preserves generic failed status", () => {
        const { db, store } = setupRuntime()
        const agentId = store.createAgent(
          {
            label: "Agent",
            os_shell: "linux_bash",
            location_label: null,
            task: "task",
            model_provider: "anthropic",
            model_name: "claude",
            llm_api_key_sealed: null,
            interactive: false,
            permission_mode: "strict",
            permission_request_timeout_seconds: 900,
            declared_env_vars: [],
            spend_limit_usd: null,
          },
          [],
          [],
        )
        const runId = store.createPendingRun(agentId)
        store.claimPendingRun(runId, agentId, "host", {})

        db.query("UPDATE runs SET last_heartbeat_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(runId)

        const reaped = store.reapSilentRuns(new Date(), "Host stopped responding")
        expect(reaped).toBe(1)

        const run = store.getRun(runId)
        expect(run?.status).toBe("failed")

        const errorEvents = store.events(runId).filter((e) => e.event_type === "error")
        expect(errorEvents.length).toBe(1)
        expect(errorEvents[0].payload).toContain("lost_contact")

        db.close()
      })

      test("reaping does not overwrite an already terminal run", () => {
        const { db, store } = setupRuntime()
        const agentId = store.createAgent(
          {
            label: "Agent",
            os_shell: "linux_bash",
            location_label: null,
            task: "task",
            model_provider: "anthropic",
            model_name: "claude",
            llm_api_key_sealed: null,
            interactive: false,
            permission_mode: "strict",
            permission_request_timeout_seconds: 900,
            declared_env_vars: [],
            spend_limit_usd: null,
          },
          [],
          [],
        )
        const runId = store.createPendingRun(agentId)
        store.claimPendingRun(runId, agentId, "host", {})
        store.finishRun(runId, "succeeded", "Completed")

        db.query("UPDATE runs SET last_heartbeat_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(runId)

        const reaped = store.reapSilentRuns(new Date(), "Lost contact")
        expect(reaped).toBe(0)

        expect(store.getRun(runId)?.status).toBe("succeeded")
        db.close()
      })
    })
  })

  describe("Regression Tests — Findings 6 and 7", () => {
    test("Finding 6: deeply nested payloads beyond MAX_PAYLOAD_EQUIVALENCE_DEPTH do not exhaust stack and return false", () => {
      // Create deeply nested object beyond depth 32
      let deepA: any = { leaf: "value" }
      let deepB: any = { leaf: "value" }
      for (let i = 0; i < 50; i++) {
        deepA = { nested: deepA }
        deepB = { nested: deepB }
      }

      // Should return false safely and not throw RangeError: Maximum call stack size exceeded
      expect(MAX_PAYLOAD_EQUIVALENCE_DEPTH).toBe(32)
      expect(arePayloadsEquivalent(deepA, deepB)).toBe(false)

      // Within depth limit, identical structure is equivalent
      let shallowA: any = { leaf: "value" }
      let shallowB: any = { leaf: "value" }
      for (let i = 0; i < 10; i++) {
        shallowA = { nested: shallowA }
        shallowB = { nested: shallowB }
      }
      expect(arePayloadsEquivalent(shallowA, shallowB)).toBe(true)
    })

    test("Finding 7: token counts with NaN or Infinity are sanitized to 0 in storage", () => {
      const db = openDatabase(dbFile)
      const store = new Store(db)
      const agentId = store.createAgent(
        {
          label: "test-agent",
          os_shell: "linux_bash",
          location_label: null,
          task: "task",
          model_provider: "anthropic",
          model_name: "claude",
          llm_api_key_sealed: null,
          interactive: false,
          permission_mode: "strict",
          permission_request_timeout_seconds: 900,
          declared_env_vars: [],
          spend_limit_usd: null,
        },
        [],
        [],
      )
      const runId = store.createPendingRun(agentId)
      store.claimPendingRun(runId, agentId, "host", {})

      // Insert event with NaN and Infinity token usage
      const added = store.addEvent(
        runId,
        "step",
        { message: "test usage" },
        { tokensIn: NaN, tokensOut: Infinity, costUsd: 0.05 },
        "client_evt_nan_inf",
      )

      expect(added.tokens_in).toBe(0)
      expect(added.tokens_out).toBe(0)
      expect(Number.isFinite(added.tokens_in)).toBe(true)
      expect(Number.isFinite(added.tokens_out)).toBe(true)

      // Query raw database row to verify SQLite storage values
      const row = db.query<{ tokens_in: number; tokens_out: number }, [string]>(
        "SELECT tokens_in, tokens_out FROM events WHERE id = ?",
      ).get(added.id)!

      expect(row.tokens_in).toBe(0)
      expect(row.tokens_out).toBe(0)

      db.close()
    })
  })
})

