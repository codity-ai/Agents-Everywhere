/**
 * Talking to the engine process: starting its HTTP server, driving a session,
 * following its event stream and answering its permission prompts.
 */
import { spawn, type ChildProcess } from "child_process"
import crypto from "crypto"
import http from "http"
import https from "https"
import net from "net"
import { engineBinPath } from "./binary"
import { request } from "./http"
import type { PermissionDecision } from "./protocol"

/** The username the engine's server accepts with its password. */
const ENGINE_USERNAME = "agents-everywhere"
const SERVER_BIND_TIMEOUT_MS = 15_000

export function randomPassword(): string {
  return crypto.randomBytes(24).toString("hex")
}

export function engineAuthHeader(password: string): string {
  return `Basic ${Buffer.from(`${ENGINE_USERNAME}:${password}`).toString("base64")}`
}

/** What a session can be told by the control plane while it runs. */
export interface SessionHandle {
  /** Returns whether the message reached the session, so the caller only
   *  counts it as delivered when it did and offers it again otherwise. */
  feedMessage(message: string): Promise<boolean>
  /** Applies one permission decision to the engine's blocked call; returns
   *  whether it landed, so only a delivered decision is acknowledged. */
  applyDecision(decision: PermissionDecision): Promise<boolean>
  hasPendingEscalations(): boolean
  /** Adds context to the conversation as another turn. */
  addContext(text: string): Promise<void>
}

export interface EngineServer {
  child: ChildProcess
  baseUrl: string
  password: string
}

/**
 * Starts the engine's own headless HTTP server and waits for it to report the
 * address it bound to. It binds to 127.0.0.1 only, and is still
 * password-protected with a password generated here and used only in this
 * process's own requests to it: the machine may be shared (a CI runner, a
 * shared VM), and an unauthenticated local port would let any other local
 * process read or write this session.
 */
export function startEngineServer(cwd: string, onLine: (line: string) => void): Promise<EngineServer> {
  return new Promise((resolve, reject) => {
    const password = randomPassword()
    const child = spawn(engineBinPath(), ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd,
      env: { ...process.env, AGENTS_EVERYWHERE_SERVER_PASSWORD: password },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let settled = false
    const bindTimeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill("SIGTERM")
      reject(new Error("agents-everywhere serve did not report a listening address within 15s"))
    }, SERVER_BIND_TIMEOUT_MS)
    const onData = (buf: Buffer) => {
      const text = buf.toString("utf8")
      for (const line of text.split("\n")) {
        if (line.trim()) onLine(line.trim())
      }
      const match = text.match(/listening on (https?:\/\/\S+)/)
      if (match && !settled) {
        settled = true
        clearTimeout(bindTimeout)
        resolve({ child, baseUrl: match[1], password })
      }
    }
    child.stdout!.on("data", onData)
    child.stderr!.on("data", onData)
    child.on("error", (err) => {
      if (settled) return
      settled = true
      clearTimeout(bindTimeout)
      reject(err)
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(bindTimeout)
      reject(new Error(`agents-everywhere serve exited before it started listening (code ${code})`))
    })
  })
}

