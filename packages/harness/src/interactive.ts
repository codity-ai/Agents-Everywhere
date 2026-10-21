/**
 * Interactive mode hands the engine's TUI the real terminal (`stdio:
 * "inherit"`) instead of piping it, but the TUI is not a closed box: it starts
 * the same HTTP server headless mode uses, on 127.0.0.1. Passing --port and
 * --hostname pins that server to a port chosen here (a "listening on" line
 * cannot be read out of inherited stdio), and AGENTS_EVERYWHERE_SERVER_PASSWORD
 * lets this process authenticate to it. That gives interactive runs the same
 * event stream, so cost, tokens, transcript and refusals are reported live.
 *
 * If that hand-off fails (the port raced with something else, the server never
 * came up), this falls back to reading the session's final cost out of local
 * storage once the process exits: worse than live, better than nothing.
 */
import { spawn, type ChildProcess } from "child_process"
import fs from "fs"
import { engineBinPath } from "./binary"
import {
  engineAuthHeader,
  getFreePort,
  randomPassword,
  sendMessage,
  startEngineServer,
  subscribeEngineEvents,
  type SessionHandle,
} from "./engine"
import type { RunResult } from "./headless"
import { request } from "./http"
import { log } from "./log"
import type { EventType, Usage } from "./protocol"
import { terminateChildProcess } from "./process"
import {
  clip,
  createTranscript,
  describeToolCall,
  PERMISSION_ERROR,
  safeToolInput,
  tokenCounts,
  TRANSCRIPT_TEXT_LIMIT,
} from "./transcript"
import type { BudgetHalt, SpendingTracker } from "./spending"

type PostEvent = (
  eventType: EventType,
  payload: Record<string, unknown>,
  usage?: Usage,
  eventId?: string,
) => Promise<unknown>

const READINESS_ATTEMPTS = 40
const READINESS_INTERVAL_MS = 250
const READINESS_PROBE_TIMEOUT_MS = 2000

interface SessionTotals {
  cost?: number
  tokens?: any
}

// session.directory is realpath-resolved (macOS's /tmp is really
// /private/tmp), but process.cwd() is not guaranteed to be, so compare against
// the resolved form. There is deliberately no "most recent session" fallback:
// reporting an unrelated session's cost is worse than reporting nothing.
function findSessionForDirectory(sessions: unknown, cwd: string): (SessionTotals & { id: string }) | undefined {
  const resolvedCwd = fs.realpathSync(cwd)
  return (Array.isArray(sessions) ? sessions : []).find((s: any) => s.directory === resolvedCwd)
}

/**
 * The fallback when live reporting never captured anything: reads the
 * session's cost and tokens from local storage after the fact, by starting a
 * fresh server against the same directory.
 *
 * Reports only the delta since `baseline`, the same directory's session state
 * captured as this run's engine came up. The engine resumes the same on-disk
 * session across separate launches in one directory, so the raw total already
 * includes cost from earlier runs; three launches reported the same total
 * three times before this. No baseline means new spend cannot be told from old,
 * so nothing is reported rather than a guess.
 */
async function defaultFetchSession(cwd: string): Promise<(SessionTotals & { id: string }) | undefined> {
  const server = await startEngineServer(cwd, () => {})
  try {
    const res = await request("GET", `${server.baseUrl}/session`, undefined, {
      Authorization: engineAuthHeader(server.password),
    })
    if (res.status < 200 || res.status >= 300 || !Array.isArray(res.data)) {
      throw new Error(`Failed to list sessions (HTTP ${res.status})`)
    }
    return findSessionForDirectory(res.data, cwd)
  } finally {
    terminateChildProcess(server.child)
  }
}

export async function reportSessionCost(
  cwd: string,
  postEvent: PostEvent,
  baseline: SessionTotals | null,
  spending?: SpendingTracker,
  fetchSession: (cwd: string) => Promise<(SessionTotals & { id: string }) | undefined> = defaultFetchSession,
): Promise<BudgetHalt | null> {
  if (!baseline) {
    log("No cost baseline for this interactive run, skipping the final cost report.")
    return null
  }
  try {
    const session = await fetchSession(cwd)
    if (!session) return null
    const tokens = tokenCounts(session.tokens)
    const baselineTokens = tokenCounts(baseline.tokens)
    const hasKnownSessionCost = typeof session.cost === "number" && Number.isFinite(session.cost)
    const hasKnownBaselineCost = typeof baseline.cost === "number" && Number.isFinite(baseline.cost)
    const hasKnownCost = hasKnownSessionCost && (baseline.cost === undefined || hasKnownBaselineCost)
    const costDelta = hasKnownCost ? Math.max(0, (session.cost as number) - (baseline.cost || 0)) : null
    const tokensInDelta = Math.max(0, tokens.in - baselineTokens.in)
    const tokensOutDelta = Math.max(0, tokens.out - baselineTokens.out)

    // Nothing new happened (the TUI was opened and closed without a message).
    if (costDelta === 0 && tokensInDelta <= 0 && tokensOutDelta <= 0) return null
    const summaryEventId = `summary_${session.id}`
    void postEvent(
      "summary",
      { message: "Interactive session finished" },
      { tokensIn: tokensInDelta, tokensOut: tokensOutDelta, costUsd: costDelta },
      summaryEventId,
    )
    if (spending) {
      return spending.recordFallbackUsage({
        costUsd: costDelta,
        tokensIn: tokensInDelta,
        tokensOut: tokensOutDelta,
      })
    }
  } catch (err) {
    log(`Could not report interactive session cost: ${err}`)
  }
  return null
}

