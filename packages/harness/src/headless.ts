/**
 * Headless execution, driven over the engine's own HTTP server rather than as
 * a one-shot process. A session on that server accepts more than one message
 * over its lifetime, which is what makes chat possible: a message from the
 * control plane is another prompt into a session that never stopped.
 */
import { log } from "./log"
import {
  abortSession,
  createSession,
  DECISION_REPLIES,
  unattendedRefusal,
  engineAuthHeader,
  replyToPermissionRequest,
  sendMessage,
  startEngineServer,
  subscribeEngineEvents,
  type ModelRef,
  type SessionHandle,
} from "./engine"
import { request } from "./http"
import type { Usage } from "./protocol"
import { terminateChildProcess } from "./process"
import {
  createTranscript,
  describeToolCall,
  engineErrorMessage,
  PERMISSION_ERROR,
  safeToolInput,
  tokenCounts,
  type TranscriptEntry,
} from "./transcript"
import type { ChildProcess } from "child_process"

import type { BudgetHaltReason, SpendingTracker } from "./spending"

// How long a session stays open after going idle before the run is reported
// finished. Long enough to catch a message someone is already typing when the
// task wraps up; short enough that a one-off task with nobody chatting does
// not sit "running" for no reason.
export const CHAT_IDLE_GRACE_MS = 60_000

export interface RunResult {
  success: boolean
  exitCode: number | null
  error?: string
  /** Went quiet without finishing: nothing happened, or it ended waiting on a person. */
  idle?: boolean
  budgetHalt?: BudgetHaltReason
}

export interface Ask {
  engineRequestId: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
}

export interface Denial {
  tool: string
  input: Record<string, unknown>
  message: string
  verb: string
  target: string
}

export interface HeadlessHooks {
  onLine(line: string): void
  onSpawn(child: ChildProcess): void
  onStep(entry: TranscriptEntry, usage?: Usage, eventId?: string): Promise<unknown> | void
  onReady(session: SessionHandle): void
  /** A request-mode ask: "escalated" leaves the engine's request open. */
  onAsked(ask: Ask): Promise<"escalated" | "denied">
  /** A call the engine refused on a rule, with no question asked. */
  onDenied(denial: Denial): void
}

