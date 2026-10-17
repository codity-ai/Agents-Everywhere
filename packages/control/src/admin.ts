/**
 * The admin API the web UI (or a script holding the admin token) uses to
 * create agents, mint install commands, read transcripts, talk to a running
 * agent, decide its permission requests and stop it.
 */
import { z } from "zod"
import {
  AGENT_DEFAULT_FIELDS,
  configuredRules,
  ENV_VAR_NAME,
  MAX_CONFIG_YAML_BYTES,
  parseGlobalYaml,
  Permission,
} from "./configuration"
import {
  DECISIONS,
  LIVE_RUN_STATUSES,
  OS_SHELLS,
  SECRET_PROVIDERS,
  TERMINAL_RUN_STATUSES,
  type Decision,
} from "@agents-everywhere/harness/protocol"
import { createBootstrapToken, seal, type Keys } from "./crypto"
import { HttpError, json, parseJson, readBody } from "./http"
import {
  dedupeRules,
  defaultDenyRules,
  permanentRulesFor,
  PolicyError,
  toRule,
  validatePermissions,
  type Rule,
} from "./policy"
import type { AgentRow, RunRow, SecretInput, Store } from "./store"

const MAX_ADMIN_BODY_BYTES = 1024 * 1024
const RUNS_SHOWN = 50
const DEFAULT_RUNS_PAGE = 20
const MAX_RUNS_PAGE = 100
const EVENTS_PAGE = 1000

const AWS_SECRET_ARN = /^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:.+$/

const Secret = z
  .object({
    provider: z.enum(SECRET_PROVIDERS).default("aws"),
    // A reference, never a value: an ARN, a GCP resource name, a Vault path, or an env var name.
    reference: z.string().trim().min(1).max(2048),
    key_to_env_var: z
      .record(z.string().min(1).max(200), z.string().regex(ENV_VAR_NAME, "must be an environment variable name"))
      .refine((m) => Object.keys(m).length > 0, "map at least one key to an environment variable"),
    provider_config: z.record(z.string(), z.unknown()).default({}),
  })
  .superRefine((s, ctx) => {
    if (s.provider === "aws" && !AWS_SECRET_ARN.test(s.reference)) {
      ctx.addIssue({ code: "custom", path: ["reference"], message: "doesn't look like an AWS Secrets Manager ARN" })
    }
    if (s.provider === "env" && !ENV_VAR_NAME.test(s.reference)) {
      ctx.addIssue({ code: "custom", path: ["reference"], message: "isn't a valid environment variable name" })
    }
  })

const AgentFields = {
  label: z.string().trim().min(1).max(255),
  task: AGENT_DEFAULT_FIELDS.task,
  location_label: AGENT_DEFAULT_FIELDS.location_label.optional(),
  model_provider: AGENT_DEFAULT_FIELDS.model_provider,
  model_name: AGENT_DEFAULT_FIELDS.model_name,
  llm_api_key: z.string().min(1).max(4096).optional(),
  interactive: AGENT_DEFAULT_FIELDS.interactive.optional(),
  permission_mode: AGENT_DEFAULT_FIELDS.permission_mode.optional(),
  permission_request_timeout_seconds: AGENT_DEFAULT_FIELDS.permission_request_timeout_seconds.optional(),
  declared_env_vars: AGENT_DEFAULT_FIELDS.declared_env_vars.optional(),
  secrets: z.array(Secret).max(50).optional(),
  rejection_yaml: z.string().max(MAX_CONFIG_YAML_BYTES).optional(),
  use_global_config: z.boolean().optional(),
}

const CreateAgent = z.object({
  ...AgentFields,
  task: AgentFields.task.optional(),
  model_provider: AgentFields.model_provider.optional(),
  model_name: AgentFields.model_name.optional(),
  os_shell: z.enum(OS_SHELLS).optional(),
  permissions: z.array(Permission).default([]),
  acknowledge_bash_gateways: z.boolean().default(false),
  // The standard deny rules, seeded as real, editable rows.
  seed_default_denies: z.boolean().default(true),
})

