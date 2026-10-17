import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "fs"
import os from "os"
import path from "path"
import { resolveOptions } from "../src/cli"
import { sweep } from "../src/reaper"
import { startControl, type RunningControl } from "../src/server"
import { OpenSourceAdapter } from "./conformance/adapter"
import { CHECKS } from "./conformance/suite"

let control: RunningControl
let base: string
let adminToken: string
let dataDir: string
let binariesDir: string
const FAKE_BINARY = "#!/bin/sh\necho fake engine\n"

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-test-"))
  binariesDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-bin-"))
  fs.mkdirSync(path.join(binariesDir, "linux-x64"))
  fs.writeFileSync(path.join(binariesDir, "linux-x64", "agents-everywhere"), FAKE_BINARY)
  control = await startControl({
    port: 0,
    hostname: "127.0.0.1",
    dataDir,
    publicUrl: "http://127.0.0.1:0",
    binariesDir,
    tls: null,
    log: () => {},
  })
  base = `http://127.0.0.1:${control.server.port}`
  adminToken = control.newAdminToken!
})

afterAll(async () => {
  await control.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(binariesDir, { recursive: true, force: true })
})

const admin = (method: string, p: string, body?: unknown) =>
  fetch(`${base}${p}`, {
    method,
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

describe("runner protocol conformance", () => {
  for (const check of CHECKS) {
    test(check.name, () => check.run(new OpenSourceAdapter(base, adminToken)))
  }
})

describe("admin sign-in", () => {
  test("a wrong token is refused and a right one opens a session", async () => {
    const wrong = await fetch(`${base}/api/session`, {
      method: "POST",
      body: JSON.stringify({ token: "aect_wrong" }),
      headers: { "Content-Type": "application/json" },
    })
    expect(wrong.status).toBe(401)
    const right = await fetch(`${base}/api/session`, {
      method: "POST",
      body: JSON.stringify({ token: adminToken }),
      headers: { "Content-Type": "application/json" },
    })
    expect(right.status).toBe(200)
    const cookie = right.headers.get("set-cookie")!
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("SameSite=Strict")
  })

  test("a session cannot change anything without its CSRF token", async () => {
    const login = await fetch(`${base}/api/session`, {
      method: "POST",
      body: JSON.stringify({ token: adminToken }),
      headers: { "Content-Type": "application/json" },
    })
    const cookie = login.headers.get("set-cookie")!.split(";")[0]
    const { csrf_token } = (await login.json()) as { csrf_token: string }
    const body = JSON.stringify({ label: "csrf", task: "t", model_provider: "anthropic", model_name: "m" })

    const read = await fetch(`${base}/api/agents`, { headers: { Cookie: cookie } })
    expect(read.status).toBe(200)
    const forged = await fetch(`${base}/api/agents`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body,
    })
    expect(forged.status).toBe(403)
    const crossOrigin = await fetch(`${base}/api/agents`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf_token,
        Origin: "https://evil.example",
      },
      body,
    })
    expect(crossOrigin.status).toBe(403)
    const allowed = await fetch(`${base}/api/agents`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf_token },
      body,
    })
    expect(allowed.status).toBe(201)
  })

  test("the admin API refuses a request with no credentials", async () => {
    expect((await fetch(`${base}/api/agents`)).status).toBe(401)
  })

  test("sign-in attempts are rate limited", async () => {
    let last = 0
    for (let i = 0; i < 8; i++) {
      last = (
        await fetch(`${base}/api/session`, {
          method: "POST",
          body: JSON.stringify({ token: "aect_guess" }),
          headers: { "Content-Type": "application/json" },
        })
      ).status
    }
    expect(last).toBe(429)
  })
})

