/**
 * One run, start to finish: handshake (install token for a run token, the task,
 * the permissions and the LLM key), translate the permissions into the engine's
 * config, run the task, heartbeat throughout, and finish with a terminal status.
 *
 * The heartbeat is the only way anything reaches this process: a kill, a chat
 * message and a permission decision all ride its reply, because nothing can
 * dial into the machine the runner is on.
 */
import crypto from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import type { ChildProcess } from "child_process"
import { parseArgs } from "./args"
import { ensureEngineInstalled } from "./binary"
import { brand, runnerHome } from "./brand"
import { RunnerClient } from "./client"
import type { SessionHandle } from "./engine"
import { providerKeyEnvVar, describeEndpoint, stripProviderEndpointOverrides } from "./environment"
import type { RunnerExtension } from "./extension"
import { runHeadless, type Ask, type Denial, type RunResult } from "./headless"
import { runInteractive } from "./interactive"
import { log, loggingToFile, logToFile } from "./log"
import { buildAgentConfig, detectWorktree, toConfigPatterns } from "./permissions"
import { runPreflight } from "./preflight"
import {
  PROTOCOL_VERSION,
  RUNNER_CAPABILITY_GUARDRAILS,
  type EventType,
  type FinishStatus,
  type HandshakeResponse,
  type PermissionDecision,
  type Usage,
} from "./protocol"
import { resolveSecretEnvVars } from "./secrets"
import { SpendingTracker, type BudgetHaltReason } from "./spending"
import { terminateChildProcess } from "./process"

const HEARTBEAT_INTERVAL_MS = 10_000
// While a decision is outstanding the agent is blocked, so the beat speeds up
// to keep a person's answer from sitting in a queue. It drops back to the
// normal interval as soon as nothing is waiting.
const WAITING_HEARTBEAT_INTERVAL_MS = 2_000

// What this runner can do, declared at handshake. A runner is downloaded when
// the agent starts and runs unchanged for as long as that session lasts, so a
// machine started before a feature existed keeps running without it. Saying
// what is supported lets a control plane tell a person which machine needs a
// restart instead of guessing from a transcript.
export const RUNNER_CAPABILITIES = ["transcript", "messages", RUNNER_CAPABILITY_GUARDRAILS]

/** Runs the runner command line. Resolves with the process exit code. */
export async function runRunner(argv: string[], extensions: readonly RunnerExtension[] = []): Promise<number> {
  const args = parseArgs(argv)

  if (args.preflight) return (await runPreflight(args.apiUrl)) ? 0 : 1

  if (!args.token) {
    log("Missing --token. This command is meant to be copied from the control plane's install command.")
    return 1
  }

  log(`Handshaking with ${args.apiUrl} ...`)
  const handshake = await RunnerClient.handshake(args.apiUrl, args.token, {
    hostname: os.hostname(),
    run_env: {
      platform: process.platform,
      node: process.version,
      protocol_version: PROTOCOL_VERSION,
      capabilities: [...RUNNER_CAPABILITIES, ...extensions.flatMap((e) => e.capabilities || [])],
    },
  })

  if (handshake.status !== 200) {
    log(`Handshake failed (HTTP ${handshake.status}): ${JSON.stringify(handshake.data)}`)
    log("A single-use install command expires after 5 minutes: generate a fresh one from the control plane.")
    return 1
  }

  return new Run(args.apiUrl, handshake.data, extensions).execute()
}

class Run {
  private readonly client: RunnerClient
  private readonly spending: SpendingTracker
  private readonly cwd = process.cwd()
  private readonly permissionMode: "strict" | "request"
  // Only used to name this run's local files; a random id keeps concurrent runs
  private readonly fileId: string
  private killed = false
  private killReason: string | null = null
  private activeChild: ChildProcess | null = null
  private engineConfigPath: string | null = null
  // Decisions applied to the engine but not yet confirmed to the control plane.
  private appliedRequestIds: string[] = []
  // Set once the engine's session exists. Everything the control plane sends
  // downstream rides the heartbeat, and needs a session to land in.
  private session: SessionHandle | null = null
  private lastDeliveredMessageId: string | null = null
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined
  private exiting = false

