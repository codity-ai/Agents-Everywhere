/**
 * Every query the control plane runs, in one place, parameterized throughout.
 * Transitions that must happen once (claiming a pending run, deciding a pending
 * request) are conditional UPDATEs, so two callers racing cannot both win.
 */
import type { Database } from "bun:sqlite"
import crypto from "crypto"
import type {
  EventType,
  OsShell,
  PermissionModeValue,
  RequestStatus,
  RunStatus,
  SecretProvider,
} from "@agents-everywhere/harness/protocol"
import { nowIso } from "./db"
import type { Rule } from "./policy"
import { configuredRules, EMPTY_GLOBAL_YAML, parseGlobalYaml } from "./configuration"

export interface AgentRow {
  id: string
  label: string
  os_shell: OsShell
  location_label: string | null
  task: string
  model_provider: string
  model_name: string
  llm_api_key_sealed: string | null
  interactive: number
  permission_mode: PermissionModeValue
  permission_request_timeout_seconds: number
  declared_env_vars: string
  rejection_yaml: string
  use_global_config: number
  status: "draft" | "active" | "revoked"
  created_at: string
  updated_at: string
}

export interface SecretInput {
  provider: SecretProvider
  reference: string
  key_to_env_var: Record<string, string>
  provider_config: Record<string, unknown>
}

export interface SecretRow {
  id: string
  provider: SecretProvider
  reference: string
  key_to_env_var: string
  provider_config: string
}

export interface RunRow {
  id: string
  agent_id: string
  status: RunStatus
  hostname: string | null
  run_env: string
  kill_requested_at: string | null
  started_at: string | null
  ended_at: string | null
  last_heartbeat_at: string | null
  created_at: string
}

export interface EventRow {
  seq: number
  id: string
  run_id: string
  event_type: EventType
  payload: string
  tokens_in: number
  tokens_out: number
  cost_usd: number | null
  created_at: string
}

export interface RequestRow {
  id: string
  run_id: string
  agent_id: string
  engine_request_id: string
  permission: string
  patterns: string
  metadata: string
  status: RequestStatus
  expires_at: string
  decided_at: string | null
  delivered_at: string | null
  created_at: string
}

export interface AgentSummaryRow extends AgentRow {
  latest_run_id: string | null
  latest_run_status: RunStatus | null
  latest_run_last_heartbeat_at: string | null
  total_cost_usd: number | null
  total_tokens_in: number | null
  total_tokens_out: number | null
  pending_requests: number
}

export interface NewAgent {
  label: string
  os_shell: OsShell
  location_label: string | null
  task: string
  model_provider: string
  model_name: string
  llm_api_key_sealed: string | null
  interactive: boolean
  permission_mode: PermissionModeValue
  permission_request_timeout_seconds: number
  declared_env_vars: string[]
  rejection_yaml?: string
  use_global_config?: boolean
}

export type AgentPatch = Partial<Omit<NewAgent, "os_shell">> & { clear_llm_api_key?: boolean }

const uuid = () => crypto.randomUUID()

export class Store {
  constructor(private readonly db: Database) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  globalConfig() {
    return (
      this.db
        .query<
          { yaml: string; revision: number; updated_at: string },
          []
        >("SELECT yaml, revision, updated_at FROM global_config WHERE id = 1")
        .get() ?? { yaml: EMPTY_GLOBAL_YAML, revision: 0, updated_at: null }
    )
  }

  saveGlobalConfig(yaml: string, revision: number): boolean {
    return this.transaction(() => {
      if (this.globalConfig().revision !== revision) return false
      this.db
        .query(
          "INSERT INTO global_config (id, yaml, revision, updated_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET yaml = excluded.yaml, revision = excluded.revision, updated_at = excluded.updated_at",
        )
        .run(yaml, revision + 1, nowIso())
      return true
    })
  }

  effectiveRules(agent: AgentRow): Rule[] {
    const global =
      agent.use_global_config && agent.status !== "revoked" ? parseGlobalYaml(this.globalConfig().yaml).permissions : []
    return configuredRules(this.rules(agent.id), agent.rejection_yaml, global)
  }