const UpdateAgent = z.object({
  label: AgentFields.label.optional(),
  location_label: AgentFields.location_label,
  task: AgentFields.task.optional(),
  model_provider: AgentFields.model_provider.optional(),
  model_name: AgentFields.model_name.optional(),
  llm_api_key: AgentFields.llm_api_key,
  clear_llm_api_key: z.boolean().optional(),
  interactive: AgentFields.interactive,
  permission_mode: AgentFields.permission_mode,
  permission_request_timeout_seconds: AgentFields.permission_request_timeout_seconds,
  declared_env_vars: AgentFields.declared_env_vars,
  secrets: AgentFields.secrets,
  rejection_yaml: AgentFields.rejection_yaml,
  use_global_config: AgentFields.use_global_config,
  permissions: z.array(Permission).optional(),
  acknowledge_bash_gateways: z.boolean().default(false),
})

const GlobalConfigBody = z.object({
  yaml: z.string().max(MAX_CONFIG_YAML_BYTES),
  revision: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER - 1),
  acknowledge_bash_gateways: z.boolean().default(false),
})

const RequiredCreationFields = z.object({
  task: AGENT_DEFAULT_FIELDS.task,
  model_provider: AGENT_DEFAULT_FIELDS.model_provider,
  model_name: AGENT_DEFAULT_FIELDS.model_name,
})

const ReplacePermissions = z.object({
  permissions: z.array(Permission),
  acknowledge_bash_gateways: z.boolean().default(false),
})

const MessageBody = z.object({ message: z.string().trim().min(1).max(8000) })
const DecisionBody = z.object({ decision: z.enum(DECISIONS) })
const LoginBody = z.object({ token: z.string().min(1).max(200) })

function policy<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    if (err instanceof PolicyError) throw new HttpError(400, err.message)
    throw err
  }
}

function toSecretInputs(secrets: z.infer<typeof Secret>[] | undefined): SecretInput[] {
  return (secrets ?? []).map((s) => ({
    provider: s.provider,
    reference: s.reference,
    key_to_env_var: s.key_to_env_var,
    provider_config: s.provider_config,
  }))
}

function runOut(run: RunRow) {
  return {
    id: run.id,
    status: run.status,
    hostname: run.hostname,
    run_env: parseJson(run.run_env, {}),
    kill_requested: run.kill_requested_at !== null,
    started_at: run.started_at,
    ended_at: run.ended_at,
    last_heartbeat_at: run.last_heartbeat_at,
    created_at: run.created_at,
  }
}

export interface RunCursor {
  created_at: string
  id: string
}

export function encodeCursor(cursor: RunCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")
}

export function decodeCursor(raw: string): RunCursor {
  try {
    const jsonStr = Buffer.from(raw, "base64url").toString("utf8")
    const parsed = JSON.parse(jsonStr)
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.created_at === "string" &&
      parsed.created_at.length > 0 &&
      typeof parsed.id === "string" &&
      parsed.id.length > 0
    ) {
      return { created_at: parsed.created_at, id: parsed.id }
    }
  } catch {
    // handled by throw
  }
  throw new HttpError(400, "Invalid pagination cursor")
}

function agentOut(agent: AgentRow) {
  return {
    id: agent.id,
    label: agent.label,
    os_shell: agent.os_shell,
    location_label: agent.location_label,
    status: agent.status,
    task: agent.task,
    model_provider: agent.model_provider,
    model_name: agent.model_name,
    // Never the key itself: it is sealed at rest and leaves only in a handshake.
    has_llm_api_key: agent.llm_api_key_sealed !== null,
    interactive: agent.interactive === 1,
    permission_mode: agent.permission_mode,
    permission_request_timeout_seconds: agent.permission_request_timeout_seconds,
    declared_env_vars: parseJson<string[]>(agent.declared_env_vars, []),
    rejection_yaml: agent.rejection_yaml,
    use_global_config: agent.use_global_config === 1,
    created_at: agent.created_at,
    updated_at: agent.updated_at,
  }
}

export class AdminApi {
  constructor(
    private readonly store: Store,
    private readonly keys: Keys,
    private readonly publicUrl: string,
    private readonly log: (line: string) => void,
  ) {}

  private agentOr404(id: string): AgentRow {
    const agent = this.store.getAgent(id)
    if (!agent) throw new HttpError(404, "Agent not found")
    return agent
  }

  /** The run must belong to the agent in the path; a run id alone reaches nothing. */
  private runOr404(agentId: string, runId: string): RunRow {
    const run = this.store.getRun(runId)
    if (!run || run.agent_id !== agentId) throw new HttpError(404, "Run not found on this agent")
    return run
  }