describe("what the server exposes", () => {
  test("every response carries the security headers, and the page a strict CSP", async () => {
    const page = await fetch(`${base}/`)
    expect(page.headers.get("x-content-type-options")).toBe("nosniff")
    expect(page.headers.get("x-frame-options")).toBe("DENY")
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'")
    expect(page.headers.get("content-security-policy")).not.toContain("unsafe-inline")
    const api = await fetch(`${base}/api/agents`)
    expect(api.headers.get("x-content-type-options")).toBe("nosniff")
  })

  test("an agent's LLM key is sealed at rest and never returned", async () => {
    const res = await admin("POST", "/api/agents", {
      label: "keyed",
      task: "t",
      model_provider: "anthropic",
      model_name: "m",
      llm_api_key: "sk-test-PLAINTEXT-MARKER",
    })
    const created = (await res.json()) as any
    expect(created.has_llm_api_key).toBe(true)
    expect(JSON.stringify(created)).not.toContain("PLAINTEXT-MARKER")
    const db = new Database(path.join(dataDir, "control.db"), { readonly: true })
    const row = db
      .query<{ llm_api_key_sealed: string }, [string]>("SELECT llm_api_key_sealed FROM agents WHERE id = ?")
      .get(created.id)!
    db.close()
    expect(row.llm_api_key_sealed).not.toContain("PLAINTEXT")
  })

  test("the install assets are served, and the runner is the dependency-free bundle", async () => {
    const install = await fetch(`${base}/agent/install.sh`)
    expect(install.status).toBe(200)
    expect(await install.text()).toContain("--api-url")
    const runner = await (await fetch(`${base}/agent/harness.js`)).text()
    expect(runner.startsWith("#!/usr/bin/env node")).toBe(true)
  })

  test("an engine binary is served with a checksum that matches it", async () => {
    const bin = await fetch(`${base}/agent/bin/linux-x64/agents-everywhere`)
    expect(bin.status).toBe(200)
    const bytes = Buffer.from(await bin.arrayBuffer())
    const sum = (await (await fetch(`${base}/agent/bin/linux-x64/agents-everywhere.sha256`)).text()).split(/\s+/)[0]
    expect(sum).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"))
    // Reaches the route as a platform of ".."; only named platforms are served.
    expect((await fetch(`${base}/agent/bin/%2E%2E/agents-everywhere`)).status).toBe(404)
    expect((await fetch(`${base}/agent/bin/linux-x64/secret.key`)).status).toBe(404)
    expect((await fetch(`${base}/agent/bin/windows-x64/agents-everywhere`)).status).toBe(404)
  })

  test("an install command carries a token and names this server", async () => {
    const created = (await (
      await admin("POST", "/api/agents", { label: "cmd", task: "t", model_provider: "anthropic", model_name: "m" })
    ).json()) as any
    const minted = (await (await admin("POST", `/api/agents/${created.id}/install-command`)).json()) as any
    expect(minted.command).toContain("/agent/install.sh | bash -s -- --token=")
  })
})

describe("stopping", () => {
  test("revoking stops live runs, removes unused commands and refuses new ones", async () => {
    const created = (await (
      await admin("POST", "/api/agents", { label: "revoke", task: "t", model_provider: "anthropic", model_name: "m" })
    ).json()) as any
    const unused = (await (await admin("POST", `/api/agents/${created.id}/install-command`)).json()) as any
    const revoked = (await (await admin("POST", `/api/agents/${created.id}/revoke`)).json()) as any
    expect(revoked.status).toBe("revoked")
    const token = String(unused.command).match(/--token=(\S+)/)![1]
    const hs = await fetch(`${base}/agents/runtime/handshake`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: "{}",
    })
    expect(hs.status).toBe(409)
    expect((await admin("POST", `/api/agents/${created.id}/install-command`)).status).toBe(409)
  })

  test("the sweep ends runs that stopped reporting and removes stale install commands", async () => {
    const created = (await (
      await admin("POST", "/api/agents", { label: "sweep", task: "t", model_provider: "anthropic", model_name: "m" })
    ).json()) as any
    await admin("POST", `/api/agents/${created.id}/install-command`)
    const future = Date.now() + 60 * 60_000
    const result = sweep(control.store, future)
    expect(result.unclaimed).toBeGreaterThan(0)
    expect(result.lost).toBeGreaterThan(0)
  })
})

describe("listening safely", () => {
  test("refuses to listen beyond this machine without TLS unless told it is behind a proxy", () => {
    expect(() => resolveOptions({ hostname: "0.0.0.0", publicUrl: "https://x.example" }, () => {})).toThrow(
      /without TLS/,
    )
    expect(
      resolveOptions({ hostname: "0.0.0.0", publicUrl: "https://x.example", insecure: true }, () => {}).publicUrl,
    ).toBe("https://x.example")
    expect(() => resolveOptions({ hostname: "0.0.0.0", insecure: true }, () => {})).toThrow(/--public-url/)
  })
})