  constructor(
    private readonly apiUrl: string,
    private readonly handshake: HandshakeResponse,
    private readonly extensions: readonly RunnerExtension[],
  ) {
    this.client = new RunnerClient(apiUrl, handshake.run_token)
    this.spending = new SpendingTracker(handshake.spend_limit_usd)
    this.permissionMode = handshake.permission_mode === "request" ? "request" : "strict"
    this.fileId = handshake.run_id || crypto.randomBytes(8).toString("hex")
  }

  private postEvent = (
    eventType: EventType,
    payload: Record<string, unknown> | string,
    usage?: Usage,
    eventId?: string,
  ) =>
    this.client
      .postEvent(eventType, typeof payload === "string" ? { message: payload } : payload, usage, eventId)
      .catch((err) => log(`Failed to post event: ${err}`))

  private async finish(status: FinishStatus, message: string) {
    const res = await this.client.finish(status, message).catch((err) => ({ status: 0, data: { detail: String(err) } }))
    if (res.status !== 200) {
      log(`Server did not accept the final status "${status}" (HTTP ${res.status}): ${JSON.stringify(res.data)}`)
    }
    return res
  }

  private stopAgent(reason: string) {
    if (this.killed) return
    this.killed = true
    log(reason)
    if (this.activeChild) terminateChildProcess(this.activeChild)
  }

  private beat = async () => {
    try {
      const hb = await this.client.heartbeat({
        after_event_id: this.lastDeliveredMessageId,
        applied_permission_request_ids: this.appliedRequestIds,
      })
      // The service has finished with this run: the token expired or was
      // revoked (401), the run is gone (404), or it already ended (409), for
      // instance marked lost after a long silence. Nothing this machine sends
      // will be accepted again, so the agent is stopped rather than left
      // working with nobody able to see or stop it.
      if (hb.status === 401 || hb.status === 404 || hb.status === 409) {
        this.stopAgent(`The service no longer accepts this run (HTTP ${hb.status}); stopping.`)
        return
      }
      const data = hb.data || ({} as typeof hb.data)
      if (data.run_token) this.client.replaceToken(data.run_token)
      // Only clear what the server has now been told about, so an
      // acknowledgement lost with a dropped connection is simply repeated.
      if (data.kill) {
        if (data.kill_reason) {
          this.killReason = String(data.kill_reason)
        }
        this.stopAgent(
          this.killReason === "budget_exceeded" || this.killReason === "unpriced_usage_halt"
            ? `Server requested spending halt (${this.killReason}); stopping.`
            : "Kill requested from the control plane, stopping.",
        )
      }

      // A message is acknowledged only once it has reached the agent. Stopping
      // at the first that cannot be delivered keeps it, and everything after
      // it, queued and in order for the next beat.
      for (const m of this.killed || this.spending.haltReason ? [] : data.messages || []) {
        const delivered = this.session ? await this.session.feedMessage(m.message) : false
        if (!delivered) break
        this.lastDeliveredMessageId = m.id
        void this.postEvent("step", {
          kind: "delivered",
          message_id: m.id,
          message: "Delivered a message from the control plane",
        })
      }

      const decisions: PermissionDecision[] = this.killed ? [] : data.permission_decisions || []
      for (const decision of decisions) {
        if (!this.session) continue
        if (await this.session.applyDecision(decision)) this.appliedRequestIds.push(decision.request_id)
      }

      if (hb.status === 200 && this.session && !this.killed) {
        for (const extension of this.extensions) {
          await extension.onHeartbeat?.(data, this.session).catch((err) => log(`${extension.name}: ${err}`))
        }
      }

      // One timer, one job: the same beat, re-scheduled faster while a
      // decision is waiting on a person.
      const waiting = decisions.length > 0 || Boolean(this.session && this.session.hasPendingEscalations())
      this.scheduleBeat(waiting ? WAITING_HEARTBEAT_INTERVAL_MS : HEARTBEAT_INTERVAL_MS)
    } catch (err) {
      log(`Heartbeat failed: ${err}`)
      this.scheduleBeat(HEARTBEAT_INTERVAL_MS)
    }
  }