  private detail(agent: AgentRow) {
    const usage = this.store.agentUsage(agent.id)
    return {
      ...agentOut(agent),
      permissions: this.store.rules(agent.id),
      effective_permissions: this.store.effectiveRules(agent),
      secrets: this.store.secrets(agent.id).map((s) => ({
        id: s.id,
        provider: s.provider,
        reference: s.reference,
        key_to_env_var: parseJson(s.key_to_env_var, {}),
        provider_config: parseJson(s.provider_config, {}),
      })),
      runs: this.store.runs(agent.id, RUNS_SHOWN).map(runOut),
      total_runs: this.store.agentRunCount(agent.id),
      pending_permission_requests: this.store.requests(agent.id, true, 500).length,
      total_cost_usd: usage.cost ?? 0,
      total_tokens_in: usage.tokens_in ?? 0,
      total_tokens_out: usage.tokens_out ?? 0,
    }
  }

  loginBody = (req: Request) => readBody(req, LoginBody, 4096)

  getGlobalConfig = (): Response => {
    const config = this.store.globalConfig()
    return json({ ...config, document: parseGlobalYaml(config.yaml) })
  }

  saveGlobalConfig = async (req: Request): Promise<Response> => {
    const body = await readBody(req, GlobalConfigBody, MAX_ADMIN_BODY_BYTES)
    const document = policy(() => parseGlobalYaml(body.yaml))
    policy(() => validatePermissions(document.permissions, body.acknowledge_bash_gateways))
    for (const agent of this.store
      .listAgents()
      .filter((agent) => agent.use_global_config && agent.status !== "revoked")) {
      policy(() => configuredRules(this.store.rules(agent.id), agent.rejection_yaml, document.permissions))
    }
    if (!this.store.saveGlobalConfig(body.yaml, body.revision))
      throw new HttpError(409, "Global config changed. Reload it before saving.")
    return this.getGlobalConfig()
  }

  listAgents = async (): Promise<Response> =>
    json(
      this.store.listAgents().map((a) => ({
        ...agentOut(a),
        latest_run_id: a.latest_run_id,
        latest_run_status: a.latest_run_status,
        latest_run_last_heartbeat_at: a.latest_run_last_heartbeat_at,
        total_cost_usd: a.total_cost_usd ?? 0,
        total_tokens_in: a.total_tokens_in ?? 0,
        total_tokens_out: a.total_tokens_out ?? 0,
        pending_permission_requests: a.pending_requests,
      })),
    )

