/**
 * Every query the control plane runs, in one place, parameterized throughout.
 * Transitions that must happen once (claiming a pending run, deciding a pending
 * request) are conditional UPDATEs, so two callers racing cannot both win.
 */
import type { Database } from "bun:sqlite"
import crypto from "crypto"
import {
  LIVE_RUN_STATUSES,
  RUN_TRANSITIONS,
  TERMINAL_RUN_STATUSES,
  type EventType,
  type OsShell,
  type PermissionModeValue,
  type RequestStatus,
  type RunStatus,
  type SecretProvider,
} from "@agents-everywhere/harness/protocol"
import { nowIso } from "./db"
import type { Rule } from "./policy"
import { configuredRules, EMPTY_GLOBAL_YAML, parseGlobalYaml } from "./configuration"
import { HttpError, parseJson } from "./http"

export class EventConflictError extends HttpError {
  constructor(message = "Conflicting payload for existing event ID") {
    super(409, message)
    this.name = "EventConflictError"
  }
}

export const MAX_PAYLOAD_EQUIVALENCE_DEPTH = 32

export function arePayloadsEquivalent(a: unknown, b: unknown, depth = 0): boolean {
  if (depth > MAX_PAYLOAD_EQUIVALENCE_DEPTH) return false
  if (a === b) return true
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!arePayloadsEquivalent(a[i], b[i], depth + 1)) return false
    }
    return true
  }
  const objA = a as Record<string, unknown>
  const objB = b as Record<string, unknown>
  const keysA = Object.keys(objA)
  const keysB = Object.keys(objB)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, key)) return false
    if (!arePayloadsEquivalent(objA[key], objB[key], depth + 1)) return false
  }
  return true
}

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
  spend_limit_usd: number | null
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
  spend_limit_usd: number | null
  kill_requested_at: string | null
  kill_reason: string | null
  started_at: string | null
  ended_at: string | null
  last_heartbeat_at: string | null
  created_at: string
}

export interface EventRow {
  seq: number
  id: string
  run_id: string
  client_event_id: string | null
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

/** One agent's activity on one UTC day (`day` is YYYY-MM-DD). */
export interface ActivitySpendRow {
  agent_id: string
  label: string
  day: string
  spend: number | null
}

export interface ActivityRunStartRow {
  agent_id: string
  label: string
  day: string
  runs: number
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
  spend_limit_usd?: number | null
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
             interactive, permission_mode, permission_request_timeout_seconds, declared_env_vars, rejection_yaml, use_global_config, spend_limit_usd, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
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
          agent.spend_limit_usd ?? null,
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
    if (patch.spend_limit_usd !== undefined) columns.spend_limit_usd = patch.spend_limit_usd
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
    const agent = this.getAgent(agentId)
    this.db
      .query("INSERT INTO runs (id, agent_id, status, spend_limit_usd, created_at) VALUES (?, ?, 'pending', ?, ?)")
      .run(id, agentId, agent?.spend_limit_usd ?? null, nowIso())
    return id
  }

