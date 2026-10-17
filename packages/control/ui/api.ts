/** The admin API, with the session's CSRF token on everything that changes state. */
let csrfToken = ""
export const MAX_YAML_LENGTH = 64 * 1024

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export function setCsrfToken(token: string) {
  csrfToken = token
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(method !== "GET" ? { "X-CSRF-Token": csrfToken } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 401 && path !== "/api/session") window.dispatchEvent(new Event("signed-out"))
    throw new ApiError(res.status, typeof data.detail === "string" ? data.detail : `The server answered ${res.status}.`)
  }
  return data as T
}

export const api = {
  get: <T>(path: string) => call<T>("GET", path),
  post: <T>(path: string, body: unknown = {}) => call<T>("POST", path, body),
  put: <T>(path: string, body: unknown) => call<T>("PUT", path, body),
  patch: <T>(path: string, body: unknown) => call<T>("PATCH", path, body),
  delete: <T>(path: string) => call<T>("DELETE", path),
}

export interface Rule {
  path_pattern: string
  access: "read" | "write"
  kind: "filesystem" | "bash_command" | "webfetch_host"
  effect: "allow" | "deny"
}

export interface Secret {
  provider: "aws" | "gcp" | "vault" | "env"
  reference: string
  key_to_env_var: Record<string, string>
  provider_config: Record<string, unknown>
}

export interface Run {
  id: string
  status: string
  hostname: string | null
  run_env: Record<string, unknown>
  kill_requested: boolean
  started_at: string | null
  ended_at: string | null
  last_heartbeat_at: string | null
  created_at: string
}

export interface PaginatedRuns {
  runs: Run[]
  total?: number
  next_cursor: string | null
  has_more: boolean
}

export interface AgentSummary {
  id: string
  label: string
  status: "draft" | "active" | "revoked"
  model_provider: string
  model_name: string
  os_shell: string
  permission_mode: "strict" | "request"
  latest_run_status: string | null
  latest_run_last_heartbeat_at: string | null
  total_cost_usd: number
  pending_permission_requests: number
}

export interface Agent extends AgentSummary {
  task: string
  location_label: string | null
  has_llm_api_key: boolean
  interactive: boolean
  permission_request_timeout_seconds: number
  declared_env_vars: string[]
  permissions: Rule[]
  effective_permissions: Rule[]
  rejection_yaml: string
  use_global_config: boolean
  secrets: Array<Secret & { id: string }>
  runs: Run[]
  total_runs?: number
  total_tokens_in: number
  total_tokens_out: number
}

export interface GlobalConfig {
  yaml: string
  revision: number
  updated_at: string | null
  document: import("../src/configuration").GlobalDocument
}

export interface PermissionRequest {
  id: string
  run_id: string
  run_hostname: string | null
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  status: string
  created_at: string
  expires_at: string
}

export interface RunEvent {
  id: string
  seq: number
  event_type: string
  payload: Record<string, any>
  tokens_in: number
  tokens_out: number
  cost_usd: number | null
  created_at: string
}