export async function createSession(baseUrl: string, authHeader: string): Promise<string> {
  const res = await request("POST", `${baseUrl}/session`, {}, { Authorization: authHeader })
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Failed to create session (HTTP ${res.status}): ${JSON.stringify(res.data)}`)
  }
  return res.data.id
}

export interface ModelRef {
  providerID: string
  modelID: string
}

export async function sendMessage(
  baseUrl: string,
  authHeader: string,
  sessionId: string,
  text: string,
  modelRef: ModelRef | undefined,
) {
  const res = await request(
    "POST",
    `${baseUrl}/session/${sessionId}/prompt_async`,
    { parts: [{ type: "text", text }], ...(modelRef ? { model: modelRef } : {}) },
    { Authorization: authHeader },
  )
  if (res.status !== 204 && (res.status < 200 || res.status >= 300)) {
    throw new Error(`Failed to send message (HTTP ${res.status}): ${JSON.stringify(res.data)}`)
  }
}

export type EngineReply = "once" | "always" | "reject"

/**
 * Answers one of the engine's pending permission prompts.
 *
 * A tool call outside the granted set does not come back denied in request
 * mode: it comes back as a `permission.asked` event with the call blocked
 * inside the engine, exactly as it would be waiting for a person in the TUI.
 * Something has to answer it, or the agent waits forever.
 *
 * `reply` is the engine's own vocabulary: "reject" refuses this call, "once"
 * allows just it, and "always" also adds the request's own patterns to the
 * session's approved rules, so the rest of the run stops asking.
 */
export async function replyToPermissionRequest(
  baseUrl: string,
  authHeader: string,
  requestId: string,
  reply: EngineReply,
  onLine: (line: string) => void,
  message?: string,
) {
  const body = message ? { reply, message } : { reply }
  await request("POST", `${baseUrl}/permission/${requestId}/reply`, body, { Authorization: authHeader }).catch(
    (err) => onLine(`Failed to answer permission request ${requestId}: ${err}`),
  )
}

/**
 * Said to the agent with each refusal in an unattended run. A bare refusal ends
 * the agent's turn, which suits a person at a terminal who can say what to do
 * instead; with nobody there it ended runs without a word, so the refusal
 * carries a reason and the agent carries on without the action.
 */
const REFUSAL_REASONS = {
  outside: "It is outside what the agent may do here, and nobody approves requests during this run.",
  denied: "An operator refused it in the control plane.",
  expired: "Nobody answered the request in time, so it was refused.",
} as const
const CARRY_ON =
  "Do not retry that, and do not try to get the same result another way. Anything else the task needs that was not refused can still be done: carry on with it, and say at the end what you could not do and why."

export type RefusalReason = keyof typeof REFUSAL_REASONS

/** Names what was refused, so a command that touched several things is not read as refusing all of them. */
export function unattendedRefusal(reason: RefusalReason, permission: string, patterns: readonly string[]): string {
  return `Refused: ${permission} on ${patterns.join(", ") || "(no target)"}. ${REFUSAL_REASONS[reason]} ${CARRY_ON}`
}

// How the control plane's decisions map onto the engine's vocabulary. "For
// this run" and "permanently" are the same thing to the engine, both mean "stop
// asking for this", and differ only in whether the control plane also writes
// the rule back to the agent's config.
export const DECISION_REPLIES: Record<PermissionDecision["decision"], EngineReply> = {
  approved_once: "once",
  approved_run: "always",
  approved_permanent: "always",
  denied: "reject",
  expired: "reject",
}

/**
 * Subscribes to the engine's SSE event stream for the run's lifetime. This is
 * where real cost and token data and step-by-step progress come from:
 * `message.part.updated` events carry the same `step-finish` parts, with real
 * cost and tokens, that the engine's own `--format json` output uses.
 */
export function subscribeEngineEvents(baseUrl: string, authHeader: string, onEvent: (event: any) => void) {
  let closed = false
  const u = new URL(`${baseUrl}/event`)
  const mod = u.protocol === "https:" ? https : http
  const req = mod.request(
    u,
    { method: "GET", headers: { Authorization: authHeader, Accept: "text/event-stream" } },
    (res) => {
      let buffer = ""
      res.setEncoding("utf8")
      res.on("data", (chunk) => {
        if (closed) return
        buffer += chunk
        let idx: number
        while (!closed && (idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const line = frame.split("\n").find((l) => l.startsWith("data:"))
          if (!line) continue
          try {
            onEvent(JSON.parse(line.slice(5).trim()))
          } catch {
            /* malformed or partial frame: skip it, the stream keeps going */
          }
        }
      })
    },
  )
  req.on("error", () => {
    /* a dropped connection surfaces indirectly (no more progress, eventually
       the idle grace) rather than needing its own handling here */
  })
  req.end()
  return {
    close: () => {
      closed = true
      req.destroy()
    },
  }
}

/**
 * Binds a socket on 127.0.0.1 just long enough to learn an unused port, then
 * releases it. Something else could take that port before the caller binds it,
 * which is the standard trade for choosing a port up front instead of parsing
 * it out of output the caller cannot see.
 */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

/**
 * Sends an abort request to stop ongoing generation in the session.
 * Returns an explicit status and does not represent failure as success.
 */
export async function abortSession(
  baseUrl: string,
  authHeader: string,
  sessionId: string,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const res = await request(
      "POST",
      `${baseUrl}/session/${sessionId}/abort`,
      undefined,
      { Authorization: authHeader },
      3000,
    )
    return { ok: res.status >= 200 && res.status < 300, status: res.status }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}