export function runInteractive(
  cwd: string,
  model: string | undefined,
  postEvent: PostEvent,
  onSpawn: (child: ChildProcess) => void,
  onReady: (session: SessionHandle) => void,
  spending?: SpendingTracker,
  fetchSession: (cwd: string) => Promise<(SessionTotals & { id: string }) | undefined> = defaultFetchSession,
  childSpawner: typeof spawn = spawn,
): Promise<RunResult> {
  if (spending) {
    const admission = spending.canAdmitTurn()
    if (!admission.ok) {
      log(`[budget] Interactive session not admitted: ${admission.halt.message}`)
      return Promise.resolve({
        success: false,
        exitCode: 0,
        error: admission.halt.message,
        budgetHalt: admission.halt.reason,
      })
    }
  }

  return new Promise((resolve) => {
    let activeChild: ChildProcess | null = null
    let interactiveHalt: BudgetHalt | null = null
    let pendingReporting: Promise<unknown> | null = null
    // The TUI's own server once reachable, and the session the person is
    // working in. A message from the control plane goes into that session,
    // where the TUI shows it and the agent answers it like anything typed.
    let engine: { baseUrl: string; authHeader: string } | null = null
    let activeSessionId: string | null = null
    // Messages handed over from the control plane. The engine echoes each one
    // back as a user message, which would otherwise be recorded twice.
    const fedFromControlPlane = new Set<string>()
    let sawLiveUsage = false
    let events: { close(): void } | null = null
    let cancelled = false
    // Taken from the first successful /session response, before any work in
    // this run could have happened. Null means no baseline, and no guessing.
    let baseline: SessionTotals | null = null

    /** The session the TUI is showing, or before the event stream has named
     *  one, the latest for this directory. Null until the person starts one. */
    const findActiveSession = async (): Promise<string | null> => {
      if (activeSessionId) return activeSessionId
      const res = await request(
        "GET",
        `${engine!.baseUrl}/session`,
        undefined,
        { Authorization: engine!.authHeader },
        5000,
      )
      const resolvedCwd = fs.realpathSync(cwd)
      const mine = (Array.isArray(res.data) ? res.data : []).filter((s: any) => s.directory === resolvedCwd)
      mine.sort((a: any, b: any) => ((b.time && b.time.updated) || 0) - ((a.time && a.time.updated) || 0))
      return mine[0] ? mine[0].id : null
    }

    const sessionHandle = (): SessionHandle => ({
      feedMessage: async (message) => {
        if (interactiveHalt || spending?.haltInfo) {
          return false
        }
        if (spending) {
          const admission = spending.canAdmitTurn()
          if (!admission.ok) {
            log(`[chat] Rejected chat message in interactive session due to spending guardrails: ${admission.halt.message}`)
            return false
          }
          spending.startTurn()
        }
        if (!engine) {
          if (spending) spending.finishTurn()
          return false
        }
        try {
          const sessionId = await findActiveSession()
          if (!sessionId) {
            if (spending) spending.finishTurn()
            return false
          }
          fedFromControlPlane.add(clip(message, TRANSCRIPT_TEXT_LIMIT))
          // No model: the session's own, which is whatever the person chose in
          // the TUI. Forcing the configured one would undo that choice.
          await sendMessage(engine.baseUrl, engine.authHeader, sessionId, message, undefined)
          return true
        } catch (err) {
          if (spending) spending.finishTurn()
          log(`Could not hand a message to the session: ${err}`)
          return false
        }
      },
      // The person at the terminal answers the TUI's own permission prompts.
      applyDecision: async () => false,
      hasPendingEscalations: () => false,
      addContext: async () => {},
    })

    const followEvents = (baseUrl: string, authHeader: string) => {
      const transcript = createTranscript(cwd, { prompts: true })
      // What each open terminal question asked, so its answer can say what it allowed.
      const asked = new Map<string, string>()
      events = subscribeEngineEvents(baseUrl, authHeader, (event) => {
        if (interactiveHalt || spending?.haltInfo) return
        const props = event.properties || {}
        const part = props.part
        const info = props.info
        // The TUI asks the person at the terminal and they answer there. Without
        // these lines the transcript shows the action running as if nothing was asked.
        if (event.type === "permission.asked" && props.id) {
          const what = `${props.permission} on ${(props.patterns || []).join(", ")}`
          asked.set(props.id, what)
          void postEvent("step", { kind: "approval", message: `Asked at the terminal to use ${what}` })
        }
        if (event.type === "permission.replied" && props.requestID) {
          const what = asked.get(props.requestID)
          asked.delete(props.requestID)
          // A refusal is reported from the failed tool call below, with the reason.
          if (what && props.reply !== "reject") {
            const scope = props.reply === "always" ? "for the rest of the session" : "once"
            void postEvent("step", { kind: "approval", message: `Allowed ${scope} at the terminal: ${what}` })
          }
        }
        // Whichever session the person last worked in is where a message from
        // the control plane belongs.
        if (event.type === "message.updated" && info && info.sessionID) activeSessionId = info.sessionID
        const entry = transcript.observe(event)
        const echo = entry && entry.kind === "prompt" && fedFromControlPlane.delete(entry.message)
        if (entry && !echo) void postEvent("step", entry)
        // The TUI answers its own permission prompts, so nothing else in an
        // interactive run tells the control plane a rule fired.
        if (
          event.type === "message.part.updated" &&
          part &&
          part.type === "tool" &&
          part.state &&
          part.state.status === "error" &&
          PERMISSION_ERROR.test(String(part.state.error || ""))
        ) {
          const refused = describeToolCall(part.tool || "unknown", part.state.input, cwd, true)
          void postEvent("permission_denied", {
            message: `Refused: ${refused.message}`,
            tool: part.tool || "unknown",
            verb: refused.verb,
            target: refused.target,
            input: safeToolInput(part.state.input),
            reason: "rule",
            detail: String(part.state.error || "").slice(0, 400),
          })
        }
        if (event.type === "message.part.updated" && part && part.type === "step-finish") {
          const tokens = tokenCounts(part.tokens)
          const hasUsableUsage =
            (typeof part.cost === "number" && Number.isFinite(part.cost)) || tokens.in > 0 || tokens.out > 0
          if (hasUsableUsage) {
            sawLiveUsage = true
          }
          if (spending) spending.finishTurn()
          const stepId = typeof part.id === "string" ? part.id : undefined
          const stepPost = postEvent(
            "step",
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
              interactiveHalt = halt
              log(`[budget] Stopping interactive session: ${halt.message}`)
              if (events) events.close()
              if (activeChild) terminateChildProcess(activeChild)
            }
          }
        }
      })
    }

    const waitForServer = async (port: number, password: string) => {
      const baseUrl = `http://127.0.0.1:${port}`
      const authHeader = engineAuthHeader(password)
      for (let attempt = 0; attempt < READINESS_ATTEMPTS && !cancelled; attempt++) {
        await new Promise((r) => setTimeout(r, READINESS_INTERVAL_MS))
        try {
          // Short: this probes a server that is still starting, so a stalled
          // attempt has to give way to the next one.
          const res = await request(
            "GET",
            `${baseUrl}/session`,
            undefined,
            { Authorization: authHeader },
            READINESS_PROBE_TIMEOUT_MS,
          )
          if (res.status >= 200 && res.status < 300) {
            baseline = findSessionForDirectory(res.data, cwd) || { cost: 0, tokens: {} }
            engine = { baseUrl, authHeader }
            onReady(sessionHandle())
            followEvents(baseUrl, authHeader)
            return
          }
        } catch {
          /* not up yet: keep trying until the attempts run out */
        }
      }
    }

    const spawnChild = (port: number | null, password: string | null) => {
      const args = [
        ...(model ? ["--model", model] : []),
        ...(port ? ["--port", String(port), "--hostname", "127.0.0.1"] : []),
      ]
      const child = childSpawner(engineBinPath(), args, {
        cwd,
        env: port ? { ...process.env, AGENTS_EVERYWHERE_SERVER_PASSWORD: password! } : process.env,
        stdio: "inherit",
      })
      activeChild = child
      onSpawn(child)
      if (port) void waitForServer(port, password!)

      child.on("close", async (code) => {
        cancelled = true
        if (events) events.close()
        if (pendingReporting) {
          await pendingReporting
        }
        const needsFallback =
          !sawLiveUsage || (Boolean(spending && spending.limitUsd !== null) && !spending?.hasLiveUsage)
        if (needsFallback && !interactiveHalt && !spending?.haltInfo) {
          const fallbackHalt = await reportSessionCost(cwd, postEvent, baseline, spending, fetchSession)
          if (fallbackHalt) interactiveHalt = fallbackHalt
        }
        if (interactiveHalt || spending?.haltInfo) {
          const halt = interactiveHalt || spending!.haltInfo!
          resolve({
            success: false,
            exitCode: code,
            error: halt.message,
            budgetHalt: halt.reason,
          })
          return
        }
        resolve({ success: code === 0, exitCode: code })
      })
      child.on("error", (err) => resolve({ success: false, exitCode: null, error: String(err) }))
    }

    getFreePort()
      .then((port) => spawnChild(port, randomPassword()))
      .catch(() => spawnChild(null, null))
  })
}