  // ── Agents ──────────────────────────────────────────────────────────────

  createAgent(agent: NewAgent, rules: Rule[], secrets: SecretInput[]): string {
    const id = uuid()
    const now = nowIso()
    this.transaction(() => {
      this.db
        .query(
          `INSERT INTO agents (id, label, os_shell, location_label, task, model_provider, model_name, llm_api_key_sealed,
             interactive, permission_mode, permission_request_timeout_seconds, declared_env_vars, rejection_yaml, use_global_config, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
        )
        .run(
          id,
          agent.label,
          agent.os_shell,
          agent.location_label,
          agent.task,
          agent.model_provider,
          agent.model_name,
          agent.llm_api_key_sealed,
          agent.interactive ? 1 : 0,
          agent.permission_mode,
          agent.permission_request_timeout_seconds,
          JSON.stringify(agent.declared_env_vars),
          agent.rejection_yaml ?? "",
          agent.use_global_config ? 1 : 0,
          now,
          now,
        )
      this.insertRules(id, rules)
      this.insertSecrets(id, secrets)
    })
    return id
  }

  private insertRules(agentId: string, rules: Rule[]) {
    const insert = this.db.query(
      "INSERT INTO agent_permissions (id, agent_id, path_pattern, access, kind, effect) VALUES (?, ?, ?, ?, ?, ?)",
    )
    for (const r of rules) insert.run(uuid(), agentId, r.path_pattern, r.access, r.kind, r.effect)
  }

  private insertSecrets(agentId: string, secrets: SecretInput[]) {
    const insert = this.db.query(
      "INSERT INTO agent_secrets (id, agent_id, provider, reference, key_to_env_var, provider_config) VALUES (?, ?, ?, ?, ?, ?)",
    )
    for (const s of secrets) {
      insert.run(
        uuid(),
        agentId,
        s.provider,
        s.reference,
        JSON.stringify(s.key_to_env_var),
        JSON.stringify(s.provider_config),
      )
    }
  }

  getAgent(id: string): AgentRow | null {
    return this.db.query<AgentRow, [string]>("SELECT * FROM agents WHERE id = ?").get(id)
  }

  listAgents(): AgentSummaryRow[] {
    return this.db
      .query<AgentSummaryRow, []>(
        `SELECT a.*,
           latest.id AS latest_run_id, latest.status AS latest_run_status, latest.last_heartbeat_at AS latest_run_last_heartbeat_at,
           usage.cost AS total_cost_usd, usage.tokens_in AS total_tokens_in, usage.tokens_out AS total_tokens_out,
           COALESCE(pending.n, 0) AS pending_requests
         FROM agents a
         LEFT JOIN runs latest ON latest.id = (
           SELECT r.id FROM runs r WHERE r.agent_id = a.id ORDER BY r.created_at DESC LIMIT 1)
         LEFT JOIN (
           SELECT r.agent_id, SUM(e.cost_usd) AS cost, SUM(e.tokens_in) AS tokens_in, SUM(e.tokens_out) AS tokens_out
           FROM events e JOIN runs r ON r.id = e.run_id GROUP BY r.agent_id) usage ON usage.agent_id = a.id
         LEFT JOIN (
           SELECT agent_id, COUNT(*) AS n FROM permission_requests WHERE status = 'pending' GROUP BY agent_id) pending
           ON pending.agent_id = a.id
         ORDER BY a.created_at DESC`,
      )
      .all()
  }

  agentUsage(id: string): { cost: number | null; tokens_in: number | null; tokens_out: number | null } {
    return this.db
      .query<{ cost: number | null; tokens_in: number | null; tokens_out: number | null }, [string]>(
        `SELECT SUM(e.cost_usd) AS cost, SUM(e.tokens_in) AS tokens_in, SUM(e.tokens_out) AS tokens_out
         FROM events e JOIN runs r ON r.id = e.run_id WHERE r.agent_id = ?`,
      )
      .get(id)!
  }

  updateAgent(id: string, patch: AgentPatch) {
    const columns: Record<string, unknown> = {}
    if (patch.label !== undefined) columns.label = patch.label
    if (patch.location_label !== undefined) columns.location_label = patch.location_label
    if (patch.task !== undefined) columns.task = patch.task
    if (patch.model_provider !== undefined) columns.model_provider = patch.model_provider
    if (patch.model_name !== undefined) columns.model_name = patch.model_name
    if (patch.llm_api_key_sealed !== undefined) columns.llm_api_key_sealed = patch.llm_api_key_sealed
    if (patch.clear_llm_api_key) columns.llm_api_key_sealed = null
    if (patch.interactive !== undefined) columns.interactive = patch.interactive ? 1 : 0
    if (patch.permission_mode !== undefined) columns.permission_mode = patch.permission_mode
    if (patch.permission_request_timeout_seconds !== undefined)
      columns.permission_request_timeout_seconds = patch.permission_request_timeout_seconds
    if (patch.declared_env_vars !== undefined) columns.declared_env_vars = JSON.stringify(patch.declared_env_vars)
    if (patch.rejection_yaml !== undefined) columns.rejection_yaml = patch.rejection_yaml
    if (patch.use_global_config !== undefined) columns.use_global_config = patch.use_global_config ? 1 : 0
    const names = Object.keys(columns)
    if (names.length === 0) return
    // Column names come from the fixed list above, never from the request.
    const assignments = names.map((name) => `${name} = ?`).join(", ")
    this.db
      .query(`UPDATE agents SET ${assignments}, updated_at = ? WHERE id = ?`)
      .run(...(names.map((n) => columns[n]) as any[]), nowIso(), id)
  }

  replaceSecrets(agentId: string, secrets: SecretInput[]) {
    this.transaction(() => {
      this.db.query("DELETE FROM agent_secrets WHERE agent_id = ?").run(agentId)
      this.insertSecrets(agentId, secrets)
    })
  }

  activateAgent(id: string) {
    this.db
      .query("UPDATE agents SET status = 'active', updated_at = ? WHERE id = ? AND status = 'draft'")
      .run(nowIso(), id)
  }

  rules(agentId: string): Rule[] {
    return this.db
      .query<
        Rule,
        [string]
      >("SELECT path_pattern, access, kind, effect FROM agent_permissions WHERE agent_id = ? ORDER BY rowid")
      .all(agentId)
  }

  /** Replaces every rule in one write: an allow and the deny that carves a hole
   *  in it only mean something together, so a partial update could briefly
   *  grant more than intended. */
  replaceRules(agentId: string, rules: Rule[]) {
    this.transaction(() => {
      this.db.query("DELETE FROM agent_permissions WHERE agent_id = ?").run(agentId)
      this.insertRules(agentId, rules)
      this.db.query("UPDATE agents SET updated_at = ? WHERE id = ?").run(nowIso(), agentId)
    })
  }

  addRules(agentId: string, rules: Rule[]) {
    this.insertRules(agentId, rules)
  }

  secrets(agentId: string): SecretRow[] {
    return this.db
      .query<
        SecretRow,
        [string]
      >("SELECT id, provider, reference, key_to_env_var, provider_config FROM agent_secrets WHERE agent_id = ? ORDER BY rowid")
      .all(agentId)
  }

  /** Revoking stops every machine and makes every outstanding command useless. Returns runs signaled. */
  revokeAgent(id: string): number {
    const now = nowIso()
    return this.transaction(() => {
      this.db.query("UPDATE agents SET status = 'revoked', updated_at = ? WHERE id = ?").run(now, id)
      // An install command nobody ran has no machine to stop: remove its run,
      // which also makes the command unusable.
      this.db.query("DELETE FROM runs WHERE agent_id = ? AND status = 'pending'").run(id)
      const signaled = this.db
        .query(
          `UPDATE runs SET kill_requested_at = ?
           WHERE agent_id = ? AND status IN ('handshaked', 'running') AND kill_requested_at IS NULL`,
        )
        .run(now, id).changes
      // Nothing will answer these now, and pending ones would sit in the badge forever.
      this.db
        .query(
          "UPDATE permission_requests SET status = 'expired', decided_at = ? WHERE agent_id = ? AND status = 'pending'",
        )
        .run(now, id)
      return signaled
    })
  }

  // ── Runs ────────────────────────────────────────────────────────────────

  createPendingRun(agentId: string): string {
    const id = uuid()
    this.db
      .query("INSERT INTO runs (id, agent_id, status, created_at) VALUES (?, ?, 'pending', ?)")
      .run(id, agentId, nowIso())
    return id
  }

  /** The handshake's claim: only a run still pending can be taken, so a replayed
   *  install command finds nothing left to claim. */
  claimPendingRun(runId: string, agentId: string, hostname: string | null, runEnv: unknown): boolean {
    return (
      this.db
        .query(
          `UPDATE runs SET status = 'handshaked', hostname = ?, run_env = ?
           WHERE id = ? AND agent_id = ? AND status = 'pending'`,
        )
        .run(hostname, JSON.stringify(runEnv ?? {}), runId, agentId).changes === 1
    )
  }

  getRun(id: string): RunRow | null {
    return this.db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(id)
  }

  getAgentRun(agentId: string, runId: string): RunRow | null {
    return this.db
      .query<RunRow, [string, string]>("SELECT * FROM runs WHERE agent_id = ? AND id = ?")
      .get(agentId, runId)
  }

  runs(agentId: string, limit: number): RunRow[] {
    return this.db
      .query<RunRow, [string, number]>("SELECT * FROM runs WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(agentId, limit)
  }

  agentRunCount(agentId: string): number {
    return (
      this.db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM runs WHERE agent_id = ? AND status != 'pending'")
        .get(agentId)?.n ?? 0
    )
  }

  runsPaginated(
    agentId: string,
    limit: number,
    cursor?: { createdAt: string; id: string } | null,
  ): { runs: RunRow[]; hasMore: boolean; nextCursor: { createdAt: string; id: string } | null; total: number } {
    const fetchLimit = limit + 1
    const rows = cursor
      ? this.db
          .query<RunRow, [string, string, string, string, number]>(
            `SELECT * FROM runs
             WHERE agent_id = ? AND status != 'pending' AND (created_at < ? OR (created_at = ? AND id < ?))
             ORDER BY created_at DESC, id DESC
             LIMIT ?`,
          )
          .all(agentId, cursor.createdAt, cursor.createdAt, cursor.id, fetchLimit)
      : this.db
          .query<RunRow, [string, number]>(
            `SELECT * FROM runs
             WHERE agent_id = ? AND status != 'pending'
             ORDER BY created_at DESC, id DESC
             LIMIT ?`,
          )
          .all(agentId, fetchLimit)

    const hasMore = rows.length > limit
    const runs = hasMore ? rows.slice(0, limit) : rows
    const last = runs.length > 0 ? runs[runs.length - 1] : null
    const nextCursor = hasMore && last ? { createdAt: last.created_at, id: last.id } : null
    const total = this.agentRunCount(agentId)
    return { runs, hasMore, nextCursor, total }
  }

  recordHeartbeat(run: RunRow): RunStatus {
    const now = nowIso()
    const status: RunStatus = run.status === "handshaked" ? "running" : run.status
    this.db
      .query("UPDATE runs SET status = ?, last_heartbeat_at = ?, started_at = COALESCE(started_at, ?) WHERE id = ?")
      .run(status, now, status === "running" ? now : null, run.id)
    return status
  }

  endRun(runId: string, status: RunStatus) {
    this.db.query("UPDATE runs SET status = ?, ended_at = ? WHERE id = ?").run(status, nowIso(), runId)
  }

  /** Stops one run. A run nobody installed yet is removed, so its command stops working. */
  requestKill(runId: string): "signaled" | "removed" | "already_ended" {
    const run = this.getRun(runId)
    if (!run) return "already_ended"
    if (run.status === "pending") {
      this.db.query("DELETE FROM runs WHERE id = ? AND status = 'pending'").run(runId)
      return "removed"
    }
    const changed = this.db
      .query(
        "UPDATE runs SET kill_requested_at = COALESCE(kill_requested_at, ?) WHERE id = ? AND status IN ('handshaked', 'running')",
      )
      .run(nowIso(), runId).changes
    return changed === 1 ? "signaled" : "already_ended"
  }

  // ── Events ──────────────────────────────────────────────────────────────

  addEvent(
    runId: string,
    type: EventType,
    payload: unknown,
    usage: { tokensIn?: number; tokensOut?: number; costUsd?: number | null } = {},
  ) {
    const id = uuid()
    this.db
      .query(
        `INSERT INTO events (id, run_id, event_type, payload, tokens_in, tokens_out, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        runId,
        type,
        JSON.stringify(payload ?? {}),
        usage.tokensIn ?? 0,
        usage.tokensOut ?? 0,
        usage.costUsd ?? null,
        nowIso(),
      )
    return this.db.query<EventRow, [string]>("SELECT * FROM events WHERE id = ?").get(id)!
  }

  events(runId: string, afterSeq = 0, limit = 1000): EventRow[] {
    return this.db
      .query<
        EventRow,
        [string, number, number]
      >("SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?")
      .all(runId, afterSeq, limit)
  }

  /** Highest stored sequence for a run; 0 when the run has no events yet. */
  maxSeq(runId: string): number {
    return this.db
      .query<{ m: number }, [string]>("SELECT COALESCE(MAX(seq),0) AS m FROM events WHERE run_id = ?")
      .get(runId)!.m
  }

  /** Chat messages for a run after the one the runner last delivered. A cursor
   *  that is not one of this run's own events is ignored, never trusted. */
  messagesAfter(runId: string, afterEventId: string | null): EventRow[] {
    let afterSeq = 0
    if (afterEventId) {
      const cursor = this.db
        .query<{ seq: number }, [string, string]>("SELECT seq FROM events WHERE id = ? AND run_id = ?")
        .get(afterEventId, runId)
      if (cursor) afterSeq = cursor.seq
    }
    return this.db
      .query<
        EventRow,
        [string, number]
      >("SELECT * FROM events WHERE run_id = ? AND event_type = 'user_message' AND seq > ? ORDER BY seq")
      .all(runId, afterSeq)
  }

  // ── Permission requests ─────────────────────────────────────────────────

  findRequest(runId: string, engineRequestId: string): RequestRow | null {
    return this.db
      .query<
        RequestRow,
        [string, string]
      >("SELECT * FROM permission_requests WHERE run_id = ? AND engine_request_id = ?")
      .get(runId, engineRequestId)
  }

  pendingRequestCount(runId: string): number {
    return this.db
      .query<
        { n: number },
        [string]
      >("SELECT COUNT(*) AS n FROM permission_requests WHERE run_id = ? AND status = 'pending'")
      .get(runId)!.n
  }

  createRequest(input: {
    runId: string
    agentId: string
    engineRequestId: string
    permission: string
    patterns: string[]
    metadata: unknown
    expiresAt: Date
  }): RequestRow {
    const id = uuid()
    this.db
      .query(
        `INSERT INTO permission_requests (id, run_id, agent_id, engine_request_id, permission, patterns, metadata, status, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        id,
        input.runId,
        input.agentId,
        input.engineRequestId,
        input.permission,
        JSON.stringify(input.patterns),
        JSON.stringify(input.metadata ?? {}),
        input.expiresAt.toISOString(),
        nowIso(),
      )
    return this.getRequest(id)!
  }

  getRequest(id: string): RequestRow | null {
    return this.db.query<RequestRow, [string]>("SELECT * FROM permission_requests WHERE id = ?").get(id)
  }

  /** Anything nobody answered in time is refused, so one unattended escalation cannot strand a run. */
  expireOverdueRequests(runId: string) {
    const now = nowIso()
    this.db
      .query(
        "UPDATE permission_requests SET status = 'expired', decided_at = ? WHERE run_id = ? AND status = 'pending' AND expires_at <= ?",
      )
      .run(now, runId, now)
  }

  /** Marked delivered when the runner says it applied them, not when they were sent. */
  markDelivered(runId: string, requestIds: string[]) {
    if (requestIds.length === 0) return
    const mark = this.db.query("UPDATE permission_requests SET delivered_at = ? WHERE run_id = ? AND id = ?")
    const now = nowIso()
    this.transaction(() => {
      for (const id of requestIds) mark.run(now, runId, id)
    })
  }

  undeliveredDecisions(runId: string): RequestRow[] {
    return this.db
      .query<
        RequestRow,
        [string]
      >("SELECT * FROM permission_requests WHERE run_id = ? AND status != 'pending' AND delivered_at IS NULL ORDER BY created_at")
      .all(runId)
  }

  requests(agentId: string, pendingOnly: boolean, limit: number): Array<RequestRow & { run_hostname: string | null }> {
    return this.db
      .query<RequestRow & { run_hostname: string | null }, [string, number, number]>(
        `SELECT pr.*, r.hostname AS run_hostname FROM permission_requests pr JOIN runs r ON r.id = pr.run_id
         WHERE pr.agent_id = ? AND (? = 0 OR pr.status = 'pending') ORDER BY pr.created_at DESC LIMIT ?`,
      )
      .all(agentId, pendingOnly ? 1 : 0, limit)
  }

  /** Decides a pending request; false when it was no longer pending. */
  decideRequest(id: string, agentId: string, decision: RequestStatus): boolean {
    return (
      this.db
        .query(
          "UPDATE permission_requests SET status = ?, decided_at = ? WHERE id = ? AND agent_id = ? AND status = 'pending'",
        )
        .run(decision, nowIso(), id, agentId).changes === 1
    )
  }

  // ── Reaper ──────────────────────────────────────────────────────────────

  /** Ends live runs whose machine has been silent since `before`, saying why. Returns how many. */
  reapSilentRuns(before: Date, message: string): number {
    const stale = this.db
      .query<{ id: string }, [string]>(
        `SELECT id FROM runs WHERE status IN ('handshaked', 'running')
         AND COALESCE(last_heartbeat_at, started_at, created_at) < ?`,
      )
      .all(before.toISOString())
    let ended = 0
    for (const { id } of stale) {
      this.transaction(() => {
        const changed = this.db
          .query("UPDATE runs SET status = 'failed', ended_at = ? WHERE id = ? AND status IN ('handshaked', 'running')")
          .run(nowIso(), id).changes
        if (!changed) return
        ended++
        this.addEvent(id, "error", { message, reason: "lost_contact" })
        // Nobody will apply a decision to a run that is gone.
        this.db
          .query(
            "UPDATE permission_requests SET status = 'expired', decided_at = ? WHERE run_id = ? AND status = 'pending'",
          )
          .run(nowIso(), id)
      })
    }
    return ended
  }

  /** Removes install commands that were never used and can no longer be. */
  reapUnclaimedRuns(before: Date): number {
    return this.db.query("DELETE FROM runs WHERE status = 'pending' AND created_at < ?").run(before.toISOString())
      .changes
  }

  // ── Admin and sessions ──────────────────────────────────────────────────

  adminTokenHash(): string | null {
    return (
      this.db.query<{ token_hash: string }, []>("SELECT token_hash FROM admin WHERE id = 1").get()?.token_hash ?? null
    )
  }

  setAdminTokenHash(hash: string) {
    this.db
      .query(
        "INSERT INTO admin (id, token_hash, created_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash",
      )
      .run(hash, nowIso())
  }

  createSession(idHash: string, csrfToken: string, expiresAt: Date) {
    this.db
      .query("INSERT INTO sessions (id_hash, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(idHash, csrfToken, nowIso(), expiresAt.toISOString())
  }

  session(idHash: string): { csrf_token: string; expires_at: string } | null {
    return this.db
      .query<
        { csrf_token: string; expires_at: string },
        [string, string]
      >("SELECT csrf_token, expires_at FROM sessions WHERE id_hash = ? AND expires_at > ?")
      .get(idHash, nowIso())
  }

  deleteSession(idHash: string) {
    this.db.query("DELETE FROM sessions WHERE id_hash = ?").run(idHash)
  }

  deleteAllSessions() {
    this.db.query("DELETE FROM sessions").run()
  }

  purgeExpiredSessions() {
    this.db.query("DELETE FROM sessions WHERE expires_at <= ?").run(nowIso())
  }
}
