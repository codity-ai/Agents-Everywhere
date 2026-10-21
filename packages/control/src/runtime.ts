/**
 * The runner API: the calls a runner makes from the machine it runs on. The
 * control plane never initiates anything here, it only answers.
 *
 * handshake (install token for a run token, task, permissions and LLM key),
 * then heartbeats (also how a kill, a chat message or a permission decision
 * reaches a process nothing can dial into), events, and finish. The shapes are
 * in @agents-everywhere/harness/protocol and described in docs/runner-protocol.md.
 */
import { z } from "zod"
import {
  PROTOCOL_VERSION,
  RUN_STATUSES,
  RUN_TRANSITIONS,
  RUNNER_CAPABILITY_GUARDRAILS,
  RUNNER_EVENT_TYPES,
  TERMINAL_RUN_STATUSES,
  type HandshakeResponse,
  type HeartbeatResponse,
  type PermissionRequestAck,
  type RunStatus,
} from "@agents-everywhere/harness/protocol"
import {
  createRunToken,
  runTokenNeedsRefresh,
  TokenError,
  unseal,
  verifyBootstrapToken,
  verifyRunToken,
  type Keys,
  type RunClaims,
} from "./crypto"
import { bearer, HttpError, json, parseJson, readBody } from "./http"
import type { RunRow, Store } from "./store"

// How many escalations one run may have outstanding. Request mode asks about
// everything the config does not mention, so an agent exploring a machine can
// raise them faster than anyone can answer. Past this the runner is told to
// refuse, which is what strict mode would have done anyway.
const MAX_PENDING_REQUESTS_PER_RUN = 25
const MAX_RUNNER_BODY_BYTES = 256 * 1024

const HandshakeBody = z.object({
  hostname: z.string().max(255).nullable().optional(),
  run_env: z.record(z.string(), z.unknown()).optional(),
})

const HeartbeatBody = z.object({
  after_event_id: z.string().max(64).nullable().optional(),
  // Anything else in the list is ignored rather than failing the beat: the
  // heartbeat is the only channel a kill travels on.
  applied_permission_request_ids: z.array(z.unknown()).max(500).optional(),
})

const EventBody = z.object({
  id: z.unknown().optional(),
  event_id: z.unknown().optional(),
  event_type: z.enum(RUNNER_EVENT_TYPES as [string, ...string[]]),
  payload: z.record(z.string(), z.unknown()).default({}),
  tokens_in: z.number().int().min(0).default(0),
  tokens_out: z.number().int().min(0).default(0),
  cost_usd: z.number().min(0).nullable().optional(),
})

const FinishBody = z.object({
  status: z.enum(RUN_STATUSES),
  message: z.string().max(4000).default(""),
})

const PermissionRequestBody = z.object({
  engine_request_id: z.string().min(1).max(128),
  permission: z.string().min(1).max(64),
  patterns: z.array(z.string().max(2000)).max(100).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
})

export class RuntimeApi {
  constructor(
    private readonly store: Store,
    private readonly keys: Keys,
    private readonly log: (line: string) => void,
  ) {}

  private runClaims(req: Request): RunClaims {
    const token = bearer(req)
    if (!token) throw new HttpError(401, "Missing run token")
    try {
      return verifyRunToken(this.keys, token)
    } catch (err) {
      throw new HttpError(401, `Invalid run token: ${(err as TokenError).message}`)
    }
  }

  /** The token's signature proves nothing about the run's state: a killed or
   *  finished run is refused at once, not only when its token expires. */
  private activeRun(claims: RunClaims): RunRow {
    const run = this.store.getRun(claims.runId)
    if (!run || run.agent_id !== claims.agentId) throw new HttpError(404, "Agent run not found")
    if (TERMINAL_RUN_STATUSES.includes(run.status)) throw new HttpError(409, `Run is already ${run.status}`)
    return run
  }

