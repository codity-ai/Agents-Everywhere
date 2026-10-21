/**
 * The runner protocol: what a runner and a control plane say to each other.
 * docs/runner-protocol.md is the prose version of this file.
 *
 * The runner always calls; the control plane only answers. Nothing ever dials
 * into the machine the runner is on, so every instruction for a running agent
 * (a kill, a chat message, a permission decision) rides the heartbeat reply.
 *
 * Shared by the runner and the control plane, so the two cannot disagree about
 * a field name or an allowed value. Fields a server may add beyond these are
 * carried as extensions and handed to runner extensions untouched.
 *
 * Types and constants only, so a browser bundle can import it too.
 */

/** Sent in run_env at handshake and returned by servers that know it. */
export const PROTOCOL_VERSION = 1

export const RUN_STATUSES = [
  "pending",
  "handshaked",
  "running",
  "succeeded",
  "failed",
  "killed",
  "idle_timeout",
  "budget_exceeded",
  "unpriced_usage_halt",
] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  "succeeded",
  "failed",
  "killed",
  "idle_timeout",
  "budget_exceeded",
  "unpriced_usage_halt",
]
export const LIVE_RUN_STATUSES: readonly RunStatus[] = ["handshaked", "running"]

/** Which terminal status a run in each state may be finished with. */
export const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  pending: ["handshaked", "killed", "failed"],
  // A run can finish before its first heartbeat moves it to running.
  handshaked: [
    "running",
    "succeeded",
    "killed",
    "failed",
    "idle_timeout",
    "budget_exceeded",
    "unpriced_usage_halt",
  ],
  running: [
    "succeeded",
    "failed",
    "killed",
    "idle_timeout",
    "budget_exceeded",
    "unpriced_usage_halt",
  ],
  succeeded: [],
  failed: [],
  killed: [],
  idle_timeout: [],
  budget_exceeded: [],
  unpriced_usage_halt: [],
}

export const RUNNER_CAPABILITY_GUARDRAILS = "spending_guardrails"

export const EVENT_TYPES = [
  "heartbeat",
  "step",
  "summary",
  "error",
  "user_message",
  "permission_denied",
  "permission_request",
] as const
export type EventType = (typeof EVENT_TYPES)[number]

/** Every event type except user_message is posted by the runner. */
export const RUNNER_EVENT_TYPES: readonly EventType[] = EVENT_TYPES.filter((t) => t !== "user_message")

export const PERMISSION_KINDS = ["filesystem", "bash_command", "webfetch_host"] as const
export type PermissionKind = (typeof PERMISSION_KINDS)[number]

export const PERMISSION_ACCESS = ["read", "write"] as const
export type PermissionAccess = (typeof PERMISSION_ACCESS)[number]

export const PERMISSION_EFFECTS = ["allow", "deny"] as const
export type PermissionEffect = (typeof PERMISSION_EFFECTS)[number]

export const PERMISSION_MODES = ["strict", "request"] as const
export type PermissionModeValue = (typeof PERMISSION_MODES)[number]

export const DECISIONS = ["approved_once", "approved_run", "approved_permanent", "denied"] as const
export type Decision = (typeof DECISIONS)[number]
export type RequestStatus = "pending" | "expired" | Decision

export const SECRET_PROVIDERS = ["aws", "gcp", "vault", "env"] as const
export type SecretProvider = (typeof SECRET_PROVIDERS)[number]

export const OS_SHELLS = ["linux_bash", "macos_zsh"] as const
export type OsShell = (typeof OS_SHELLS)[number]

export interface PermissionRule {
  path_pattern: string
  access: PermissionAccess
  kind: PermissionKind
  effect?: PermissionEffect
}

export interface SecretMapping {
  /** A reference, never a value: an ARN, a GCP resource name, a Vault path, or an env var name. */
  secret_arn: string
  key_to_env_var: Record<string, string>
  provider?: SecretProvider
  provider_config?: Record<string, any>
}

export interface HandshakeRequest {
  hostname: string | null
  run_env: Record<string, unknown>
}

export interface HandshakeResponse {
  run_id: string
  run_token: string
  run_token_expires_at: string
  task: string
  permissions: PermissionRule[]
  secrets: SecretMapping[]
  declared_env_vars: string[]
  model_provider: string
  model_name: string
  interactive: boolean
  permission_mode?: PermissionModeValue
  permission_request_timeout_seconds?: number
  /** The only time the LLM key leaves the control plane. */
  llm_api_key?: string | null
  spend_limit_usd?: number | null
  protocol_version?: number
  [extension: string]: unknown
}

export interface HeartbeatRequest {
  /** The newest chat message this runner has delivered; null to receive all. */
  after_event_id: string | null
  /** Decisions applied to the engine since the last beat. */
  applied_permission_request_ids: string[]
}

export interface PendingMessage {
  id: string
  message: string
}

export interface PermissionDecision {
  request_id: string
  engine_request_id: string
  permission: string
  patterns: string[]
  decision: Decision | "expired"
}

export interface HeartbeatResponse {
  kill: boolean
  kill_reason?: string | null
  status: RunStatus
  /** A replacement run token, when the current one is close to expiring. */
  run_token?: string | null
  messages?: PendingMessage[]
  permission_decisions?: PermissionDecision[]
  [extension: string]: unknown
}

export interface EventRequest {
  id?: string
  event_id?: string
  event_type: EventType
  payload: Record<string, unknown>
  tokens_in: number
  tokens_out: number
  cost_usd: number | null
}

export type FinishStatus =
  | "succeeded"
  | "failed"
  | "killed"
  | "idle_timeout"
  | "budget_exceeded"
  | "unpriced_usage_halt"

export interface PermissionRequestBody {
  engine_request_id: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
}

export interface PermissionRequestAck {
  request_id: string
  status: RequestStatus
  expires_at: string
  /** False when the server will not decide it: the runner refuses the call now. */
  accepted: boolean
}

export interface Usage {
  tokensIn?: number
  tokensOut?: number
  costUsd?: number | null
}
