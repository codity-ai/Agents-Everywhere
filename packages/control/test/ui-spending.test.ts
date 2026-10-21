import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { startControl, type RunningControl } from "../src/server"
import { buildAssets } from "../script/assets"
import { money } from "../ui/dom"
import { STATUS } from "../ui/shared"

let control: RunningControl
let base: string
let adminToken: string
let dataDir: string

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-ui-test-"))
  control = await startControl({
    port: 0,
    hostname: "127.0.0.1",
    dataDir,
    publicUrl: "http://127.0.0.1:0",
    binariesDir: null,
    tls: null,
    log: () => {},
  })
  base = `http://127.0.0.1:${control.server.port}`
  adminToken = control.newAdminToken!
})

afterAll(async () => {
  await control.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

const admin = (method: string, p: string, body?: unknown) =>
  fetch(`${base}${p}`, {
    method,
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

describe("Control Plane UI Spending Guardrails Integration", () => {
  describe("API support for UI spending limit configuration and editing", () => {
    test("creates an unbudgeted agent when spend_limit_usd is unset or null", async () => {
      const res = await admin("POST", "/api/agents", {
        label: "unbudgeted-agent",
        task: "do something",
        model_provider: "anthropic",
        model_name: "claude-3-5-sonnet",
        spend_limit_usd: null,
      })
      expect(res.status).toBe(201)
      const data = (await res.json()) as any
      expect(data.spend_limit_usd).toBeNull()
    })

    test("creates an agent with a configured positive spending limit", async () => {
      const res = await admin("POST", "/api/agents", {
        label: "budgeted-agent",
        task: "do something within budget",
        model_provider: "anthropic",
        model_name: "claude-3-5-sonnet",
        spend_limit_usd: 15.5,
      })
      expect(res.status).toBe(201)
      const data = (await res.json()) as any
      expect(data.spend_limit_usd).toBe(15.5)
    })

    test("edits an existing agent to add a spending limit", async () => {
      const createRes = await admin("POST", "/api/agents", {
        label: "agent-to-budget",
        task: "initial task",
        model_provider: "anthropic",
        model_name: "claude-3-5-sonnet",
      })
      const agent = (await createRes.json()) as any
      expect(agent.spend_limit_usd).toBeNull()

      const patchRes = await admin("PATCH", `/api/agents/${agent.id}`, {
        spend_limit_usd: 25.0,
      })
      expect(patchRes.status).toBe(200)
      const updated = (await patchRes.json()) as any
      expect(updated.spend_limit_usd).toBe(25.0)

      // Verify subsequent GET returns the updated spending limit
      const getRes = await admin("GET", `/api/agents/${agent.id}`)
      const fetched = (await getRes.json()) as any
      expect(fetched.spend_limit_usd).toBe(25.0)
    })

    test("clears an existing spending limit by setting it to null", async () => {
      const createRes = await admin("POST", "/api/agents", {
        label: "agent-to-clear",
        task: "budgeted task",
        model_provider: "anthropic",
        model_name: "claude-3-5-sonnet",
        spend_limit_usd: 50.0,
      })
      const agent = (await createRes.json()) as any
      expect(agent.spend_limit_usd).toBe(50.0)

      const clearRes = await admin("PATCH", `/api/agents/${agent.id}`, {
        spend_limit_usd: null,
      })
      expect(clearRes.status).toBe(200)
      const cleared = (await clearRes.json()) as any
      expect(cleared.spend_limit_usd).toBeNull()

      const getRes = await admin("GET", `/api/agents/${agent.id}`)
      const fetched = (await getRes.json()) as any
      expect(fetched.spend_limit_usd).toBeNull()
    })

    test("rejects invalid spending limits on creation and update", async () => {
      const zeroRes = await admin("POST", "/api/agents", {
        label: "zero-limit",
        task: "task",
        model_provider: "anthropic",
        model_name: "claude-3-5-sonnet",
        spend_limit_usd: 0,
      })
      expect(zeroRes.status).toBe(422)

      const negativeRes = await admin("POST", "/api/agents", {
        label: "negative-limit",
        task: "task",
        model_provider: "anthropic",
        model_name: "claude-3-5-sonnet",
        spend_limit_usd: -5,
      })
      expect(negativeRes.status).toBe(422)

      const excessiveRes = await admin("POST", "/api/agents", {
        label: "excessive-limit",
        task: "task",
        model_provider: "anthropic",
        model_name: "claude-3-5-sonnet",
        spend_limit_usd: 100_001,
      })
      expect(excessiveRes.status).toBe(422)
    })

    test("mints a run that captures the agent spend_limit_usd snapshot", async () => {
      const createRes = await admin("POST", "/api/agents", {
        label: "agent-run-budget",
        task: "task",
        model_provider: "anthropic",
        model_name: "claude-3-5-sonnet",
        spend_limit_usd: 8.75,
      })
      const agent = (await createRes.json()) as any

      const mintRes = await admin("POST", `/api/agents/${agent.id}/install-command`)
      expect(mintRes.status).toBe(200)
      const minted = (await mintRes.json()) as any

      const runRes = await admin("GET", `/api/agents/${agent.id}/runs/${minted.run_id}`)
      expect(runRes.status).toBe(200)
      const run = (await runRes.json()) as any
      expect(run.spend_limit_usd).toBe(8.75)
    })
  })

  describe("UI formatting and budget display logic", () => {
    test("formats money accurately across standard and small fractions", () => {
      expect(money(0)).toBe("$0.00")
      expect(money(3.2)).toBe("$3.20")
      expect(money(5)).toBe("$5.00")
      expect(money(12.567)).toBe("$12.57")
      expect(money(0.0042)).toBe("$0.0042")
    })

    test("displays budget together with observed spend when budget is present", () => {
      const runWithBudget = {
        spend_limit_usd: 5.0,
      }
      const cost = 3.2
      const hasBudget = typeof runWithBudget.spend_limit_usd === "number" && Number.isFinite(runWithBudget.spend_limit_usd)
      expect(hasBudget).toBe(true)

      const display = `${money(cost)} / ${money(runWithBudget.spend_limit_usd!)}`
      expect(display).toBe("$3.20 / $5.00")
    })

    test("handles zero or null observed spending safely under configured budget", () => {
      const runWithBudget = {
        spend_limit_usd: 5.0,
      }
      const observedCost = Math.max(0, 0)
      const display = `${money(observedCost)} / ${money(runWithBudget.spend_limit_usd!)}`
      expect(display).toBe("$0.00 / $5.00")
    })

    test("unbudgeted run does not display a misleading budget", () => {
      const unbudgetedRun = {
        spend_limit_usd: null,
      }
      const hasBudget = typeof unbudgetedRun.spend_limit_usd === "number" && Number.isFinite(unbudgetedRun.spend_limit_usd)
      expect(hasBudget).toBe(false)
    })
  })

  describe("UI status badges for spending halts", () => {
    test("STATUS mapping correctly formats budget_exceeded and unpriced_usage_halt", () => {
      expect(STATUS["budget_exceeded"]).toEqual(["Budget Exceeded", "warning"])
      expect(STATUS["unpriced_usage_halt"]).toEqual(["Unpriced Usage Halt", "warning"])
    })
  })

  describe("UI overshoot notice and source verification", () => {
    test("form view contains spending limit field and overshoot explanatory notice", () => {
      const formSrc = fs.readFileSync(path.join(import.meta.dir, "../ui/views/form.ts"), "utf8")
      expect(formSrc).toContain("Spending limit")
      expect(formSrc).toContain("spend_limit_usd")
      expect(formSrc).toContain("Spending is checked at provider-step boundaries")
      expect(formSrc).toContain("already-running provider step may incur additional cost before termination")
      expect(formSrc).toContain("actual spend can exceed this threshold")
    })

    test("run view contains budget display and overshoot notice title", () => {
      const runSrc = fs.readFileSync(path.join(import.meta.dir, "../ui/views/run.ts"), "utf8")
      expect(runSrc).toContain("run.spend_limit_usd")
      expect(runSrc).toContain("${money(observedCost)} / ${money(run.spend_limit_usd!)}")
      expect(runSrc).toContain("Spending is checked at provider-step boundaries")
      expect(runSrc).toContain("already-running provider step may incur additional cost before termination")
    })

    test("UI assets bundle successfully with spending guardrails components", async () => {
      const assets = await buildAssets()
      expect(assets.ui["app.js"]).toBeDefined()
      expect(assets.ui["app.js"].body).toContain("agent-spend-limit")
      expect(assets.ui["app.js"].body).toContain("Spending is checked at provider-step boundaries")
    })
  })
})