  runUsage(runId: string): {
    total_cost: number
    unpriced_count: number
  } {
    const row = this.db
      .query<
        { total_cost: number; unpriced_count: number },
        [string]
      >(
        `SELECT
           COALESCE(SUM(MAX(0, cost_usd)), 0) AS total_cost,
           COUNT(CASE WHEN cost_usd IS NULL AND (tokens_in > 0 OR tokens_out > 0) THEN 1 END) AS unpriced_count
         FROM events WHERE run_id = ?`,
      )
      .get(runId) ?? { total_cost: 0, unpriced_count: 0 }
    return {
      total_cost: Math.round(row.total_cost * 1e6) / 1e6,
      unpriced_count: row.unpriced_count,
    }
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

  endRun(runId: string, status: RunStatus): boolean {
    return (
      this.db
        .query(
          `UPDATE runs SET status = ?, ended_at = ?
           WHERE id = ? AND status IN ('pending', 'handshaked', 'running')`,
        )
        .run(status, nowIso(), runId).changes === 1
    )
  }

  finishRun(
    runId: string,
    targetStatus: RunStatus,
    message?: string,
  ):
    | { ok: true; status: RunStatus; alreadyTerminal: boolean; transitioned: boolean }
    | { ok: false; error: "invalid_transition"; message: string } {
    return this.transaction(() => {
      const run = this.getRun(runId)
      if (!run) {
        throw new Error("Agent run not found")
      }

      // Repeated finish requests are safe and idempotent
      if (TERMINAL_RUN_STATUSES.includes(run.status)) {
        return { ok: true, status: run.status, alreadyTerminal: true, transitioned: false }
      }

      if (!RUN_TRANSITIONS[run.status].includes(targetStatus)) {
        return {
          ok: false,
          error: "invalid_transition",
          message: `Cannot finish as ${targetStatus} from ${run.status}`,
        }
      }

      let finalStatus: RunStatus = targetStatus
      if (run.kill_reason === "budget_exceeded") {
        finalStatus = "budget_exceeded"
      } else if (run.kill_reason === "unpriced_usage_halt") {
        finalStatus = "unpriced_usage_halt"
      } else if (run.kill_reason === "operator_kill" && targetStatus !== "killed") {
        finalStatus = "killed"
      }

      const changed =
        this.db
          .query(
            `UPDATE runs SET status = ?, ended_at = ?
             WHERE id = ? AND status IN ('pending', 'handshaked', 'running')`,
          )
          .run(finalStatus, nowIso(), runId).changes === 1

      if (!changed) {
        const refreshed = this.getRun(runId)!
        return { ok: true, status: refreshed.status, alreadyTerminal: true, transitioned: false }
      }

      if (message) {
        const benign = finalStatus === "succeeded" || finalStatus === "idle_timeout"
        this.addEvent(run.id, benign ? "summary" : "error", { message })
      }

      return { ok: true, status: finalStatus, alreadyTerminal: false, transitioned: true }
    })
  }

  /** Stops one run. A run nobody installed yet is removed, so its command stops working. */
  requestKill(runId: string, reason: string = "operator_kill"): "signaled" | "removed" | "already_ended" {
    const run = this.getRun(runId)
    if (!run) return "already_ended"
    if (run.status === "pending") {
      this.db.query("DELETE FROM runs WHERE id = ? AND status = 'pending'").run(runId)
      return "removed"
    }
    const changed = this.db
      .query(
        `UPDATE runs SET
           kill_requested_at = COALESCE(kill_requested_at, ?),
           kill_reason = CASE
             WHEN kill_reason = 'operator_kill' THEN 'operator_kill'
             WHEN ? = 'operator_kill' THEN 'operator_kill'
             ELSE COALESCE(kill_reason, ?)
           END
         WHERE id = ? AND status IN ('handshaked', 'running')`,
      )
      .run(nowIso(), reason, reason, runId).changes
    return changed === 1 ? "signaled" : "already_ended"
  }

  // ── Events ──────────────────────────────────────────────────────────────

  addEvent(
    runId: string,
    type: EventType,
    payload: unknown,
    usage: { tokensIn?: number; tokensOut?: number; costUsd?: number | null } = {},
    clientEventId?: string | null,
  ): EventRow & { inserted: boolean } {
    const id = uuid()
    const sanitizedCost =
      typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd) ? Math.max(0, usage.costUsd) : null
    const sanitizeTokens = (val: unknown): number =>
      typeof val === "number" && Number.isFinite(val) ? Math.max(0, Math.floor(val)) : 0
    const tokensIn = sanitizeTokens(usage.tokensIn)
    const tokensOut = sanitizeTokens(usage.tokensOut)
    const now = nowIso()

    if (clientEventId) {
      const res = this.db
        .query(
          `INSERT INTO events (id, run_id, client_event_id, event_type, payload, tokens_in, tokens_out, cost_usd, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (run_id, client_event_id) DO NOTHING`,
        )
        .run(
          id,
          runId,
          clientEventId,
          type,
          JSON.stringify(payload ?? {}),
          tokensIn,
          tokensOut,
          sanitizedCost,
          now,
        )
      if (res.changes === 0) {
        const existing = this.db
          .query<EventRow, [string, string]>("SELECT * FROM events WHERE run_id = ? AND client_event_id = ?")
          .get(runId, clientEventId)!

        const existingPayload = parseJson(existing.payload, {})
        const incomingPayload = (payload ?? {}) as Record<string, unknown>

        const typeMatches = existing.event_type === type
        const tokensInMatches = existing.tokens_in === tokensIn
        const tokensOutMatches = existing.tokens_out === tokensOut
        const costMatches =
          (existing.cost_usd === null && sanitizedCost === null) ||
          (existing.cost_usd !== null &&
            sanitizedCost !== null &&
            Math.abs(existing.cost_usd - sanitizedCost) < 1e-6)
        const payloadMatches = arePayloadsEquivalent(existingPayload, incomingPayload)

        if (!typeMatches || !tokensInMatches || !tokensOutMatches || !costMatches || !payloadMatches) {
          throw new EventConflictError(
            `Conflicting event payload for existing event ID "${clientEventId}": ` +
              `type=${existing.event_type}/${type}, in=${existing.tokens_in}/${tokensIn}, ` +
              `out=${existing.tokens_out}/${tokensOut}, cost=${existing.cost_usd}/${sanitizedCost}`,
          )
        }

        return Object.assign(existing, { inserted: false })
      }
      const created = this.db.query<EventRow, [string]>("SELECT * FROM events WHERE id = ?").get(id)!
      return Object.assign(created, { inserted: true })
    }

    this.db
      .query(
        `INSERT INTO events (id, run_id, client_event_id, event_type, payload, tokens_in, tokens_out, cost_usd, created_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        runId,
        type,
        JSON.stringify(payload ?? {}),
        tokensIn,
        tokensOut,
        sanitizedCost,
        now,
      )
    const created = this.db.query<EventRow, [string]>("SELECT * FROM events WHERE id = ?").get(id)!
    return Object.assign(created, { inserted: true })
  }

  recordEventAndCheckBudget(
    runId: string,
    type: EventType,
    payload: unknown,
    usage: { tokensIn?: number; tokensOut?: number; costUsd?: number | null } = {},
    clientEventId?: string | null,
  ): {
    event: EventRow
    inserted: boolean
    run: RunRow
    killTriggered: boolean
    killReason: string | null
  } {
    return this.transaction(() => {
      const added = this.addEvent(runId, type, payload, usage, clientEventId)
      let run = this.getRun(runId)!
      let killTriggered = false
      let killReason: string | null = null

      if (added.inserted && run.spend_limit_usd !== null && run.spend_limit_usd !== undefined) {
        const currentUsage = this.runUsage(runId)
        if (currentUsage.unpriced_count > 0) {
          killReason = "unpriced_usage_halt"
          this.requestKill(runId, killReason)
          killTriggered = true
        } else if (currentUsage.total_cost >= run.spend_limit_usd) {
          killReason = "budget_exceeded"
          this.requestKill(runId, killReason)
          killTriggered = true
        }
        run = this.getRun(runId)!
      }

      return {
        event: added,
        inserted: added.inserted,
        run,
        killTriggered,
        killReason,
      }
    })
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

  // ── Fleet activity ──────────────────────────────────────────────────────
  // Every bound is an ISO timestamp, the shape every row stores, so string
  // comparison is time order and `substr(…, 1, 10)` is the UTC day.

  /** Recorded spend per agent per UTC day: at most agents × days rows. Total,
   *  per-agent and per-day spend are all summed from these same rows, so they
   *  cannot disagree. `spend` is null when no event in the group carried a cost. */
  activitySpend(from: string, to: string): ActivitySpendRow[] {
    return this.db
      .query<ActivitySpendRow, [string, string]>(
        `SELECT r.agent_id, a.label, substr(e.created_at, 1, 10) AS day, SUM(e.cost_usd) AS spend
         FROM events e JOIN runs r ON r.id = e.run_id JOIN agents a ON a.id = r.agent_id
         WHERE e.created_at >= ? AND e.created_at <= ?
         GROUP BY r.agent_id, day`,
      )
      .all(from, to)
  }

  /** Usage reports that carried a cost, and those that reported tokens but no cost. */
  activityCostCoverage(from: string, to: string): { priced: number; unpriced: number } {
    return this.db
      .query<{ priced: number; unpriced: number }, [string, string]>(
        `SELECT COALESCE(SUM(cost_usd IS NOT NULL), 0) AS priced,
                COALESCE(SUM(cost_usd IS NULL AND (tokens_in > 0 OR tokens_out > 0)), 0) AS unpriced
         FROM events WHERE created_at >= ? AND created_at <= ?`,
      )
      .get(from, to)!
  }

  /** Runs started in the interval, per agent per UTC day. */
  activityRunStarts(from: string, to: string): ActivityRunStartRow[] {
    return this.db
      .query<ActivityRunStartRow, [string, string]>(
        `SELECT r.agent_id, a.label, substr(r.started_at, 1, 10) AS day, COUNT(*) AS runs
         FROM runs r JOIN agents a ON a.id = r.agent_id
         WHERE r.started_at >= ? AND r.started_at <= ?
         GROUP BY r.agent_id, day`,
      )
      .all(from, to)
  }

  /** Median duration of runs that ended in the interval with a start before their end.
   *  Reads one or two rows at the middle rather than every duration. */
  medianRunDuration(from: string, to: string): { completed: number; median_ms: number | null } {
    const where = `FROM runs WHERE ended_at >= ? AND ended_at <= ? AND started_at IS NOT NULL AND ended_at >= started_at`
    const completed = this.db.query<{ n: number }, [string, string]>(`SELECT COUNT(*) AS n ${where}`).get(from, to)!.n
    if (completed === 0) return { completed, median_ms: null }
    const middle = this.db
      .query<{ ms: number }, [string, string, number, number]>(
        `SELECT (julianday(ended_at) - julianday(started_at)) * 86400000.0 AS ms ${where} ORDER BY ms LIMIT ? OFFSET ?`,
      )
      .all(from, to, completed % 2 === 0 ? 2 : 1, Math.floor((completed - 1) / 2))
    const median = middle.reduce((sum, row) => sum + row.ms, 0) / middle.length
    return { completed, median_ms: Math.round(median) }
  }

  /** Stored `permission_denied` events, counted once each: no join can repeat them. */
  refusedActions(from: string, to: string): number {
    return this.db
      .query<{ n: number }, [string, string]>(
        "SELECT COUNT(*) AS n FROM events WHERE event_type = 'permission_denied' AND created_at >= ? AND created_at <= ?",
      )
      .get(from, to)!.n
  }

  /** Agents with a live run now. */
  agentsRunning(): number {
    return this.db
      .query<{ n: number }, []>(
        "SELECT COUNT(DISTINCT agent_id) AS n FROM runs WHERE status IN ('handshaked', 'running')",
      )
      .get()!.n
  }

  /** Requests still waiting on a person: undecided and not yet past their expiry. */
  awaitingDecisions(now: string): number {
    return this.db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM permission_requests WHERE status = 'pending' AND expires_at > ?",
      )
      .get(now)!.n
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
        const run = this.getRun(id)
        if (!run || !LIVE_RUN_STATUSES.includes(run.status)) return

        let terminalStatus: RunStatus = "failed"
        let eventReason = "lost_contact"
        let eventMessage = message

        if (run.kill_reason === "operator_kill") {
          terminalStatus = "killed"
          eventReason = "operator_kill"
          eventMessage = "Stopped by operator, lost contact before finish confirmation."
        } else if (run.kill_reason === "budget_exceeded") {
          terminalStatus = "budget_exceeded"
          eventReason = "budget_exceeded"
          eventMessage = "Spend limit exceeded, lost contact before finish confirmation."
        } else if (run.kill_reason === "unpriced_usage_halt") {
          terminalStatus = "unpriced_usage_halt"
          eventReason = "unpriced_usage_halt"
          eventMessage = "Unpriced usage halt, lost contact before finish confirmation."
        }

        const changed = this.db
          .query(
            `UPDATE runs SET status = ?, ended_at = ?
             WHERE id = ? AND status IN ('handshaked', 'running')`,
          )
          .run(terminalStatus, nowIso(), id).changes
        if (!changed) return
        ended++
        this.addEvent(id, "error", { message: eventMessage, reason: eventReason })
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