  handshake = async (req: Request): Promise<Response> => {
    const token = bearer(req)
    if (!token) throw new HttpError(401, "Missing bootstrap token")
    let claims: RunClaims
    try {
      claims = verifyBootstrapToken(this.keys, token)
    } catch (err) {
      throw new HttpError(401, `Invalid bootstrap token: ${(err as TokenError).message}`)
    }
    const body = await readBody(req, HandshakeBody, MAX_RUNNER_BODY_BYTES)

    // Atomic: only a pending run can be claimed, so a replayed or leaked
    // install command finds nothing left to claim the second time.
    if (!this.store.claimPendingRun(claims.runId, claims.agentId, body.hostname ?? null, body.run_env ?? {})) {
      throw new HttpError(409, "This install command has already been used or the run was revoked")
    }

    const run = this.store.getRun(claims.runId)
    const capabilities = Array.isArray(body.run_env?.capabilities)
      ? body.run_env.capabilities.filter((c): c is string => typeof c === "string")
      : []

    if (
      run?.spend_limit_usd !== null &&
      run?.spend_limit_usd !== undefined &&
      !capabilities.includes(RUNNER_CAPABILITY_GUARDRAILS)
    ) {
      this.store.endRun(claims.runId, "failed")
      throw new HttpError(400, "Runner does not support spending guardrails required by this run")
    }

    const agent = this.store.getAgent(claims.agentId)
    if (!agent || agent.status === "revoked") {
      // A config revoked between mint and handshake must not hand out a working run token.
      this.store.endRun(claims.runId, "killed")
      throw new HttpError(409, "Agent config is revoked")
    }

    const runToken = createRunToken(this.keys, agent.id, claims.runId)
    this.log(`Run ${claims.runId} handshaked from ${body.hostname ?? "an unnamed host"} (agent ${agent.label})`)

    const response: HandshakeResponse = {
      run_id: claims.runId,
      run_token: runToken.token,
      run_token_expires_at: runToken.expiresAt.toISOString(),
      task: agent.task,
      spend_limit_usd: run?.spend_limit_usd ?? null,
      permissions: this.store.effectiveRules(agent),
      secrets: this.store.secrets(agent.id).map((s) => ({
        secret_arn: s.reference,
        key_to_env_var: parseJson(s.key_to_env_var, {}),
        provider: s.provider,
        provider_config: parseJson(s.provider_config, {}),
      })),
      declared_env_vars: parseJson(agent.declared_env_vars, []),
      model_provider: agent.model_provider,
      model_name: agent.model_name,
      interactive: agent.interactive === 1,
      permission_mode: agent.permission_mode,
      permission_request_timeout_seconds: agent.permission_request_timeout_seconds,
      // The only time the key leaves this server, decrypted, to the run it belongs to.
      llm_api_key: agent.llm_api_key_sealed ? unseal(this.keys, agent.llm_api_key_sealed) : null,
      protocol_version: PROTOCOL_VERSION,
    }
    return json(response)
  }

  heartbeat = async (req: Request): Promise<Response> => {
    const claims = this.runClaims(req)
    const body = await readBody(req, HeartbeatBody, MAX_RUNNER_BODY_BYTES, true)
    const run = this.activeRun(claims)
    const status = this.store.recordHeartbeat(run)

    // Acknowledged decisions are marked delivered now rather than when they
    // were sent: the agent is blocked until the runner has replied to the
    // engine, so "sent" is not good enough to stop resending.
    const applied = (body.applied_permission_request_ids ?? []).filter((v): v is string => typeof v === "string")
    this.store.markDelivered(run.id, applied)
    this.store.expireOverdueRequests(run.id)

    const response: HeartbeatResponse = {
      kill: run.kill_requested_at !== null,
      kill_reason: run.kill_reason,
      status,
      messages: this.store.messagesAfter(run.id, body.after_event_id ?? null).map((e) => ({
        id: e.id,
        message: String(parseJson<{ message?: unknown }>(e.payload, {}).message ?? ""),
      })),
      permission_decisions: this.store.undeliveredDecisions(run.id).map((r) => ({
        request_id: r.id,
        engine_request_id: r.engine_request_id,
        permission: r.permission,
        patterns: parseJson(r.patterns, []),
        decision: r.status as "expired",
      })),
      run_token: runTokenNeedsRefresh(claims) ? createRunToken(this.keys, run.agent_id, run.id).token : null,
    }
    return json(response)
  }

