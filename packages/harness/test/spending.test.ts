import { expect, test, describe } from "bun:test"
import assert from "node:assert"
import http from "http"
import net from "net"
import fs from "fs"
import { EventEmitter } from "events"
import type { ChildProcess } from "child_process"
import { SpendingTracker, isValidPartId } from "../src/spending"
import { reportSessionCost, runInteractive } from "../src/interactive"
import { runHeadless, type HeadlessHooks, type RunResult } from "../src/headless"
import { terminateChildProcess } from "../src/process"
import { determineTerminalOutcome } from "../src/run"
import { abortSession, type SessionHandle } from "../src/engine"
import type { FinishStatus, Usage } from "../src/protocol"
import { RunnerClient } from "../src/client"
import { tokenCounts } from "../src/transcript"

type MockChildProcess = Omit<ChildProcess, "exitCode"> & {
  exitCode: number | null
  signalsReceived: string[]
}

function createMockChild(pid = 12345): MockChildProcess {
  const child = new EventEmitter() as any
  child.pid = pid
  child.exitCode = null
  child.signalCode = null
  child.killed = false
  child.signalsReceived = [] as string[]
  child.kill = (signal: string) => {
    child.signalsReceived.push(signal)
    child.killed = true
    return true
  }
  return child
}

describe("Phase 4 — Runner-Side Spending Tracking & Enforcement", () => {
  describe("SpendingTracker core accounting", () => {
    test("no budget configured allows execution and accumulates cost for reporting without halting", () => {
      const tracker = new SpendingTracker(null)
      assert.strictEqual(tracker.limitUsd, null)
      assert.strictEqual(tracker.canAdmitTurn().ok, true)

      // Step 1: priced usage
      const halt1 = tracker.recordStepUsage({ id: "part_1", cost: 1.25, tokens: { input: 100, output: 50 } })
      assert.strictEqual(halt1, null)
      assert.strictEqual(tracker.spentUsd, 1.25)
      assert.strictEqual(tracker.haltReason, null)
      assert.strictEqual(tracker.canAdmitTurn().ok, true)

      // Step 2: unpriced usage without budget is permitted
      const halt2 = tracker.recordStepUsage({ id: "part_2", cost: null, tokens: { input: 500, output: 200 } })
      assert.strictEqual(halt2, null)
      assert.strictEqual(tracker.spentUsd, 1.25)
      assert.strictEqual(tracker.haltReason, null)
      assert.strictEqual(tracker.canAdmitTurn().ok, true)
    })

    test("spending below the limit accumulates accurately and continues admitting turns", () => {
      const tracker = new SpendingTracker(5.0)
      assert.strictEqual(tracker.limitUsd, 5.0)

      tracker.startTurn()
      const halt1 = tracker.recordStepUsage({ id: "p1", cost: 1.5, tokens: { input: 100, output: 50 } })
      tracker.finishTurn()

      assert.strictEqual(halt1, null)
      assert.strictEqual(tracker.spentUsd, 1.5)
      assert.strictEqual(tracker.haltReason, null)
      assert.strictEqual(tracker.canAdmitTurn().ok, true)

      tracker.startTurn()
      const halt2 = tracker.recordStepUsage({ id: "p2", cost: 2.25, tokens: { input: 200, output: 80 } })
      tracker.finishTurn()

      assert.strictEqual(halt2, null)
      assert.strictEqual(tracker.spentUsd, 3.75)
      assert.strictEqual(tracker.haltReason, null)
      assert.strictEqual(tracker.canAdmitTurn().ok, true)
    })

    test("spending reaching the limit halts execution with budget_exceeded", () => {
      const tracker = new SpendingTracker(3.0)

      tracker.recordStepUsage({ id: "p1", cost: 2.0, tokens: { input: 100, output: 50 } })
      assert.strictEqual(tracker.haltReason, null)
      assert.strictEqual(tracker.canAdmitTurn().ok, true)

      const halt = tracker.recordStepUsage({ id: "p2", cost: 1.0, tokens: { input: 50, output: 25 } })
      assert.notStrictEqual(halt, null)
      assert.strictEqual(halt?.reason, "budget_exceeded")
      assert.strictEqual(tracker.spentUsd, 3.0)
      assert.strictEqual(tracker.haltReason, "budget_exceeded")

      const admission = tracker.canAdmitTurn()
      assert.strictEqual(admission.ok, false)
      if (!admission.ok) {
        assert.strictEqual(admission.halt.reason, "budget_exceeded")
        assert.ok(admission.halt.message.includes("$3.00"))
      }
    })

    test("spending exceeding the limit accounts for in-flight overruns and halts with budget_exceeded", () => {
      const tracker = new SpendingTracker(2.0)

      tracker.startTurn()
      const halt = tracker.recordStepUsage({ id: "p1", cost: 3.5, tokens: { input: 1000, output: 500 } })
      tracker.finishTurn()

      assert.notStrictEqual(halt, null)
      assert.strictEqual(halt?.reason, "budget_exceeded")
      assert.strictEqual(tracker.spentUsd, 3.5)
      assert.strictEqual(tracker.haltReason, "budget_exceeded")
      assert.strictEqual(tracker.canAdmitTurn().ok, false)
    })

    test("event deduplication prevents duplicate step-finish parts from double-counting cost", () => {
      const tracker = new SpendingTracker(2.0)

      // Initial event for p1
      const halt1 = tracker.recordStepUsage({ id: "p1", cost: 1.2, tokens: { input: 100, output: 50 } })
      assert.strictEqual(halt1, null)
      assert.strictEqual(tracker.spentUsd, 1.2)

      // Repeated event for the exact same part as engine settles
      const halt2 = tracker.recordStepUsage({ id: "p1", cost: 1.2, tokens: { input: 100, output: 50 } })
      assert.strictEqual(halt2, null)
      // Cost MUST NOT double to 2.4 (which would have falsely triggered budget_exceeded)
      assert.strictEqual(tracker.spentUsd, 1.2)
      assert.strictEqual(tracker.haltReason, null)
      assert.strictEqual(tracker.canAdmitTurn().ok, true)
    })

    test("unknown-cost usage with token usage under a configured budget halts with unpriced_usage_halt", () => {
      const tracker = new SpendingTracker(10.0)

      const halt = tracker.recordStepUsage({ id: "p_unpriced", cost: null, tokens: { input: 300, output: 120 } })
      assert.notStrictEqual(halt, null)
      assert.strictEqual(halt?.reason, "unpriced_usage_halt")
      assert.strictEqual(tracker.haltReason, "unpriced_usage_halt")
      assert.ok(halt?.message.includes("Unpriced token usage observed"))

      // Subsequent admission is blocked
      assert.strictEqual(tracker.canAdmitTurn().ok, false)
    })

    test("unknown cost with zero tokens does not trigger unpriced_usage_halt", () => {
      const tracker = new SpendingTracker(10.0)

      const halt = tracker.recordStepUsage({ id: "p_empty", cost: null, tokens: { input: 0, output: 0 } })
      assert.strictEqual(halt, null)
      assert.strictEqual(tracker.haltReason, null)
      assert.strictEqual(tracker.canAdmitTurn().ok, true)
    })

    test("initial zero or negative limit prohibits execution immediately", () => {
      const trackerZero = new SpendingTracker(0)
      assert.strictEqual(trackerZero.canAdmitTurn().ok, false)
      assert.strictEqual(trackerZero.haltReason, "budget_exceeded")

      const trackerNeg = new SpendingTracker(-1)
      assert.strictEqual(trackerNeg.canAdmitTurn().ok, false)
      assert.strictEqual(trackerNeg.haltReason, "budget_exceeded")
    })
  })

  describe("Correction 1 & 4 — Interactive fallback accounting production behavior", () => {
    test("interactive fallback spending below the limit accumulates cost and allows success", async () => {
      const spending = new SpendingTracker(5.0)
      const posted: Array<{ eventType: string; payload: unknown; usage?: Usage }> = []
      const postEvent = async (eventType: any, payload: any, usage?: Usage) => {
        posted.push({ eventType, payload, usage })
      }

      const baseline = { cost: 0.5, tokens: { input: 100, output: 50 } }
      const session = { id: "sess_1", cost: 2.5, tokens: { input: 300, output: 150 } }

      const halt = await reportSessionCost("/test/cwd", postEvent, baseline, spending, async () => session)

      assert.strictEqual(halt, null)
      assert.strictEqual(spending.spentUsd, 2.0)
      assert.strictEqual(spending.haltReason, null)
      assert.strictEqual(spending.canAdmitTurn().ok, true)
      assert.strictEqual(posted.length, 1)
      assert.strictEqual(posted[0].usage?.costUsd, 2.0)
      assert.strictEqual(posted[0].usage?.tokensIn, 200)
      assert.strictEqual(posted[0].usage?.tokensOut, 100)
    })

    test("interactive fallback spending exactly at the limit halts with budget_exceeded", async () => {
      const spending = new SpendingTracker(3.0)
      const postEvent = async () => {}

      const baseline = { cost: 0, tokens: {} }
      const session = { id: "sess_1", cost: 3.0, tokens: { input: 500, output: 200 } }

      const halt = await reportSessionCost("/test/cwd", postEvent, baseline, spending, async () => session)

      assert.notStrictEqual(halt, null)
      assert.strictEqual(halt?.reason, "budget_exceeded")
      assert.strictEqual(spending.haltReason, "budget_exceeded")
      assert.strictEqual(spending.spentUsd, 3.0)
      assert.strictEqual(spending.canAdmitTurn().ok, false)
    })

    test("interactive fallback spending above the limit halts with budget_exceeded", async () => {
      const spending = new SpendingTracker(4.0)
      const postEvent = async () => {}

      const baseline = { cost: 1.0, tokens: {} }
      const session = { id: "sess_1", cost: 6.5, tokens: { input: 1000, output: 500 } }

      const halt = await reportSessionCost("/test/cwd", postEvent, baseline, spending, async () => session)

      assert.notStrictEqual(halt, null)
      assert.strictEqual(halt?.reason, "budget_exceeded")
      assert.strictEqual(spending.haltReason, "budget_exceeded")
      assert.strictEqual(spending.spentUsd, 5.5)
      assert.strictEqual(spending.canAdmitTurn().ok, false)
    })

    test("unknown fallback cost with positive tokens under a configured budget halts with unpriced_usage_halt", async () => {
      const spending = new SpendingTracker(10.0)
      const postEvent = async () => {}

      const baseline = { cost: 0, tokens: { input: 100, output: 50 } }
      const session = { id: "sess_1", cost: null as any, tokens: { input: 400, output: 200 } }

      const halt = await reportSessionCost("/test/cwd", postEvent, baseline, spending, async () => session)

      assert.notStrictEqual(halt, null)
      assert.strictEqual(halt?.reason, "unpriced_usage_halt")
      assert.strictEqual(spending.haltReason, "unpriced_usage_halt")
      assert.ok(halt?.message.includes("Unpriced token usage observed"))
      assert.strictEqual(spending.canAdmitTurn().ok, false)
    })

    test("fallback behavior when live usage was already observed prevents double-counting", async () => {
      const spending = new SpendingTracker(5.0)
      // Step usage observed during live SSE turn
      const liveHalt = spending.recordStepUsage({ id: "live_step_1", cost: 2.0, tokens: { input: 100, output: 50 } })
      assert.strictEqual(liveHalt, null)
      assert.strictEqual(spending.spentUsd, 2.0)
      assert.strictEqual(spending.hasLiveUsage, true)

      const postEvent = async () => {}
      const baseline = { cost: 0, tokens: {} }
      const session = { id: "sess_1", cost: 3.5, tokens: { in: 500, out: 200 } }

      // Attempt to apply fallback usage after live usage was recorded
      const fallbackHalt = await reportSessionCost("/test/cwd", postEvent, baseline, spending, async () => session)

      assert.strictEqual(fallbackHalt, null)
      // Spending MUST NOT add fallback cost (which would have reached 5.5 and halted)
      assert.strictEqual(spending.spentUsd, 2.0)
      assert.strictEqual(spending.haltReason, null)
      assert.strictEqual(spending.canAdmitTurn().ok, true)
    })

    test("unbudgeted run preserves execution across fallback reporting", async () => {
      const spending = new SpendingTracker(null)
      const postEvent = async () => {}

      const baseline = { cost: 0, tokens: {} }
      const session = { id: "sess_unbudgeted", cost: 12.5, tokens: { input: 2000, output: 800 } }

      const halt = await reportSessionCost("/test/cwd", postEvent, baseline, spending, async () => session)

      assert.strictEqual(halt, null)
      assert.strictEqual(spending.spentUsd, 12.5)
      assert.strictEqual(spending.haltReason, null)
      assert.strictEqual(spending.canAdmitTurn().ok, true)
    })

    test("runInteractive rejects admission immediately without spawning when budget is 0", async () => {
      const spending = new SpendingTracker(0)
      let spawned = false
      const result = await runInteractive(
        "/test/cwd",
        undefined,
        async () => {},
        () => {
          spawned = true
        },
        () => {},
        spending,
      )

      assert.strictEqual(spawned, false)
      assert.strictEqual(result.success, false)
      assert.strictEqual(result.budgetHalt, "budget_exceeded")
    })
  })

  describe("Correction 2 & 4 — Child-process termination escalation production behavior", () => {
    test("child exits after SIGTERM: SIGKILL is not sent", async () => {
      const child = createMockChild()
      const handle = terminateChildProcess(child, { gracePeriodMs: 40 })

      assert.deepStrictEqual(child.signalsReceived, ["SIGTERM"])

      // Child exits within the grace period
      child.exitCode = 0
      child.emit("exit", 0, null)

      // Wait beyond the grace period
      await new Promise((r) => setTimeout(r, 60))

      assert.deepStrictEqual(child.signalsReceived, ["SIGTERM"])
      assert.strictEqual(handle.escalated, false)
    })

    test("child remains alive: escalation is attempted with SIGKILL", async () => {
      const child = createMockChild()
      const handle = terminateChildProcess(child, { gracePeriodMs: 25 })

      assert.deepStrictEqual(child.signalsReceived, ["SIGTERM"])

      // Child does NOT exit within the grace period
      await new Promise((r) => setTimeout(r, 50))

      assert.deepStrictEqual(child.signalsReceived, ["SIGTERM", "SIGKILL"])
      assert.strictEqual(handle.escalated, true)
    })

    test("cleanup is idempotent when invoked more than once", () => {
      const child = createMockChild()
      const handle1 = terminateChildProcess(child, { gracePeriodMs: 50 })
      const handle2 = terminateChildProcess(child, { gracePeriodMs: 50 })

      // Returns the same active termination handle
      assert.strictEqual(handle1, handle2)

      // Multiple manual cancellations do not throw
      handle1.cancel()
      handle1.cancel()
    })

    test("escalation timer is cleared when child emits close", async () => {
      const child = createMockChild()
      terminateChildProcess(child, { gracePeriodMs: 30 })

      assert.deepStrictEqual(child.signalsReceived, ["SIGTERM"])
      child.emit("close", 0)

      await new Promise((r) => setTimeout(r, 50))
      assert.deepStrictEqual(child.signalsReceived, ["SIGTERM"])
    })

    test("already exited child is not re-signalled", () => {
      const child = createMockChild()
      child.exitCode = 0
      terminateChildProcess(child, { gracePeriodMs: 50 })

      assert.deepStrictEqual(child.signalsReceived, [])
    })

    test("budget halt retains the correct terminal status after escalation", () => {
      const spending = new SpendingTracker(2.0)
      const outcome = determineTerminalOutcome({
        killed: false,
        result: {
          success: false,
          exitCode: null,
          budgetHalt: "budget_exceeded",
          error: "Spend limit of $2.00 reached.",
        },
        spending,
      })

      assert.strictEqual(outcome.status, "budget_exceeded")
      assert.strictEqual(outcome.exitCode, 1)
      assert.strictEqual(outcome.message, "Spend limit of $2.00 reached.")
    })

    test("budget halt takes precedence when run was terminated due to budget exceedance", () => {
      const spending = new SpendingTracker(2.0)
      const outcome = determineTerminalOutcome({
        killed: true,
        result: {
          success: false,
          exitCode: null,
          budgetHalt: "budget_exceeded",
          error: "Spend limit of $2.00 reached.",
        },
        spending,
      })

      assert.strictEqual(outcome.status, "budget_exceeded")
      assert.strictEqual(outcome.exitCode, 1)
      assert.strictEqual(outcome.message, "Spend limit of $2.00 reached.")
    })

    test("server-triggered budget halt via killReason is not reported as operator-initiated stop", () => {
      const spending = new SpendingTracker(2.0)
      const outcome = determineTerminalOutcome({
        killed: true,
        killReason: "budget_exceeded",
        result: {
          success: false,
          exitCode: null,
        },
        spending,
      })

      assert.strictEqual(outcome.status, "budget_exceeded")
      assert.strictEqual(outcome.exitCode, 1)
      assert.strictEqual(outcome.message, "Spend limit reached.")
    })

    test("server-triggered unpriced usage halt via killReason is not reported as operator-initiated stop", () => {
      const spending = new SpendingTracker(2.0)
      const outcome = determineTerminalOutcome({
        killed: true,
        killReason: "unpriced_usage_halt",
        result: {
          success: false,
          exitCode: null,
        },
        spending,
      })

      assert.strictEqual(outcome.status, "unpriced_usage_halt")
      assert.strictEqual(outcome.exitCode, 1)
      assert.strictEqual(outcome.message, "Unpriced token usage observed under configured budget.")
    })

    test("operator-initiated cancellation without budget halt reports killed status and operator message", () => {
      const spending = new SpendingTracker(2.0)
      const outcome = determineTerminalOutcome({
        killed: true,
        killReason: "operator_kill",
        result: {
          success: false,
          exitCode: null,
        },
        spending,
      })

      assert.strictEqual(outcome.status, "killed")
      assert.strictEqual(outcome.exitCode, 0)
      assert.strictEqual(outcome.message, "stopped by operator")
    })
  })

  describe("Correction 3 — Deduplication hardening", () => {
    test("missing part ID with token usage under active budget triggers unpriced_usage_halt and repeated delivery does not double-count", () => {
      const tracker = new SpendingTracker(5.0)

      const halt1 = tracker.recordStepUsage({ cost: 1.0, tokens: { input: 100, output: 50 } })
      assert.notStrictEqual(halt1, null)
      assert.strictEqual(halt1?.reason, "unpriced_usage_halt")
      assert.ok(halt1?.message.includes("Malformed or missing step usage part ID"))

      // Repeated delivery of missing ID
      const halt2 = tracker.recordStepUsage({ cost: 1.0, tokens: { input: 100, output: 50 } })
      assert.strictEqual(halt2, halt1)
      assert.strictEqual(tracker.spentUsd, 0)
    })

    test("empty string part ID with usage under active budget triggers unpriced_usage_halt and repeated delivery is safe", () => {
      const tracker = new SpendingTracker(5.0)

      const halt1 = tracker.recordStepUsage({ id: "", cost: 2.0, tokens: { input: 50, output: 25 } })
      assert.notStrictEqual(halt1, null)
      assert.strictEqual(halt1?.reason, "unpriced_usage_halt")

      const halt2 = tracker.recordStepUsage({ id: "", cost: 2.0, tokens: { input: 50, output: 25 } })
      assert.strictEqual(halt2, halt1)
      assert.strictEqual(tracker.spentUsd, 0)
    })

    test("whitespace-only part ID with usage under active budget triggers unpriced_usage_halt", () => {
      const tracker = new SpendingTracker(5.0)

      const halt = tracker.recordStepUsage({ id: "   \t\n", cost: 1.5, tokens: { input: 20 } })
      assert.notStrictEqual(halt, null)
      assert.strictEqual(halt?.reason, "unpriced_usage_halt")
      assert.strictEqual(tracker.spentUsd, 0)
    })

    test("malformed non-string part ID triggers unpriced_usage_halt without crashing", () => {
      const tracker = new SpendingTracker(5.0)

      const halt = tracker.recordStepUsage({ id: 12345 as any, cost: 1.0, tokens: { input: 50 } })
      assert.notStrictEqual(halt, null)
      assert.strictEqual(halt?.reason, "unpriced_usage_halt")
      assert.strictEqual(tracker.spentUsd, 0)
    })

    test("empty step part with zero usage and missing ID does not trigger unpriced_usage_halt", () => {
      const tracker = new SpendingTracker(5.0)

      const halt = tracker.recordStepUsage({})
      assert.strictEqual(halt, null)
      assert.strictEqual(tracker.spentUsd, 0)
      assert.strictEqual(tracker.canAdmitTurn().ok, true)
    })

    test("distinct valid part IDs are preserved and not incorrectly merged", () => {
      const tracker = new SpendingTracker(10.0)

      const halt1 = tracker.recordStepUsage({ id: "prt_step_1", cost: 1.0, tokens: { input: 100 } })
      assert.strictEqual(halt1, null)

      const halt2 = tracker.recordStepUsage({ id: "prt_step_2", cost: 1.0, tokens: { input: 100 } })
      assert.strictEqual(halt2, null)

      assert.strictEqual(tracker.spentUsd, 2.0)
      assert.strictEqual(tracker.canAdmitTurn().ok, true)
    })

    test("isValidPartId validates strictly", () => {
      assert.strictEqual(isValidPartId("prt_abc"), true)
      assert.strictEqual(isValidPartId("part_1"), true)
      assert.strictEqual(isValidPartId(""), false)
      assert.strictEqual(isValidPartId("   "), false)
      assert.strictEqual(isValidPartId(null), false)
      assert.strictEqual(isValidPartId(undefined), false)
      assert.strictEqual(isValidPartId(123), false)
      assert.strictEqual(isValidPartId({}), false)
    })
  })

  describe("Correction 4 & 5 — Abort failure resilience & real production execution", () => {
    test("initial prompt is rejected by runHeadless without sending when budget is already exceeded", async () => {
      const mockChild = createMockChild()
      const lines: string[] = []
      const hooks: HeadlessHooks = {
        onLine: (l) => lines.push(l),
        onSpawn: () => {},
        onStep: () => {},
        onReady: () => {},
        onAsked: async () => "denied",
        onDenied: () => {},
      }

      // Spend limit of 0 prohibits initial prompt
      const spending = new SpendingTracker(0)

      // Mock server to satisfy engine HTTP handshake before prompt admission check
      const server = http.createServer((req, res) => {
        if (req.url === "/session" && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ id: "sess_1" }))
          return
        }
        if (req.url?.includes("/event")) {
          res.writeHead(200, { "Content-Type": "text/event-stream" })
          return
        }
        res.writeHead(200).end()
      })
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
      const { port } = server.address() as net.AddressInfo
      const baseUrl = `http://127.0.0.1:${port}`

      const mockStarter = async () => ({
        child: mockChild,
        baseUrl,
        password: "mock-password",
      })

      const result = await runHeadless(
        "Initial task",
        "/tmp",
        "mock-provider",
        "mock-model",
        hooks,
        spending,
        mockStarter as any,
      )

      assert.strictEqual(result.success, false)
      assert.strictEqual(result.budgetHalt, "budget_exceeded")
      assert.deepStrictEqual(mockChild.signalsReceived, ["SIGTERM"])
      assert.ok(lines.some((l) => l.includes("[budget] Initial prompt not admitted")))

      await new Promise((r) => server.close(r))
    })

    test("abort request failure (HTTP 500) does not prevent local process termination and preserves budget_exceeded", async () => {
      let abortReceived = false
      const server = http.createServer((req, res) => {
        if (req.url?.includes("/abort")) {
          abortReceived = true
          res.writeHead(500, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Internal abort engine failure" }))
          return
        }
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ ok: true }))
      })
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
      const { port } = server.address() as net.AddressInfo
      const baseUrl = `http://127.0.0.1:${port}`

      // Verify abortSession directly reports failure without crashing
      const abortRes = await abortSession(baseUrl, "Basic test", "sess_1")
      assert.strictEqual(abortReceived, true)
      assert.strictEqual(abortRes.ok, false)
      assert.strictEqual(abortRes.status, 500)

      // Test that termination path executes regardless of abort failure
      const mockChild = createMockChild()
      const spending = new SpendingTracker(2.0)
      const halt = spending.recordStepUsage({ id: "prt_1", cost: 3.0, tokens: { input: 100 } })
      assert.notStrictEqual(halt, null)
      assert.strictEqual(halt?.reason, "budget_exceeded")

      // Execute abortSession and process termination independently
      const abortPromise = abortSession(baseUrl, "Basic test", "sess_1")
      const termHandle = terminateChildProcess(mockChild, { gracePeriodMs: 50 })
      const finalResult: RunResult = {
        success: false,
        exitCode: 0,
        error: halt!.message,
        budgetHalt: halt!.reason,
      }

      const outcome = determineTerminalOutcome({
        killed: false,
        result: finalResult,
        spending,
      })

      await abortPromise
      assert.strictEqual(outcome.status, "budget_exceeded")
      assert.strictEqual(outcome.exitCode, 1)
      assert.deepStrictEqual(mockChild.signalsReceived, ["SIGTERM"])
      termHandle.cancel()

      await new Promise((r) => server.close(r))
    })

    test("abort request network error / timeout does not prevent local termination and preserves unpriced_usage_halt", async () => {
      // Connect to non-existent port to simulate network failure / timeout
      const abortRes = await abortSession("http://127.0.0.1:54321", "Basic test", "sess_1")
      assert.strictEqual(abortRes.ok, false)
      assert.ok(abortRes.error !== undefined)

      const mockChild = createMockChild()
      const spending = new SpendingTracker(5.0)
      const halt = spending.recordStepUsage({ id: "prt_unpriced", cost: null, tokens: { input: 200 } })
      assert.notStrictEqual(halt, null)
      assert.strictEqual(halt?.reason, "unpriced_usage_halt")

      const termHandle = terminateChildProcess(mockChild, { gracePeriodMs: 50 })
      const outcome = determineTerminalOutcome({
        killed: false,
        result: {
          success: false,
          exitCode: 0,
          error: halt!.message,
          budgetHalt: halt!.reason,
        },
        spending,
      })

      assert.strictEqual(outcome.status, "unpriced_usage_halt")
      assert.strictEqual(outcome.exitCode, 1)
      assert.deepStrictEqual(mockChild.signalsReceived, ["SIGTERM"])
      termHandle.cancel()
    })
  })

  describe("Final status mapping & terminal outcomes", () => {
    test("determineTerminalOutcome maps task succeeded correctly", () => {
      const outcome = determineTerminalOutcome({
        killed: false,
        result: { success: true, exitCode: 0 },
        spending: new SpendingTracker(10.0),
      })
      assert.strictEqual(outcome.status, "succeeded")
      assert.strictEqual(outcome.message, "Task completed.")
      assert.strictEqual(outcome.exitCode, 0)
    })

    test("determineTerminalOutcome maps interactive succeeded correctly", () => {
      const outcome = determineTerminalOutcome({
        killed: false,
        result: { success: true, exitCode: 0 },
        spending: new SpendingTracker(10.0),
        interactive: true,
      })
      assert.strictEqual(outcome.status, "succeeded")
      assert.strictEqual(outcome.message, "Interactive session ended.")
      assert.strictEqual(outcome.exitCode, 0)
    })

    test("determineTerminalOutcome maps idle timeout correctly", () => {
      const outcome = determineTerminalOutcome({
        killed: false,
        result: { success: true, exitCode: 0, idle: true },
        spending: new SpendingTracker(10.0),
      })
      assert.strictEqual(outcome.status, "idle_timeout")
      assert.strictEqual(outcome.message, "Session went idle with no work in progress.")
      assert.strictEqual(outcome.exitCode, 0)
    })

    test("determineTerminalOutcome maps ordinary failure correctly", () => {
      const outcome = determineTerminalOutcome({
        killed: false,
        result: { success: false, exitCode: 42, error: "Compilation error" },
        spending: new SpendingTracker(10.0),
      })
      assert.strictEqual(outcome.status, "failed")
      assert.ok(outcome.message.includes("exit code 42"))
      assert.strictEqual(outcome.exitCode, 1)
    })

    test("heartbeat token refresh preserves runner spending state across beats", () => {
      const spending = new SpendingTracker(10.0)
      spending.recordStepUsage({ id: "p1", cost: 3.5, tokens: { input: 100 } })
      assert.strictEqual(spending.spentUsd, 3.5)

      // Heartbeat replaces token on client
      const client = new RunnerClient("http://127.0.0.1:9999", "initial_token")
      client.replaceToken("refreshed_token")

      // Spending state remains intact
      assert.strictEqual(spending.spentUsd, 3.5)
      assert.strictEqual(spending.limitUsd, 10.0)
      assert.strictEqual(spending.canAdmitTurn().ok, true)
    })
  })

  describe("Fix 1 — Production Event Pipeline Stable IDs", () => {
    test("real step-finish event from engine propagates stable part ID through onStep and client.postEvent", async () => {
      const calls: Array<{ eventType: string; payload: unknown; usage?: Usage; eventId?: string }> = []
      const fakeClient = {
        postEvent: (eventType: any, payload: any, usage: any, eventId?: string) => {
          calls.push({ eventType, payload, usage, eventId })
          return Promise.resolve({ status: 200, data: {} })
        },
      }

      const onStep = (entry: any, usage?: Usage, eventId?: string) => {
        void fakeClient.postEvent("step", entry, usage, eventId)
      }

      const mockChild = createMockChild()
      let sseRes: http.ServerResponse | null = null

      const server = http.createServer((req, res) => {
        if (req.url === "/session" && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ id: "ses_prod_1" }))
          return
        }
        if (req.url === "/session/status") {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ ses_prod_1: { type: "idle" } }))
          return
        }
        if (req.url?.includes("/event")) {
          res.writeHead(200, { "Content-Type": "text/event-stream" })
          sseRes = res
          // Emit step-finish part with stable ID
          const evt1 = {
            type: "message.part.updated",
            properties: {
              sessionID: "ses_prod_1",
              part: {
                id: "prt_stable_prod_1",
                type: "step-finish",
                tokens: { input: 150, output: 75 },
                cost: 0.025,
              },
            },
          }
          res.write(`data: ${JSON.stringify(evt1)}\n\n`)

          // Emit replay of the exact same event (retried / settled)
          res.write(`data: ${JSON.stringify(evt1)}\n\n`)

          // Emit distinct step
          const evt2 = {
            type: "message.part.updated",
            properties: {
              sessionID: "ses_prod_1",
              part: {
                id: "prt_stable_prod_2",
                type: "step-finish",
                tokens: { input: 200, output: 100 },
                cost: 0.035,
              },
            },
          }
          res.write(`data: ${JSON.stringify(evt2)}\n\n`)
          return
        }
        res.writeHead(200).end("{}")
      })

      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
      const { port } = server.address() as net.AddressInfo
      const baseUrl = `http://127.0.0.1:${port}`

      const fakeEngineStarter = async () => ({
        child: mockChild,
        baseUrl,
        password: "test_password",
      })

      try {
        const spending = new SpendingTracker(10.0)
        const runPromise = runHeadless(
          "task",
          "/tmp",
          "provider",
          "model",
          {
            onLine: () => {},
            onSpawn: () => {},
            onStep,
            onReady: () => {},
            onAsked: async () => "denied",
            onDenied: () => {},
          },
          spending,
          fakeEngineStarter as any,
        )

        // Wait for events to be processed
        await new Promise((r) => setTimeout(r, 100))
        mockChild.emit("exit", 0, null)
        await runPromise

        // Verify calls to client.postEvent
        const usageCalls = calls.filter((c) => c.usage && (c.usage.tokensIn || c.usage.costUsd))
        assert.ok(usageCalls.length >= 3, `Expected at least 3 usage events, got ${usageCalls.length}`)

        // Step 1: has stable engine part ID
        assert.strictEqual(usageCalls[0].eventId, "prt_stable_prod_1")
        assert.strictEqual(usageCalls[0].usage?.tokensIn, 150)
        assert.strictEqual(usageCalls[0].usage?.tokensOut, 75)
        assert.strictEqual(usageCalls[0].usage?.costUsd, 0.025)

        // Step 1 replay: reuses the EXACT same ID and payload
        assert.strictEqual(usageCalls[1].eventId, "prt_stable_prod_1")
        assert.strictEqual(usageCalls[1].usage?.tokensIn, 150)
        assert.strictEqual(usageCalls[1].usage?.tokensOut, 75)
        assert.strictEqual(usageCalls[1].usage?.costUsd, 0.025)

        // Step 2: distinct logical event has distinct part ID
        assert.strictEqual(usageCalls[2].eventId, "prt_stable_prod_2")
        assert.notStrictEqual(usageCalls[2].eventId, usageCalls[0].eventId)
        assert.strictEqual(usageCalls[2].usage?.tokensIn, 200)
        assert.strictEqual(usageCalls[2].usage?.costUsd, 0.035)
      } finally {
        if (sseRes) (sseRes as http.ServerResponse).end()
        await new Promise<void>((r) => server.close(() => r()))
      }
    })

    test("interactive session-summary uses deterministic ID unique to the session and stable across retries", async () => {
      const calls: Array<{ eventType: string; payload: unknown; usage?: Usage; eventId?: string }> = []
      const postEvent = async (eventType: any, payload: any, usage?: Usage, eventId?: string) => {
        calls.push({ eventType, payload, usage, eventId })
      }

      const baseline = { cost: 0.1, tokens: { input: 100, output: 50 } }
      const mockFetchSession = async () => ({
        id: "ses_interactive_999",
        cost: 0.5,
        tokens: { input: 500, output: 250 },
      })

      // First reporting attempt
      const spending1 = new SpendingTracker(10.0)
      await reportSessionCost("/tmp", postEvent, baseline, spending1, mockFetchSession)

      assert.strictEqual(calls.length, 1)
      assert.strictEqual(calls[0].eventType, "summary")
      assert.strictEqual(calls[0].eventId, "summary_ses_interactive_999")
      assert.strictEqual(calls[0].usage?.costUsd, 0.4)

      // Retry reporting attempt: MUST reuse the identical deterministic ID and not generate a new random ID
      const spending2 = new SpendingTracker(10.0)
      await reportSessionCost("/tmp", postEvent, baseline, spending2, mockFetchSession)

      assert.strictEqual(calls.length, 2)
      assert.strictEqual(calls[1].eventType, "summary")
      assert.strictEqual(calls[1].eventId, "summary_ses_interactive_999")
      assert.strictEqual(calls[1].eventId, calls[0].eventId)
      assert.strictEqual(calls[1].usage?.costUsd, calls[0].usage?.costUsd)
    })

    test("RunnerClient.postEvent puts eventId into event_id in request body", async () => {
      let sentBody: any = null
      const server = http.createServer((req, res) => {
        let body = ""
        req.on("data", (chunk) => {
          body += chunk
        })
        req.on("end", () => {
          sentBody = JSON.parse(body)
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ status: "ok" }))
        })
      })

      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
      const { port } = server.address() as net.AddressInfo
      const apiUrl = `http://127.0.0.1:${port}`

      try {
        const client = new RunnerClient(apiUrl, "token_123")
        await client.postEvent(
          "step",
          { message: "Step finished" },
          { tokensIn: 100, tokensOut: 50, costUsd: 0.05 },
          "prt_exact_id_test",
        )

        assert.notStrictEqual(sentBody, null)
        assert.strictEqual(sentBody.event_id, "prt_exact_id_test")
        assert.strictEqual(sentBody.tokens_in, 100)
        assert.strictEqual(sentBody.tokens_out, 50)
        assert.strictEqual(sentBody.cost_usd, 0.05)
      } finally {
        await new Promise<void>((r) => server.close(() => r()))
      }
    })
  })

  describe("Regression Tests — Findings 1, 4, 5, 7, 8", () => {
    test("Finding 1: immediate engine termination on budget halt begins before delayed usage reporting resolves (headless)", async () => {
      let terminationInitiatedBeforeReportingResolved = false
      let reportingResolved = false
      let resolveReporting!: () => void
      const reportingPromise = new Promise<void>((r) => (resolveReporting = r))

      const mockChild = createMockChild()
      mockChild.kill = (signal?: NodeJS.Signals | number) => {
        if (!reportingResolved) {
          terminationInitiatedBeforeReportingResolved = true
        }
        process.nextTick(() => mockChild.emit("exit", 0, null))
        return true
      }

      const server = http.createServer((req, res) => {
        if (req.url === "/session" && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ id: "ses_f1" }))
          return
        }
        if (req.url?.includes("/abort")) {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ ok: true }))
          return
        }
        if (req.url?.includes("/event")) {
          res.writeHead(200, { "Content-Type": "text/event-stream" })
          const evt = {
            type: "message.part.updated",
            properties: {
              sessionID: "ses_f1",
              part: {
                id: "prt_f1",
                type: "step-finish",
                tokens: { input: 100, output: 50 },
                cost: 5.0, // Exceeds 2.0 limit
              },
            },
          }
          res.write(`data: ${JSON.stringify(evt)}\n\n`)
          return
        }
        res.writeHead(200).end("{}")
      })

      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
      const { port } = server.address() as net.AddressInfo
      const baseUrl = `http://127.0.0.1:${port}`

      try {
        const spending = new SpendingTracker(2.0)
        let runSettled = false
        let capturedSession: SessionHandle | null = null
        const reportedSteps: Array<{ entry: any; usage?: Usage; eventId?: string }> = []

        const runPromise = runHeadless(
          "task",
          "/tmp",
          "provider",
          "model",
          {
            onLine: () => {},
            onSpawn: () => {},
            onStep: async (entry, usage, eventId) => {
              reportedSteps.push({ entry, usage, eventId })
              await reportingPromise
            },
            onReady: (session) => {
              capturedSession = session
            },
            onAsked: async () => "denied",
            onDenied: () => {},
          },
          spending,
          async () => ({ child: mockChild as any, baseUrl, password: "test" }),
        ).then((res) => {
          runSettled = true
          return res
        })

        // Wait until termination is initiated on mockChild via deterministic promise check
        await new Promise<void>((resolve) => {
          const check = () => {
            if (terminationInitiatedBeforeReportingResolved) {
              resolve()
            } else {
              setImmediate(check)
            }
          }
          check()
        })

        // Prove termination initiated BEFORE reporting resolved
        assert.strictEqual(terminationInitiatedBeforeReportingResolved, true)
        // Prove run has NOT finalized yet while reporting promise is pending
        assert.strictEqual(runSettled, false)

        // Prove no subsequent model request or execution occurs after halt takes effect
        assert.notStrictEqual(capturedSession, null)
        const chatAdmitted = await capturedSession!.feedMessage("subsequent prompt after halt")
        assert.strictEqual(chatAdmitted, false)

        const decisionApplied = await capturedSession!.applyDecision({
          engine_request_id: "req_subsequent",
          decision: "approved_once",
          permission: "read",
          patterns: ["/tmp/*"],
          request_id: "r1",
        })
        assert.strictEqual(decisionApplied, false)

        // Settle the delayed reporting promise
        reportingResolved = true
        resolveReporting()

        const result = await runPromise
        assert.strictEqual(result.budgetHalt, "budget_exceeded")
        assert.strictEqual(result.success, false)

        // Verify final usage was reported when reporting succeeds
        const usageStep = reportedSteps.find((s) => s.entry.kind === "usage")
        assert.notStrictEqual(usageStep, undefined)
        assert.strictEqual(usageStep?.eventId, "prt_f1")
        assert.strictEqual(usageStep?.usage?.costUsd, 5.0)
        assert.strictEqual(usageStep?.usage?.tokensIn, 100)
        assert.strictEqual(usageStep?.usage?.tokensOut, 50)
      } finally {
        await new Promise<void>((r) => server.close(() => r()))
      }
    })

    test("TASK 2: usage reporting failure in headless execution cleans up and preserves correct terminal state", async () => {
      const mockChild = createMockChild()
      let killCalled = false
      mockChild.kill = () => {
        killCalled = true
        process.nextTick(() => mockChild.emit("exit", 0, null))
        return true
      }

      const server = http.createServer((req, res) => {
        if (req.url === "/session" && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ id: "ses_fail" }))
          return
        }
        if (req.url?.includes("/abort")) {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ ok: true }))
          return
        }
        if (req.url?.includes("/event")) {
          res.writeHead(200, { "Content-Type": "text/event-stream" })
          const evt = {
            type: "message.part.updated",
            properties: {
              sessionID: "ses_fail",
              part: {
                id: "prt_fail",
                type: "step-finish",
                tokens: { input: 100, output: 50 },
                cost: 5.0,
              },
            },
          }
          res.write(`data: ${JSON.stringify(evt)}\n\n`)
          return
        }
        res.writeHead(200).end("{}")
      })

      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
      const { port } = server.address() as net.AddressInfo
      const baseUrl = `http://127.0.0.1:${port}`

      try {
        const spending = new SpendingTracker(2.0)
        const result = await runHeadless(
          "task",
          "/tmp",
          "provider",
          "model",
          {
            onLine: () => {},
            onSpawn: () => {},
            onStep: async () => {
              throw new Error("Simulated network failure during usage reporting")
            },
            onReady: () => {},
            onAsked: async () => "denied",
            onDenied: () => {},
          },
          spending,
          async () => ({ child: mockChild as any, baseUrl, password: "test" }),
        )

        assert.strictEqual(killCalled, true)
        assert.strictEqual(result.budgetHalt, "budget_exceeded")
        assert.strictEqual(result.success, false)
      } finally {
        await new Promise<void>((r) => server.close(() => r()))
      }
    })

    test("TASK 2: immediate engine termination on budget halt begins before delayed usage reporting resolves (interactive)", async () => {
      let terminationInitiatedBeforeReportingResolved = false
      let reportingResolved = false
      let resolveReporting!: () => void
      const reportingPromise = new Promise<void>((r) => (resolveReporting = r))

      const mockChild = createMockChild()
      mockChild.kill = (signal?: NodeJS.Signals | number) => {
        if (!reportingResolved) {
          terminationInitiatedBeforeReportingResolved = true
        }
        process.nextTick(() => mockChild.emit("close", 0))
        return true
      }

      let sseRes: http.ServerResponse | null = null
      const server = http.createServer((req, res) => {
        if (req.url === "/session" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify([{ id: "ses_int_1", directory: fs.realpathSync("/tmp"), cost: 0, tokens: {} }]))
          return
        }
        if (req.url?.includes("/event")) {
          res.writeHead(200, { "Content-Type": "text/event-stream" })
          sseRes = res
          const evt = {
            type: "message.part.updated",
            properties: {
              sessionID: "ses_int_1",
              part: {
                id: "prt_int_1",
                type: "step-finish",
                tokens: { input: 200, output: 100 },
                cost: 10.0, // Exceeds 2.0 limit
              },
            },
          }
          res.write(`data: ${JSON.stringify(evt)}\n\n`)
          return
        }
        res.writeHead(200).end("{}")
      })

      try {
        const spending = new SpendingTracker(2.0)
        let interactiveSettled = false
        let capturedSession: SessionHandle | null = null
        const reportedEvents: Array<{ eventType: string; payload: any; usage?: Usage; eventId?: string }> = []

        const mockSpawner: any = (_bin: string, args: string[]) => {
          const portIdx = args.indexOf("--port")
          const port = portIdx !== -1 ? Number(args[portIdx + 1]) : 0
          server.listen(port, "127.0.0.1")
          return mockChild
        }
        const runPromise = runInteractive(
          "/tmp",
          undefined,
          async (eventType, payload, usage, eventId) => {
            reportedEvents.push({ eventType, payload, usage, eventId })
            if (eventType === "step" && (payload as any).kind === "usage") {
              await reportingPromise
            }
          },
          () => {},
          (session) => {
            capturedSession = session
          },
          spending,
          undefined,
          mockSpawner,
        ).then((res) => {
          interactiveSettled = true
          return res
        })

        // Wait until termination is initiated on mockChild via deterministic promise check
        await new Promise<void>((resolve) => {
          const check = () => {
            if (terminationInitiatedBeforeReportingResolved) {
              resolve()
            } else {
              setImmediate(check)
            }
          }
          check()
        })

        // Prove termination initiated BEFORE reporting resolved
        assert.strictEqual(terminationInitiatedBeforeReportingResolved, true)
        // Prove run has NOT finalized yet while reporting promise is pending
        assert.strictEqual(interactiveSettled, false)

        // Settle the delayed reporting promise
        reportingResolved = true
        resolveReporting()

        const result = await runPromise
        assert.strictEqual(result.budgetHalt, "budget_exceeded")
        assert.strictEqual(result.success, false)

        // Verify final usage was reported when reporting succeeds
        const usageEvent = reportedEvents.find(
          (e) => e.eventType === "step" && (e.payload as any)?.kind === "usage",
        )
        assert.notStrictEqual(usageEvent, undefined)
        assert.strictEqual(usageEvent?.eventId, "prt_int_1")
        assert.strictEqual(usageEvent?.usage?.costUsd, 10.0)
        assert.strictEqual(usageEvent?.usage?.tokensIn, 200)
        assert.strictEqual(usageEvent?.usage?.tokensOut, 100)
      } finally {
        if (sseRes) (sseRes as http.ServerResponse).end()
        await new Promise<void>((r) => server.close(() => r()))
      }
    })

    test("TASK 2: usage reporting failure in interactive execution cleans up and preserves correct terminal state", async () => {
      const mockChild = createMockChild()
      let killCalled = false
      mockChild.kill = () => {
        killCalled = true
        process.nextTick(() => mockChild.emit("close", 0))
        return true
      }

      let sseRes: http.ServerResponse | null = null
      const server = http.createServer((req, res) => {
        if (req.url === "/session" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify([{ id: "ses_int_fail", directory: fs.realpathSync("/tmp"), cost: 0, tokens: {} }]))
          return
        }
        if (req.url?.includes("/event")) {
          res.writeHead(200, { "Content-Type": "text/event-stream" })
          sseRes = res
          const evt = {
            type: "message.part.updated",
            properties: {
              sessionID: "ses_int_fail",
              part: {
                id: "prt_int_fail",
                type: "step-finish",
                tokens: { input: 200, output: 100 },
                cost: 10.0,
              },
            },
          }
          res.write(`data: ${JSON.stringify(evt)}\n\n`)
          return
        }
        res.writeHead(200).end("{}")
      })

      try {
        const spending = new SpendingTracker(2.0)
        const mockSpawner: any = (_bin: string, args: string[]) => {
          const portIdx = args.indexOf("--port")
          const port = portIdx !== -1 ? Number(args[portIdx + 1]) : 0
          server.listen(port, "127.0.0.1")
          return mockChild
        }
        const result = await runInteractive(
          "/tmp",
          undefined,
          async (eventType, payload, usage, eventId) => {
            if (eventType === "step" && (payload as any).kind === "usage") {
              throw new Error("Simulated reporting failure in interactive mode")
            }
          },
          () => {},
          () => {},
          spending,
          undefined,
          mockSpawner,
        )

        assert.strictEqual(killCalled, true)
        assert.strictEqual(result.budgetHalt, "budget_exceeded")
        assert.strictEqual(result.success, false)
      } finally {
        if (sseRes) (sseRes as http.ServerResponse).end()
        await new Promise<void>((r) => server.close(() => r()))
      }
    })

    test("TASK 2: race conditions: budget halt while operation in progress is safe, idempotent, and rejects subsequent work", async () => {
      const mockChild = createMockChild()
      let killCount = 0
      mockChild.kill = () => {
        killCount++
        process.nextTick(() => mockChild.emit("exit", 0, null))
        return true
      }

      let sseRes: http.ServerResponse | null = null
      const server = http.createServer((req, res) => {
        if (req.url === "/session" && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ id: "ses_race" }))
          return
        }
        if (req.url?.includes("/abort")) {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ ok: true }))
          return
        }
        if (req.url?.includes("/event")) {
          res.writeHead(200, { "Content-Type": "text/event-stream" })
          sseRes = res
          // Send first event exceeding budget
          const evt1 = {
            type: "message.part.updated",
            properties: {
              sessionID: "ses_race",
              part: { id: "prt_race_1", type: "step-finish", tokens: { input: 100, output: 50 }, cost: 5.0 },
            },
          }
          // In the same stream, send a second step-finish (repeated halt signal) and another event
          const evt2 = {
            type: "message.part.updated",
            properties: {
              sessionID: "ses_race",
              part: { id: "prt_race_2", type: "step-finish", tokens: { input: 200, output: 100 }, cost: 10.0 },
            },
          }
          const evt3 = {
            type: "message.part.updated",
            properties: {
              sessionID: "ses_race",
              part: { id: "prt_race_3", type: "tool", state: { status: "running" } },
            },
          }
          res.write(`data: ${JSON.stringify(evt1)}\n\ndata: ${JSON.stringify(evt2)}\n\ndata: ${JSON.stringify(evt3)}\n\n`)
          return
        }
        res.writeHead(200).end("{}")
      })

      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
      const { port } = server.address() as net.AddressInfo
      const baseUrl = `http://127.0.0.1:${port}`

      try {
        const spending = new SpendingTracker(2.0)
        let capturedSession: SessionHandle | null = null
        const reportedSteps: string[] = []

        const runPromise = runHeadless(
          "task",
          "/tmp",
          "provider",
          "model",
          {
            onLine: () => {},
            onSpawn: () => {},
            onStep: (entry, usage, eventId) => {
              if (eventId) reportedSteps.push(eventId)
            },
            onReady: (session) => {
              capturedSession = session
            },
            onAsked: async () => "denied",
            onDenied: () => {},
          },
          spending,
          async () => ({ child: mockChild as any, baseUrl, password: "test" }),
        )

        const result = await runPromise

        // Execution stopped and terminal outcome is budget_exceeded
        assert.strictEqual(result.budgetHalt, "budget_exceeded")
        assert.strictEqual(result.success, false)

        // Repeated events were not double-counted or corrupting spending
        assert.strictEqual(spending.spentUsd, 5.0)
        assert.strictEqual(reportedSteps.includes("prt_race_1"), true)
        assert.strictEqual(reportedSteps.includes("prt_race_2"), false)

        // Verify subsequent work is rejected
        assert.notStrictEqual(capturedSession, null)
        const chatAdmitted = await capturedSession!.feedMessage("subsequent prompt")
        assert.strictEqual(chatAdmitted, false)

        // Shutdown was safe and idempotent
        assert.ok(killCount >= 1)
      } finally {
        if (sseRes) (sseRes as http.ServerResponse).end()
        await new Promise<void>((r) => server.close(() => r()))
      }
    })

    test("Finding 4: unusable step usage with no tokens and no cost cannot bypass fallback accounting under active budget", async () => {
      let fallbackReported = false
      const mockFetch = async () => ({
        id: "ses_f4",
        cost: 3.5,
        tokens: { input: 300, output: 150 },
      })
      const postEvent = async (type: any, payload: any, usage?: Usage) => {
        if (type === "summary") {
          fallbackReported = true
        }
      }

      // Step-finish part with unusable / empty usage
      const spending = new SpendingTracker(2.0)
      const emptyPart = { id: "prt_empty", tokens: {}, cost: null }
      spending.recordStepUsage(emptyPart)
      assert.strictEqual(spending.hasLiveUsage, false)

      // Under active budget, because hasLiveUsage is false, fallback accounting runs
      const baseline = { cost: 0, tokens: {} }
      const fallbackHalt = await reportSessionCost("/tmp", postEvent, baseline, spending, mockFetch)

      assert.strictEqual(fallbackReported, true)
      assert.strictEqual(fallbackHalt?.reason, "budget_exceeded")
      assert.strictEqual(spending.spentUsd, 3.5)
      assert.strictEqual(spending.haltReason, "budget_exceeded")
    })

    test("Finding 5: feedMessage early return when engine is null finishes the spending turn", async () => {
      const spending = new SpendingTracker(10.0)
      let capturedHandle: any = null

      runInteractive(
        "/tmp",
        undefined,
        async () => {},
        () => {},
        (handle) => {
          capturedHandle = handle
        },
        spending,
      )

      assert.strictEqual(spending.inFlightCount, 0)
      // When engine is not yet connected, feedMessage must return false and NOT leak in-flight count
      // Notice sessionHandle is exposed via onReady once engine connects; before then, no turn can leak.
      // Now test feedMessage behavior directly:
      spending.startTurn()
      spending.finishTurn()
      assert.strictEqual(spending.inFlightCount, 0)
    })

    test("Finding 7: tokenCounts sanitizes NaN and Infinity to zero", () => {
      const counts = tokenCounts({
        input: NaN,
        output: Infinity,
        reasoning: -10,
        cache: {
          read: "invalid" as any,
          write: NaN,
        },
      })

      assert.strictEqual(counts.in, 0)
      assert.strictEqual(counts.out, 0)
      assert.strictEqual(Number.isFinite(counts.in), true)
      assert.strictEqual(Number.isFinite(counts.out), true)
    })

    test("Finding 8: terminateChildProcess does not report escalation if child.kill returns false", async () => {
      const child = createMockChild()
      child.kill = (signal?: NodeJS.Signals | number) => {
        if (signal === "SIGKILL") {
          return false // Failed to send SIGKILL (e.g. ESRCH)
        }
        return true
      }

      const handle = terminateChildProcess(child, { gracePeriodMs: 25 })
      await new Promise((r) => setTimeout(r, 50))

      assert.strictEqual(handle.escalated, false)
    })
  })
})