  private scheduleBeat(delay: number) {
    clearTimeout(this.heartbeatTimer)
    this.heartbeatTimer = setTimeout(() => void this.beat(), delay)
  }

  // A second SIGTERM or SIGINT can arrive while the first is still finishing
  // (`timeout` delivers SIGTERM twice), which would post the finish call twice.
  private onExitSignal = async (signal: string) => {
    if (this.exiting) return
    this.exiting = true
    this.killReason = "operator_kill"
    log(`Received ${signal}, finishing run as killed.`)
    clearTimeout(this.heartbeatTimer)
    // The engine's server is spawned with piped stdio, so it outlives this
    // process unless it is told to stop.
    if (this.activeChild) terminateChildProcess(this.activeChild)
    // process.exit skips the run's finally, so the config is removed here too.
    this.removeEngineConfig()
    await this.finish("killed", `stopped by ${signal}`)
    process.exit(1)
  }

  /** Puts the LLM key and fetched secrets into this process's environment,
   *  which the engine inherits. Nothing is written to disk or logged. */
  private async prepareEnvironment(): Promise<string[]> {
    const { handshake } = this
    if (handshake.llm_api_key) process.env[providerKeyEnvVar(handshake.model_provider)] = handshake.llm_api_key

    for (const { name, value } of stripProviderEndpointOverrides(
      process.env,
      handshake.model_provider,
      handshake.declared_env_vars || [],
    )) {
      log(
        `Ignoring ${name}=${describeEndpoint(value)} from this machine's environment: the key for this run is for ` +
          `${handshake.model_provider} itself, and sending it elsewhere would hand it to that service. ` +
          `Add ${name} to the agent's declared environment variables if the gateway is deliberate.`,
      )
    }

    const fetched = await resolveSecretEnvVars(handshake.secrets || [], log)
    for (const [envVar, value] of Object.entries(fetched)) process.env[envVar] = value
    return [...new Set([...(handshake.declared_env_vars || []), ...Object.keys(fetched)])]
  }

  private taskForAgent(availableEnvVars: string[]): string {
    let task = this.handshake.task
    // Carried in the first prompt rather than as a separate turn, so the agent
    // starts out with it at no extra cost.
    for (const extension of this.extensions) {
      const context = extension.initialContext?.(this.handshake, log)
      if (context) task = `${task}\n\n${context}`
    }
    if (availableEnvVars.length > 0) {
      log(`Environment variables available to the agent: ${availableEnvVars.join(", ")}`)
      task =
        `${task}\n\n(You have these environment variables available for authentication: ${availableEnvVars.join(", ")}. ` +
        "Use them as needed, for example via a credential helper, the provider's own CLI, or directly, and never print their values.)"
    }
    return task
  }

  /** A tool call the engine refused on a rule, with no question asked. */
  private reportRefusedCall = (denial: Denial) => {
    log(`Refused by the permission rules: ${denial.tool}`)
    void this.postEvent("permission_denied", {
      message: `Refused: ${denial.verb ? `${denial.verb} ${denial.target}`.trim() : denial.tool}`,
      tool: denial.tool,
      verb: denial.verb,
      target: denial.target,
      input: denial.input,
      reason: "rule",
      detail: denial.message,
    })
  }

  /**
   * In request mode, turns an ask into a decision for a person. Anything
   * unexpected (a strict-mode config, an unreachable server, a malformed
   * answer) resolves to "denied": the failure mode of guessing the other way is
   * an agent doing something nobody allowed.
   */
  private raisePermissionRequest = async (ask: Ask): Promise<"escalated" | "denied"> => {
    if (this.permissionMode !== "request") {
      void this.postEvent("permission_denied", {
        message: `Denied ${ask.permission} on ${ask.patterns.join(", ")}`,
        permission: ask.permission,
        patterns: ask.patterns,
        reason: "strict_mode",
      })
      return "denied"
    }
    const res = await this.client
      .raisePermissionRequest({
        engine_request_id: String(ask.engineRequestId),
        permission: ask.permission,
        patterns: toConfigPatterns(ask.permission, ask.patterns, this.cwd, detectWorktree(this.cwd)),
        metadata: ask.metadata,
      })
      .catch((err) => {
        log(`Could not raise a permission request: ${err}`)
        return { status: 0, data: null }
      })
    if (res.status >= 200 && res.status < 300 && res.data && res.data.accepted) return "escalated"
    return "denied"
  }