  event = async (req: Request): Promise<Response> => {
    const claims = this.runClaims(req)
    const body = await readBody(req, EventBody, MAX_RUNNER_BODY_BYTES)
    const run = this.activeRun(claims)

    const isUsageBearing =
      body.tokens_in > 0 || body.tokens_out > 0 || (body.cost_usd !== null && body.cost_usd !== undefined)

    const rawId = body.event_id ?? body.id

    const hasActiveBudget = run.spend_limit_usd !== null && run.spend_limit_usd !== undefined

    if (hasActiveBudget && isUsageBearing) {
      if (rawId === undefined || rawId === null) {
        throw new HttpError(400, "Usage-bearing event requires a valid event ID")
      }
    }

    let clientEventId: string | null = null
    if (rawId !== undefined && rawId !== null) {
      if (typeof rawId !== "string") {
        throw new HttpError(400, "Event ID must be a string")
      }
      const trimmed = rawId.trim()
      if (trimmed.length === 0 || trimmed.length > 64) {
        throw new HttpError(400, "Event ID must be between 1 and 64 characters")
      }
      if (!/^[a-zA-Z0-9_\-.:]+$/.test(trimmed)) {
        throw new HttpError(400, "Malformed event ID: invalid characters")
      }
      if (trimmed.includes(":")) {
        const colonIdx = trimmed.indexOf(":")
        const scope = trimmed.slice(0, colonIdx)
        const remainder = trimmed.slice(colonIdx + 1)
        if (scope !== run.id) {
          throw new HttpError(400, "Cross-run or invalidly scoped event ID")
        }
        if (remainder.length === 0 || remainder.includes(":")) {
          throw new HttpError(400, "Malformed scoped event ID")
        }
      }
      clientEventId = trimmed
    }

    const result = this.store.recordEventAndCheckBudget(
      run.id,
      body.event_type as any,
      body.payload,
      {
        tokensIn: body.tokens_in,
        tokensOut: body.tokens_out,
        costUsd: body.cost_usd ?? null,
      },
      clientEventId,
    )
    if (result.killTriggered) {
      this.log(`Run ${run.id} triggered server-side spending halt: ${result.killReason}`)
    }
    return json({ run_id: run.id, status: result.run.status })
  }

  finish = async (req: Request): Promise<Response> => {
    const claims = this.runClaims(req)
    const body = await readBody(req, FinishBody, MAX_RUNNER_BODY_BYTES)
    const target = body.status as RunStatus
    if (!TERMINAL_RUN_STATUSES.includes(target)) throw new HttpError(400, `${target} is not a terminal status`)

    const run = this.store.getRun(claims.runId)
    if (!run || run.agent_id !== claims.agentId) throw new HttpError(404, "Agent run not found")

    const outcome = this.store.finishRun(run.id, target, body.message)
    if (!outcome.ok) {
      throw new HttpError(409, outcome.message)
    }

    if (outcome.transitioned) {
      this.log(`Run ${run.id} finished: ${outcome.status}`)
    }
    return json({ run_id: run.id, status: outcome.status })
  }

  /**
   * Called when the engine asks for something the config does not grant. The
   * runner keeps the engine's request open, so the tool call stays blocked
   * rather than failing, and the decision comes back on a later heartbeat.
   * Idempotent per engine request id, so a retry after a dropped connection
   * does not prompt twice.
   */
  permissionRequest = async (req: Request): Promise<Response> => {
    const claims = this.runClaims(req)
    const body = await readBody(req, PermissionRequestBody, MAX_RUNNER_BODY_BYTES)
    const run = this.activeRun(claims)
    const agent = this.store.getAgent(run.agent_id)
    if (!agent) throw new HttpError(404, "Agent config not found")

    const existing = this.store.findRequest(run.id, body.engine_request_id)
    if (existing) {
      return json({
        request_id: existing.id,
        status: existing.status,
        expires_at: existing.expires_at,
        accepted: true,
      } satisfies PermissionRequestAck)
    }

    const refuse = (reason: string, message?: string) => {
      // Recorded either way: a refusal is the signal that an agent's grants are
      // too narrow for its task.
      this.store.addEvent(run.id, "permission_denied", {
        ...(message ? { message } : {}),
        permission: body.permission,
        patterns: body.patterns,
        reason,
      })
      return json({
        request_id: "",
        status: "denied",
        expires_at: new Date().toISOString(),
        accepted: false,
      } satisfies PermissionRequestAck)
    }

    if (agent.permission_mode !== "request") return refuse("strict_mode")
    if (this.store.pendingRequestCount(run.id) >= MAX_PENDING_REQUESTS_PER_RUN) {
      this.log(`Refused an escalation on run ${run.id}: too many already pending`)
      return refuse("too_many_pending", `Refused: ${body.permission} (too many requests already waiting)`)
    }

    const row = this.store.transaction(() => {
      const created = this.store.createRequest({
        runId: run.id,
        agentId: run.agent_id,
        engineRequestId: body.engine_request_id,
        permission: body.permission,
        patterns: body.patterns,
        metadata: body.metadata,
        expiresAt: new Date(Date.now() + agent.permission_request_timeout_seconds * 1000),
      })
      this.store.addEvent(run.id, "permission_request", {
        request_id: created.id,
        permission: body.permission,
        patterns: body.patterns,
        status: "pending",
      })
      return created
    })
    this.log(`Run ${run.id} asked for ${body.permission}; waiting on a decision`)
    return json({
      request_id: row.id,
      status: row.status,
      expires_at: row.expires_at,
      accepted: true,
    } satisfies PermissionRequestAck)
  }
}