  createAgent = async (req: Request): Promise<Response> => {
    const body = await readBody(req, CreateAgent, MAX_ADMIN_BODY_BYTES)
    const global = body.use_global_config ? parseGlobalYaml(this.store.globalConfig().yaml) : null
    const fields = {
      ...global?.defaults,
      ...Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)),
    }
    const required = RequiredCreationFields.safeParse(fields)
    if (!required.success)
      throw new HttpError(
        422,
        `${required.error.issues[0].path.join(".")}: required or invalid; set it on the agent or in the selected global config`,
      )
    // Seeded first so an explicit row for the same pattern wins the dedupe.
    const requested: Rule[] = [...(body.seed_default_denies ? defaultDenyRules() : []), ...body.permissions.map(toRule)]
    const effective = policy(() => configuredRules(requested, body.rejection_yaml ?? "", global?.permissions))
    policy(() => validatePermissions(effective, body.acknowledge_bash_gateways))
    const defaults = global?.defaults ?? {}
    const id = this.store.createAgent(
      {
        label: body.label,
        os_shell: body.os_shell ?? defaults.os_shell ?? "linux_bash",
        location_label: body.location_label !== undefined ? body.location_label : (defaults.location_label ?? null),
        task: required.data.task,
        model_provider: required.data.model_provider,
        model_name: required.data.model_name,
        llm_api_key_sealed: body.llm_api_key ? seal(this.keys, body.llm_api_key) : null,
        interactive: body.interactive ?? defaults.interactive ?? false,
        permission_mode: body.permission_mode ?? defaults.permission_mode ?? "strict",
        permission_request_timeout_seconds:
          body.permission_request_timeout_seconds ?? defaults.permission_request_timeout_seconds ?? 900,
        declared_env_vars: body.declared_env_vars ?? defaults.declared_env_vars ?? [],
        rejection_yaml: body.rejection_yaml ?? "",
        use_global_config: body.use_global_config ?? false,
      },
      dedupeRules(requested),
      toSecretInputs(body.secrets),
    )
    this.log(`Agent created: ${body.label}`)
    return json(this.detail(this.store.getAgent(id)!), 201)
  }

  getAgent = async (_req: Request, id: string): Promise<Response> => json(this.detail(this.agentOr404(id)))

  updateAgent = async (req: Request, id: string): Promise<Response> => {
    const agent = this.agentOr404(id)
    if (agent.status === "revoked") throw new HttpError(409, "Cannot edit a revoked agent")
    const body = await readBody(req, UpdateAgent, MAX_ADMIN_BODY_BYTES)
    if (body.llm_api_key && body.clear_llm_api_key) throw new HttpError(422, "Set a new key or clear it, not both")
    const selected = body.use_global_config ?? agent.use_global_config === 1
    const global = selected ? parseGlobalYaml(this.store.globalConfig().yaml).permissions : []
    const rejection = body.rejection_yaml ?? agent.rejection_yaml
    const rules = body.permissions?.map(toRule) ?? this.store.rules(id)
    const effective = policy(() => configuredRules(rules, rejection, global))
    if (body.permissions || body.rejection_yaml !== undefined || body.use_global_config !== undefined) {
      policy(() => validatePermissions(effective, body.acknowledge_bash_gateways))
    }
    this.store.transaction(() => {
      this.store.updateAgent(id, {
        label: body.label,
        location_label: body.location_label,
        task: body.task,
        model_provider: body.model_provider,
        model_name: body.model_name,
        llm_api_key_sealed: body.llm_api_key ? seal(this.keys, body.llm_api_key) : undefined,
        clear_llm_api_key: body.clear_llm_api_key,
        interactive: body.interactive,
        permission_mode: body.permission_mode,
        permission_request_timeout_seconds: body.permission_request_timeout_seconds,
        declared_env_vars: body.declared_env_vars,
        rejection_yaml: body.rejection_yaml,
        use_global_config: body.use_global_config,
      })
      if (body.secrets) this.store.replaceSecrets(id, toSecretInputs(body.secrets))
      if (body.permissions) this.store.replaceRules(id, dedupeRules(rules))
    })
    return json(this.detail(this.store.getAgent(id)!))
  }

  /** Takes effect on the next run: a live runner holds the rules it was handed. */
  replacePermissions = async (req: Request, id: string): Promise<Response> => {
    const agent = this.agentOr404(id)
    if (agent.status === "revoked") throw new HttpError(409, "Cannot edit the permissions of a revoked agent")
    const body = await readBody(req, ReplacePermissions, MAX_ADMIN_BODY_BYTES)
    const rules = body.permissions.map(toRule)
    const global = agent.use_global_config ? parseGlobalYaml(this.store.globalConfig().yaml).permissions : []
    const effective = policy(() => configuredRules(rules, agent.rejection_yaml, global))
    policy(() => validatePermissions(effective, body.acknowledge_bash_gateways))
    this.store.replaceRules(id, dedupeRules(rules))
    return json(this.detail(this.store.getAgent(id)!))
  }

  /**
   * Mints a fresh single-use install command: a pending run and a bootstrap
   * token for it that expires in five minutes and is spent on first use.
   */
  installCommand = async (_req: Request, id: string): Promise<Response> => {
    const agent = this.agentOr404(id)
    if (agent.status === "revoked") throw new HttpError(409, "Cannot install a revoked agent")
    const runId = this.store.transaction(() => {
      const created = this.store.createPendingRun(id)
      this.store.activateAgent(id)
      return created
    })
    const { token, expiresAt } = createBootstrapToken(this.keys, id, runId)
    return json({
      run_id: runId,
      command: installCommand(this.publicUrl, token, agent.interactive === 1),
      expires_at: expiresAt.toISOString(),
    })
  }

  revoke = async (_req: Request, id: string): Promise<Response> => {
    this.agentOr404(id)
    const runsSignaled = this.store.revokeAgent(id)
    this.log(`Agent ${id} revoked; ${runsSignaled} run(s) told to stop`)
    return json({ status: "revoked", runs_signaled: runsSignaled })
  }

  listRuns = async (req: Request, id: string): Promise<Response> => {
    this.agentOr404(id)
    const url = new URL(req.url)
    const limitParam = url.searchParams.get("limit")
    let limit = DEFAULT_RUNS_PAGE
    if (limitParam !== null) {
      const parsed = Number(limitParam)
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_RUNS_PAGE) {
        throw new HttpError(400, `limit must be an integer between 1 and ${MAX_RUNS_PAGE}`)
      }
      limit = parsed
    }
    const cursorParam = url.searchParams.get("cursor")
    const cursor = cursorParam !== null ? decodeCursor(cursorParam) : null
    const result = this.store.runsPaginated(
      id,
      limit,
      cursor ? { createdAt: cursor.created_at, id: cursor.id } : null,
    )
    return json({
      runs: result.runs.map(runOut),
      total: result.total,
      next_cursor: result.nextCursor
        ? encodeCursor({ created_at: result.nextCursor.createdAt, id: result.nextCursor.id })
        : null,
      has_more: result.hasMore,
    })
  }

  getRun = async (_req: Request, id: string, runId: string): Promise<Response> => {
    this.agentOr404(id)
    const run = this.runOr404(id, runId)
    return json(runOut(run))
  }

  runEvents = async (req: Request, id: string, runId: string): Promise<Response> => {
    this.agentOr404(id)
    this.runOr404(id, runId)
    const after = Number(new URL(req.url).searchParams.get("after") || "0")
    const events = this.store.events(runId, Number.isFinite(after) && after > 0 ? after : 0, EVENTS_PAGE)
    return json(
      events.map((e) => ({
        id: e.id,
        seq: e.seq,
        event_type: e.event_type,
        // Written by the agent's model and the machine it ran on: data to show, never markup to render.
        payload: parseJson(e.payload, {}),
        tokens_in: e.tokens_in,
        tokens_out: e.tokens_out,
        cost_usd: e.cost_usd,
        created_at: e.created_at,
      })),
    )
  }

  /**
   * Complete machine-readable export of one run as NDJSON: a metadata line
   * followed by one stored event per line in sequence order. The upper
   * sequence boundary (`through_seq`) is fixed before reading, so a live run
   * yields a finite snapshot; rows past it are never written. Rows are read
   * in bounded pages and streamed, never held whole in memory.
   *
   * Format `agents-everywhere.run-export/1`: every line, header and records
   * alike, carries `format`, `agent_id` and `run_id` so each record is
   * self-describing. Records additionally carry `seq`, `id`, `event_type`,
   * `created_at`, verbatim `payload`, and usage fields (`tokens_in`,
   * `tokens_out`, `cost_usd`, where `null` cost means unknown, not zero).
   * Payloads are preserved verbatim and may contain sensitive task data;
   * metadata never carries credentials or tokens.
   */
  runExport = async (_req: Request, id: string, runId: string): Promise<Response> => {
    this.agentOr404(id)
    const run = this.runOr404(id, runId)
    const throughSeq = this.store.maxSeq(runId)
    const exportedAt = new Date().toISOString()
    const meta = {
      format: "agents-everywhere.run-export/1",
      agent_id: id,
      run_id: runId,
      exported_at: exportedAt,
      through_seq: throughSeq,
      run_status_at_export: run.status,
      note: "Finite snapshot: events after through_seq are excluded. Payloads are preserved verbatim and may contain sensitive task data.",
    }
    const filename = `run-${runId.slice(0, 8)}-through-${throughSeq}.ndjson`
    let cursor = 0
    let first = true
    const store = this.store
    const stream = new ReadableStream({
      pull(controller) {
        if (first) {
          first = false
          controller.enqueue(`${JSON.stringify(meta)}\n`)
        }
        const rows = store.events(runId, cursor, EVENTS_PAGE)
        for (const e of rows) {
          if (e.seq > throughSeq) {
            controller.close()
            return
          }
          cursor = Math.max(cursor, e.seq)
          controller.enqueue(
            `${JSON.stringify({
              format: "agents-everywhere.run-export/1",
              agent_id: id,
              run_id: runId,
              seq: e.seq,
              id: e.id,
              event_type: e.event_type,
              created_at: e.created_at,
              payload: parseJson(e.payload, {}),
              tokens_in: e.tokens_in,
              tokens_out: e.tokens_out,
              cost_usd: e.cost_usd,
            })}\n`,
          )
        }
        if (rows.length < EVENTS_PAGE || cursor >= throughSeq) controller.close()
      },
    })
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    })
  }

  /** Delivered on the run's next heartbeat, into the same session, as a follow-up turn. */
  sendMessage = async (req: Request, id: string, runId: string): Promise<Response> => {
    this.agentOr404(id)
    const run = this.runOr404(id, runId)
    if (!LIVE_RUN_STATUSES.includes(run.status))
      throw new HttpError(409, `The run is ${run.status}, so nothing would receive the message`)
    const body = await readBody(req, MessageBody, 64 * 1024)
    const event = this.store.addEvent(runId, "user_message", { message: body.message })
    return json({ id: event.id, created_at: event.created_at }, 201)
  }

  killRun = async (_req: Request, id: string, runId: string): Promise<Response> => {
    this.agentOr404(id)
    const run = this.runOr404(id, runId)
    if (TERMINAL_RUN_STATUSES.includes(run.status)) throw new HttpError(409, `The run is already ${run.status}`)
    return json({ result: this.store.requestKill(runId) })
  }

  permissionRequests = async (req: Request, id: string): Promise<Response> => {
    this.agentOr404(id)
    const pendingOnly = new URL(req.url).searchParams.get("pending") === "1"
    return json(
      this.store.requests(id, pendingOnly, 200).map((r) => ({
        id: r.id,
        run_id: r.run_id,
        run_hostname: r.run_hostname,
        permission: r.permission,
        patterns: parseJson(r.patterns, []),
        // Model-influenced text from the agent's own tool call: data, never markup.
        metadata: parseJson(r.metadata, {}),
        status: r.status,
        created_at: r.created_at,
        expires_at: r.expires_at,
        decided_at: r.decided_at,
      })),
    )
  }

  /**
   * The agent's tool call is blocked inside the engine while this is pending,
   * so the decision reaches it on the next heartbeat. A permanent approval
   * also writes the rule into the agent, so the next run starts with it.
   */
  decide = async (req: Request, id: string, requestId: string): Promise<Response> => {
    const agent = this.agentOr404(id)
    const body = await readBody(req, DecisionBody, 4096)
    const decision = body.decision as Decision
    const row = this.store.getRequest(requestId)
    if (!row || row.agent_id !== agent.id) throw new HttpError(404, "Permission request not found on this agent")
    if (row.status !== "pending") throw new HttpError(409, `This request was already ${row.status}`)

    const permanent =
      decision === "approved_permanent"
        ? policy(() => permanentRulesFor(row.permission, parseJson(row.patterns, []), this.store.effectiveRules(agent)))
        : []

    // Claimed atomically: two people clicking at once must not produce two
    // decisions for one blocked call.
    const decided = this.store.transaction(() => {
      if (!this.store.decideRequest(requestId, agent.id, decision)) return false
      if (permanent.length) this.store.addRules(agent.id, permanent)
      this.store.addEvent(row.run_id, "permission_request", {
        request_id: row.id,
        decision,
        permission: row.permission,
        patterns: parseJson(row.patterns, []),
      })
      return true
    })
    if (!decided) throw new HttpError(409, `This request was already ${this.store.getRequest(requestId)!.status}`)
    return json({ id: requestId, status: decision })
  }
}

/**
 * The command a person pastes, shaped for how it will run. Interactive mode
 * cannot be piped: `curl ... | bash` hands bash's stdin to the pipe, leaving no
 * terminal for the TUI to read keystrokes from, so it downloads first, to a
 * fresh mktemp file: a fixed name in /tmp could be planted by another local user
 * and swapped between the download and the run.
 */
export function installCommand(publicUrl: string, token: string, interactive: boolean): string {
  const script = `${publicUrl}/agent/install.sh`
  if (interactive) {
    return `f="$(mktemp)" && curl -fsSL ${script} -o "$f" && bash "$f" --token=${token} --api-url=${publicUrl} ; rm -f "$f"`
  }
  return `curl -fsSL ${script} | bash -s -- --token=${token} --api-url=${publicUrl}`
}