  /** Writes the engine's permission config, readable by this user only. */
  private writeEngineConfig() {
    const worktree = detectWorktree(this.cwd)
    const config = buildAgentConfig(this.handshake.permissions || [], this.cwd, worktree, this.permissionMode)
    log(
      this.permissionMode === "request"
        ? "Anything outside the granted set will be raised in the control plane for a decision."
        : "Anything outside the granted set will be refused.",
    )
    if (worktree !== this.cwd) {
      log(`The agent's project root is ${worktree} (no git repository at ${this.cwd}), so paths are scoped from there.`)
    }
    // Not os.tmpdir(): on a shared machine any local user can rewrite a
    // world-writable file, and this file is the permission boundary.
    fs.mkdirSync(runnerHome(), { recursive: true })
    const configPath = path.join(runnerHome(), `run-${this.fileId}.json`)
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 })
    fs.chmodSync(configPath, 0o600)
    process.env.AGENTS_EVERYWHERE_CONFIG = configPath
    this.engineConfigPath = configPath
    log(`Wrote permission config to ${configPath}`)
  }

  private removeEngineConfig() {
    if (!this.engineConfigPath) return
    try {
      fs.unlinkSync(this.engineConfigPath)
    } catch {
      /* best-effort cleanup */
    }
    this.engineConfigPath = null
  }

  private onLine = (line: string) => {
    // In interactive mode this would land on the TUI's screen, so it follows
    // the runner's log to its file instead. The run's event stream carries it
    // either way, marked as the runner speaking rather than the agent.
    if (loggingToFile()) log(line)
    else process.stdout.write(`${line}\n`)
    void this.postEvent("step", { kind: "notice", message: line })
  }

  private async runAgent(taskForAgent: string): Promise<RunResult> {
    const { handshake } = this
    if (handshake.interactive) {
      // No dry-run branch: a simulated interactive session has nothing to hand control to.
      const install = await ensureEngineInstalled(this.apiUrl, this.onLine)
      if (!install.ok) return this.installFailed(install.reason)
      // From here the TUI owns the screen, so this process stops writing to it.
      const interactiveLog = path.join(runnerHome(), `run-${this.fileId}.log`)
      process.stderr.write(`[${brand().name}] Handing over to the agent. Runner log: ${interactiveLog}\n`)
      logToFile(interactiveLog)
      log("Handing control to the agent's interactive session, type your task in there.")
      void this.postEvent("step", { kind: "notice", message: "Started an interactive session" })
      const model =
        handshake.model_provider && handshake.model_name
          ? `${handshake.model_provider}/${handshake.model_name}`
          : undefined
      return runInteractive(
        this.cwd,
        model,
        this.postEvent,
        (child) => (this.activeChild = child),
        (session) => (this.session = session),
        this.spending,
      )
    }

    if (process.env[brand().dryRunEnv] === "1")
      return runDryRun(handshake.task, handshake.permissions || [], this.onLine)

    const install = await ensureEngineInstalled(this.apiUrl, this.onLine)
    if (!install.ok) return this.installFailed(install.reason)
    log("Running task for real.")
    try {
      return await runHeadless(
        taskForAgent,
        this.cwd,
        handshake.model_provider,
        handshake.model_name,
        {
          onLine: this.onLine,
          onSpawn: (child) => (this.activeChild = child),
          onStep: (entry, usage, eventId) => this.postEvent("step", entry, usage, eventId),
          onReady: (session) => (this.session = session),
          onAsked: this.raisePermissionRequest,
          onDenied: this.reportRefusedCall,
        },
        this.spending,
      )
    } catch (err) {
      this.onLine(`Failed to run task: ${err}`)
      return { success: false, exitCode: null, error: String(err) }
    }
  }

  private installFailed(reason: string): RunResult {
    this.onLine("Could not install agents-everywhere automatically, see the error above.")
    void this.postEvent("error", { message: "Agent binary unavailable", reason })
    return { success: false, exitCode: null, error: reason }
  }

  async execute(): Promise<number> {
    const { handshake } = this
    log(`Handshake OK. Task: ${handshake.task}`)
    log(`Model: ${handshake.model_provider}/${handshake.model_name}`)
    if (handshake.interactive) log("Interactive mode: the agent's TUI will take over this terminal.")

    this.scheduleBeat(HEARTBEAT_INTERVAL_MS)
    process.on("SIGINT", () => void this.onExitSignal("SIGINT"))
    process.on("SIGTERM", () => void this.onExitSignal("SIGTERM"))

    const availableEnvVars = await this.prepareEnvironment()
    const taskForAgent = this.taskForAgent(availableEnvVars)
    this.writeEngineConfig()

    let result: RunResult
    try {
      result = await this.runAgent(taskForAgent)
    } finally {
      this.activeChild = null
      this.removeEngineConfig()
    }

    clearTimeout(this.heartbeatTimer)

    const outcome = determineTerminalOutcome({
      killed: this.killed,
      killReason: this.killReason,
      result,
      spending: this.spending,
      interactive: handshake.interactive,
    })
    const finished = await this.finish(outcome.status, outcome.message)
    if (finished.status === 200) log(`Run ${outcome.status}.`)
    return outcome.exitCode === 0 && finished.status === 200 ? 0 : 1
  }
}