describe("paginated run history and direct lookup", () => {
  test("direct lookup opens oldest of at least 51 stored runs and accesses its transcript", async () => {
    const res = await admin("POST", "/api/agents", {
      label: "agent-51",
      task: "task",
      model_provider: "anthropic",
      model_name: "claude",
    })
    const agent = (await res.json()) as any
    const db = new Database(path.join(dataDir, "control.db"))
    try {
      // Insert 55 runs with decreasing timestamps (run 0 is newest, run 54 is oldest)
      const baseTime = Date.parse("2026-05-01T12:00:00.000Z")
      const runIds: string[] = []
      for (let i = 0; i < 55; i++) {
        const runId = `run-${i.toString().padStart(3, "0")}`
        runIds.push(runId)
        const createdAt = new Date(baseTime - i * 1000).toISOString()
        db.query(
          "INSERT INTO runs (id, agent_id, status, hostname, created_at) VALUES (?, ?, 'succeeded', 'worker-1', ?)",
        ).run(runId, agent.id, createdAt)
      }

      const oldestRunId = runIds[54] // 55th run
      control.store.addEvent(oldestRunId, "step", { kind: "reply", message: "Oldest run transcript message" })

      // 1. Agent detail response returns only the latest 50 runs (existing client contract)
      const detailRes = await admin("GET", `/api/agents/${agent.id}`)
      expect(detailRes.status).toBe(200)
      const detail = (await detailRes.json()) as any
      expect(detail.runs.length).toBe(50)
      expect(detail.runs.some((r: any) => r.id === oldestRunId)).toBe(false)

      // 2. Direct lookup for the oldest run returns 200 and the run data
      const directRes = await admin("GET", `/api/agents/${agent.id}/runs/${oldestRunId}`)
      expect(directRes.status).toBe(200)
      const directRun = (await directRes.json()) as any
      expect(directRun.id).toBe(oldestRunId)
      expect(directRun.status).toBe("succeeded")

      // 3. Transcript events for the oldest run are accessible
      const eventsRes = await admin("GET", `/api/agents/${agent.id}/runs/${oldestRunId}/events`)
      expect(eventsRes.status).toBe(200)
      const events = (await eventsRes.json()) as any
      expect(events.length).toBeGreaterThan(0)
      expect(events[0].payload.message).toBe("Oldest run transcript message")
    } finally {
      db.close()
    }
  })

  test("browsing history in bounded pages with stable ordering and cursor pagination", async () => {
    const res = await admin("POST", "/api/agents", {
      label: "agent-pages",
      task: "task",
      model_provider: "anthropic",
      model_name: "claude",
    })
    const agent = (await res.json()) as any
    const db = new Database(path.join(dataDir, "control.db"))
    try {
      const baseTime = Date.parse("2026-06-01T12:00:00.000Z")
      const allRunIds: string[] = []
      for (let i = 0; i < 55; i++) {
        const runId = `run-page-${i.toString().padStart(3, "0")}`
        allRunIds.push(runId)
        const createdAt = new Date(baseTime - i * 1000).toISOString()
        db.query(
          "INSERT INTO runs (id, agent_id, status, hostname, created_at) VALUES (?, ?, 'succeeded', 'worker-1', ?)",
        ).run(runId, agent.id, createdAt)
      }

      // Insert pending install-command runs: these should not consume slots or affect total count
      db.query(
        "INSERT INTO runs (id, agent_id, status, created_at) VALUES ('pending-run-1', ?, 'pending', ?)",
      ).run(agent.id, new Date(baseTime + 10000).toISOString())
      db.query(
        "INSERT INTO runs (id, agent_id, status, created_at) VALUES ('pending-run-2', ?, 'pending', ?)",
      ).run(agent.id, new Date(baseTime + 20000).toISOString())

      // Detail exposes total_runs excluding pending
      const detailRes = await admin("GET", `/api/agents/${agent.id}`)
      expect(detailRes.status).toBe(200)
      const detail = (await detailRes.json()) as any
      expect(detail.total_runs).toBe(55)

      // Page 1 (limit 20)
      const page1Res = await admin("GET", `/api/agents/${agent.id}/runs?limit=20`)
      expect(page1Res.status).toBe(200)
      const page1 = (await page1Res.json()) as any
      expect(page1.runs.length).toBe(20)
      expect(page1.total).toBe(55)
      expect(page1.has_more).toBe(true)
      expect(page1.next_cursor).toBeTruthy()
      expect(page1.runs.some((r: any) => r.status === "pending")).toBe(false)
      expect(page1.runs.map((r: any) => r.id)).toEqual(allRunIds.slice(0, 20))

      // Page 2 (limit 20)
      const page2Res = await admin(
        "GET",
        `/api/agents/${agent.id}/runs?limit=20&cursor=${encodeURIComponent(page1.next_cursor)}`,
      )
      expect(page2Res.status).toBe(200)
      const page2 = (await page2Res.json()) as any
      expect(page2.runs.length).toBe(20)
      expect(page2.total).toBe(55)
      expect(page2.has_more).toBe(true)
      expect(page2.next_cursor).toBeTruthy()
      expect(page2.runs.map((r: any) => r.id)).toEqual(allRunIds.slice(20, 40))

      // Page 3 (limit 20, remaining 15)
      const page3Res = await admin(
        "GET",
        `/api/agents/${agent.id}/runs?limit=20&cursor=${encodeURIComponent(page2.next_cursor)}`,
      )
      expect(page3Res.status).toBe(200)
      const page3 = (await page3Res.json()) as any
      expect(page3.runs.length).toBe(15)
      expect(page3.total).toBe(55)
      expect(page3.has_more).toBe(false)
      expect(page3.next_cursor).toBeNull()
      expect(page3.runs.map((r: any) => r.id)).toEqual(allRunIds.slice(40, 55))
    } finally {
      db.close()
    }
  })

  test("stable tie-breaker for equal timestamps and newly inserted runs do not duplicate", async () => {
    const res = await admin("POST", "/api/agents", {
      label: "agent-tiebreak",
      task: "task",
      model_provider: "anthropic",
      model_name: "claude",
    })
    const agent = (await res.json()) as any
    const db = new Database(path.join(dataDir, "control.db"))
    try {
      const sameTime = "2026-07-01T12:00:00.000Z"
      // Insert 4 runs with exact same timestamp
      const ids = ["run-tie-d", "run-tie-c", "run-tie-b", "run-tie-a"]
      for (const id of ids) {
        db.query(
          "INSERT INTO runs (id, agent_id, status, hostname, created_at) VALUES (?, ?, 'succeeded', 'worker-1', ?)",
        ).run(id, agent.id, sameTime)
      }

      // Page 1 with limit 2
      const p1Res = await admin("GET", `/api/agents/${agent.id}/runs?limit=2`)
      const p1 = (await p1Res.json()) as any
      expect(p1.runs.length).toBe(2)
      // ID tie-breaker is DESC: 'run-tie-d', 'run-tie-c'
      expect(p1.runs[0].id).toBe("run-tie-d")
      expect(p1.runs[1].id).toBe("run-tie-c")
      expect(p1.has_more).toBe(true)

      // Insert brand new runs with newer timestamps while paginating
      db.query(
        "INSERT INTO runs (id, agent_id, status, hostname, created_at) VALUES (?, ?, 'succeeded', 'worker-1', '2026-07-02T00:00:00.000Z')",
      ).run("run-new-1", agent.id)

      // Page 2 using cursor from Page 1
      const p2Res = await admin(
        "GET",
        `/api/agents/${agent.id}/runs?limit=2&cursor=${encodeURIComponent(p1.next_cursor)}`,
      )
      const p2 = (await p2Res.json()) as any
      expect(p2.runs.length).toBe(2)
      // Runs 'run-tie-b', 'run-tie-a' must be returned, not the newly inserted run and not duplicate p1
      expect(p2.runs[0].id).toBe("run-tie-b")
      expect(p2.runs[1].id).toBe("run-tie-a")
      expect(p2.has_more).toBe(false)
    } finally {
      db.close()
    }
  })

  test("verifies authentication and agent/run ownership", async () => {
    const a1 = (await (
      await admin("POST", "/api/agents", { label: "a1", task: "t", model_provider: "anthropic", model_name: "claude" })
    ).json()) as any
    const a2 = (await (
      await admin("POST", "/api/agents", { label: "a2", task: "t", model_provider: "anthropic", model_name: "claude" })
    ).json()) as any
    const db = new Database(path.join(dataDir, "control.db"))
    try {
      db.query("INSERT INTO runs (id, agent_id, status, created_at) VALUES ('r-a1', ?, 'succeeded', ?)").run(
        a1.id,
        "2026-01-01T00:00:00.000Z",
      )
      db.query("INSERT INTO runs (id, agent_id, status, created_at) VALUES ('r-a2', ?, 'succeeded', ?)").run(
        a2.id,
        "2026-01-01T00:00:00.000Z",
      )

      // Unauthenticated requests are rejected
      expect((await fetch(`${base}/api/agents/${a1.id}/runs`)).status).toBe(401)
      expect((await fetch(`${base}/api/agents/${a1.id}/runs/r-a1`)).status).toBe(401)

      // Mismatched agent and run returns 404
      const mismatchRes = await admin("GET", `/api/agents/${a1.id}/runs/r-a2`)
      expect(mismatchRes.status).toBe(404)
      expect((await mismatchRes.json()).detail).toContain("Run not found on this agent")

      // Non-existent run on valid agent returns 404
      const missingRun = await admin("GET", `/api/agents/${a1.id}/runs/no-such-run`)
      expect(missingRun.status).toBe(404)

      // Non-existent agent returns 404
      expect((await admin("GET", "/api/agents/no-such-agent/runs")).status).toBe(404)
      expect((await admin("GET", "/api/agents/no-such-agent/runs/r-a1")).status).toBe(404)

      // Invalid pagination cursor returns 400
      const badCursor = await admin("GET", `/api/agents/${a1.id}/runs?cursor=invalid!`)
      expect(badCursor.status).toBe(400)

      // Explicit empty pagination cursor returns 400
      const emptyCursor = await admin("GET", `/api/agents/${a1.id}/runs?cursor=`)
      expect(emptyCursor.status).toBe(400)
      expect((await emptyCursor.json()).detail).toContain("Invalid pagination cursor")
    } finally {
      db.close()
    }
  })
})