export async function runHeadless(
  task: string,
  cwd: string,
  modelProvider: string,
  modelName: string,
  hooks: HeadlessHooks,
  spending?: SpendingTracker,
  engineStarter: typeof startEngineServer = startEngineServer,
): Promise<RunResult> {
  const { onLine } = hooks
  const { child, baseUrl, password } = await engineStarter(cwd, onLine)
  hooks.onSpawn(child)
  const authHeader = engineAuthHeader(password)
  const sessionId = await createSession(baseUrl, authHeader)
  // Every prompt call needs this: a session is not created with a fixed model,
  // and without it the engine silently falls back to its own default.
  const modelRef: ModelRef | undefined =
    modelProvider && modelName ? { providerID: modelProvider, modelID: modelName } : undefined

  let resolveFinished!: (result: RunResult) => void
  const finished = new Promise<RunResult>((r) => (resolveFinished = r))
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let lastError: unknown = null
  // A run that produced no step and no output did not succeed at its task, it
  // just sat there, and reporting that as success is how a misconfigured fleet
  // looks healthy.
  let sawProgress = false
  // Set when an escalation ran out of time with nobody deciding it. The run
  // continues (the one action is refused), but it ended waiting on a person.
  let sawUnansweredEscalation = false
  // Escalations the engine is blocked on, keyed by its own request id. While
  // this is non-empty the session reports idle, because it is waiting on a
  // person, so the idle grace must not run.
  const pendingEscalations = new Map<string, { permission: string; patterns: string[] }>()

  // Whether the engine is working on a turn. The grace timer used to start
  // when the task was sent and nothing stopped it while the agent worked, so a
  // first turn longer than a minute was cut off and reported as a success.
  let busy = false

  const engineIsBusy = async () => {
    try {
      const res = await request("GET", `${baseUrl}/session/status`, undefined, { Authorization: authHeader }, 5000)
      const current = res.data && res.data[sessionId]
      return Boolean(current && current.type !== "idle")
    } catch {
      return false
    }
  }

  let pendingReporting: Promise<unknown> | null = null

  // The event stream is not the only word on this: a missed "busy" must not
  // end a run that is working, so the engine is asked before the run ends.
  const finishIfStillIdle = async () => {
    if (await engineIsBusy()) {
      idleTimer = setTimeout(finishIfStillIdle, CHAT_IDLE_GRACE_MS)
      return
    }
    if (pendingReporting) {
      await pendingReporting
    }
    if (spending?.haltInfo) {
      resolveFinished({
        success: false,
        exitCode: 0,
        error: spending.haltInfo.message,
        budgetHalt: spending.haltInfo.reason,
      })
      return
    }
    resolveFinished({
      success: !lastError,
      exitCode: lastError ? 1 : 0,
      error: lastError ? engineErrorMessage(lastError) : undefined,
      idle: !sawProgress || sawUnansweredEscalation,
    })
  }

  const armIdleTimeout = () => {
    clearTimeout(idleTimer)
    if (busy || pendingEscalations.size > 0) return
    idleTimer = setTimeout(finishIfStillIdle, CHAT_IDLE_GRACE_MS)
  }

  // The engine going away ends the run now, not a minute later through the
  // grace timer. This is also what makes a kill take seconds.
  child.on("exit", (code, signal) => {
    clearTimeout(idleTimer)
    void (async () => {
      if (pendingReporting) {
        await pendingReporting
      }
      if (spending?.haltInfo) {
        resolveFinished({
          success: false,
          exitCode: code,
          error: spending.haltInfo.message,
          budgetHalt: spending.haltInfo.reason,
        })
        return
      }
      resolveFinished({
        success: false,
        exitCode: code,
        error: signal ? `The agent stopped (${signal}).` : `The agent exited unexpectedly (exit code ${code}).`,
      })
    })()
  })

  const transcript = createTranscript(cwd, { prompts: false })
  const events = subscribeEngineEvents(baseUrl, authHeader, (event) => {
    if (spending?.haltInfo) return
    const props = event.properties || {}
    if (props.sessionID && props.sessionID !== sessionId) return

    const entry = transcript.observe(event)
    if (entry) {
      // Local echo of the reply only; the control plane gets every entry.
      if (entry.kind === "reply") process.stdout.write(`${entry.message}\n`)
      hooks.onStep(entry)
    }

    if (event.type === "message.part.updated") {
      const part = props.part
      if (part.type === "step-finish") {
        sawProgress = true
        if (spending) spending.finishTurn()
        const tokens = tokenCounts(part.tokens)
        const stepId = typeof part.id === "string" ? part.id : undefined
        const stepPost = hooks.onStep(
          { kind: "usage", message: "Step finished" },
          { tokensIn: tokens.in, tokensOut: tokens.out, costUsd: typeof part.cost === "number" ? part.cost : null },
          stepId,
        )
        const reportingPromise =
          stepPost && typeof (stepPost as Promise<unknown>).then === "function"
            ? (stepPost as Promise<unknown>).catch((err) => {
                log(`Failed to report usage event: ${err}`)
              })
            : null
        if (reportingPromise) {
          pendingReporting = reportingPromise
        }
        if (spending) {
          const halt = spending.recordStepUsage(part)
          if (halt) {
            onLine(`[budget] Stopping run: ${halt.message}`)
            clearTimeout(idleTimer)
            events.close()
            void abortSession(baseUrl, authHeader, sessionId).then((abortRes) => {
              if (!abortRes.ok) {
                log(`Session abort request did not succeed: ${abortRes.error || `HTTP ${abortRes.status}`}`)
              }
            }).catch(() => {})
            terminateChildProcess(child)
            void (async () => {
              if (reportingPromise) {
                await reportingPromise
              }
              resolveFinished({
                success: false,
                exitCode: child.exitCode ?? 0,
                error: halt.message,
                budgetHalt: halt.reason,
              })
            })()
            return
          }
        }
      } else if (
        part.type === "tool" &&
        part.state &&
        part.state.status === "error" &&
        PERMISSION_ERROR.test(String(part.state.error || ""))
      ) {
        // Reported once per refused call, so a config whose grants are too
        // narrow for its task shows up as a denial rate rather than as a task
        // that mysteriously achieved nothing.
        // The description first: its own `message` field must not replace
        // the engine's reason, which is what `message` carries here.
        hooks.onDenied({
          ...describeToolCall(part.tool || "unknown", part.state.input, cwd, true),
          tool: part.tool || "unknown",
          input: safeToolInput(part.state.input),
          message: String(part.state.error || "").slice(0, 400),
        })
      }
    }

    if (event.type === "session.status" && props.status) {
      busy = props.status.type !== "idle"
      if (busy) clearTimeout(idleTimer)
      else armIdleTimeout()
    }

    if (event.type === "session.error") {
      lastError = props.error
      // Kept to the runner's log: the transcript already has this error once,
      // in words, from the failed reply itself.
      log(`The agent reported an error: ${engineErrorMessage(props.error)}`)
    }

    if (event.type === "permission.asked") {
      const patterns = (props.patterns || []).join(", ")
      void (async () => {
        const outcome = await hooks.onAsked({
          engineRequestId: props.id,
          permission: props.permission,
          patterns: props.patterns || [],
          metadata: props.metadata || {},
        })
        if (outcome === "escalated") {
          // Leave the engine's request open: the tool call stays blocked, which
          // is the point, the agent waits for an answer instead of failing and
          // working around it.
          pendingEscalations.set(props.id, { permission: props.permission, patterns: props.patterns || [] })
          clearTimeout(idleTimer)
          onLine(`Waiting on a decision for ${props.permission} on ${patterns}`)
          return
        }
        onLine(`Denied, outside the granted set: ${props.permission} on ${patterns}`)
        await replyToPermissionRequest(
          baseUrl,
          authHeader,
          props.id,
          "reject",
          onLine,
          unattendedRefusal("outside", props.permission, props.patterns || []),
        )
      })()
    }

    if (event.type === "session.idle") {
      busy = false
      armIdleTimeout()
    }
  })

  hooks.onReady({
    feedMessage: async (message) => {
      if (spending) {
        const admission = spending.canAdmitTurn()
        if (!admission.ok) {
          onLine(`[chat] Rejected chat message due to spending guardrails: ${admission.halt.message}`)
          return false
        }
        spending.startTurn()
      }
      clearTimeout(idleTimer) // a new message means the chat is still active
      onLine(`[chat] ${message}`)
      try {
        await sendMessage(baseUrl, authHeader, sessionId, message, modelRef)
        return true
      } catch (err) {
        if (spending) spending.finishTurn()
        onLine(`Failed to deliver chat message: ${err}`)
        return false
      }
    },
    applyDecision: async (decision) => {
      if (spending?.haltInfo) return false
      if (!pendingEscalations.has(decision.engine_request_id)) return false
      const reply = DECISION_REPLIES[decision.decision] || "reject"
      if (decision.decision === "expired") sawUnansweredEscalation = true
      const reason =
        reply === "reject"
          ? unattendedRefusal(decision.decision === "expired" ? "expired" : "denied", decision.permission, decision.patterns)
          : undefined
      await replyToPermissionRequest(baseUrl, authHeader, decision.engine_request_id, reply, onLine, reason)
      pendingEscalations.delete(decision.engine_request_id)
      onLine(`Permission ${decision.permission}: ${decision.decision}`)
      // The session has been sitting idle behind this call, so the grace
      // period starts now rather than from whenever it last went quiet.
      if (pendingEscalations.size === 0) armIdleTimeout()
      return true
    },
    hasPendingEscalations: () => pendingEscalations.size > 0,
    addContext: async (text) => {
      if (spending) {
        const admission = spending.canAdmitTurn()
        if (!admission.ok) {
          onLine(`[budget] Context turn not admitted: ${admission.halt.message}`)
          return
        }
        spending.startTurn()
      }
      clearTimeout(idleTimer)
      try {
        await sendMessage(baseUrl, authHeader, sessionId, text, modelRef)
      } catch (err) {
        if (spending) spending.finishTurn()
        onLine(`Failed to add context to the session: ${err}`)
      }
    },
  })

  if (spending) {
    const admission = spending.canAdmitTurn()
    if (!admission.ok) {
      onLine(`[budget] Initial prompt not admitted: ${admission.halt.message}`)
      clearTimeout(idleTimer)
      events.close()
      terminateChildProcess(child)
      return {
        success: false,
        exitCode: 0,
        error: admission.halt.message,
        budgetHalt: admission.halt.reason,
      }
    }
    spending.startTurn()
  }

  await sendMessage(baseUrl, authHeader, sessionId, task, modelRef)
  armIdleTimeout() // covers a task finishing before a busy status is ever observed

  const result = await finished
  clearTimeout(idleTimer)
  events.close()
  terminateChildProcess(child)
  return result
}