export interface RunOutcome {
  killed: boolean
  killReason?: string | null
  result: RunResult
  spending: SpendingTracker
  interactive?: boolean
}

export interface TerminalOutcome {
  status: FinishStatus
  message: string
  exitCode: number
}

export function determineTerminalOutcome(outcome: RunOutcome): TerminalOutcome {
  const budgetHalt =
    outcome.result.budgetHalt ||
    outcome.spending.haltReason ||
    (outcome.killReason === "budget_exceeded" || outcome.killReason === "unpriced_usage_halt"
      ? (outcome.killReason as BudgetHaltReason)
      : null)

  if (budgetHalt) {
    const defaultMsg =
      budgetHalt === "budget_exceeded"
        ? "Spend limit reached."
        : "Unpriced token usage observed under configured budget."
    const message = outcome.result.error || outcome.spending.haltInfo?.message || defaultMsg
    return { status: budgetHalt, message, exitCode: 1 }
  }

  if (outcome.killed) {
    return { status: "killed", message: "stopped by operator", exitCode: 0 }
  }

  const status: FinishStatus = outcome.result.success
    ? outcome.result.idle
      ? "idle_timeout"
      : "succeeded"
    : "failed"
  const mode = outcome.interactive ? "Interactive session" : "Task"
  const message = outcome.result.success
    ? outcome.interactive
      ? "Interactive session ended."
      : outcome.result.idle
        ? "Session went idle with no work in progress."
        : "Task completed."
    : `${mode} failed (exit code ${outcome.result.exitCode}). ${outcome.result.error || ""}`.trim()
  return { status, message, exitCode: outcome.result.success ? 0 : 1 }
}

/**
 * Explicit opt-in only: exercises the handshake, heartbeat, event and finish
 * loop against a simulated task without touching the filesystem, for testing a
 * control plane without the engine installed. A real task must never fall back
 * to this: reporting success for a task nobody attempted is worse than an
 * honest failure.
 */
async function runDryRun(
  task: string,
  permissions: HandshakeResponse["permissions"],
  onLine: (line: string) => void,
): Promise<RunResult> {
  onLine(`[DRY RUN, no real work is happening] simulating: ${task}`)
  onLine(
    `[dry-run] permissions granted: ${permissions.map((p) => `${p.access}:${p.path_pattern}`).join(", ") || "(none)"}`,
  )
  await new Promise((r) => setTimeout(r, 2000))
  onLine("[dry-run] simulated task complete: no files were touched, nothing was actually investigated")
  return { success: true, exitCode: 0 }
}
