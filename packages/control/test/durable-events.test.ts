import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { openDatabase } from "../src/db"
import { RuntimeApi } from "../src/runtime"
import { Store } from "../src/store"
import { loadKeys, createBootstrapToken, createRunToken, type Keys } from "../src/crypto"
import { sweep, LOST_AFTER_MS } from "../src/reaper"

let tmpDir: string
let dbFile: string
let store: Store
let api: RuntimeApi
let keys: Keys

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "durable-events-test-"))
  dbFile = path.join(tmpDir, "test.db")
  const db = openDatabase(dbFile)
  store = new Store(db)
  keys = loadKeys(tmpDir)
  api = new RuntimeApi(store, keys, () => {})
})

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

function setupAgentAndRun() {
  const agentId = store.createAgent(
    {
      label: "Test Agent",
      os_shell: "linux_bash",
      location_label: null,
      task: "Test durable events",
      model_provider: "anthropic",
      model_name: "claude-3-7-sonnet",
      llm_api_key_sealed: null,
      interactive: false,
      permission_mode: "strict",
      permission_request_timeout_seconds: 60,
      declared_env_vars: [],
    },
    [],
    [],
  )
  store.activateAgent(agentId)
  const runId = store.createPendingRun(agentId)
  store.claimPendingRun(runId, agentId, "test-host", { protocol_version: 2 })
  const runToken = createRunToken(keys, agentId, runId).token
  return { agentId, runId, runToken }
}

async function postEvent(runToken: string, body: unknown) {
  const req = new Request("http://localhost/agents/runtime/events", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${runToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
  const res = await api.event(req).catch((err) => ({
    status: err.status || 500,
    json: async () => ({ detail: err.message }),
  }))
  return { status: res.status, data: await res.json() }
}

test("lost acknowledgement followed by replay results in one stored event and single usage contribution", async () => {
  const { agentId, runId, runToken } = setupAgentAndRun()

  const eventPayload = {
    event_id: "evt_durable_123",
    event_type: "step",
    payload: { kind: "tool", message: "Executed tool call" },
    tokens_in: 500,
    tokens_out: 100,
    cost_usd: 0.015,
  }

  // 1. First attempt succeeds on server
  const first = await postEvent(runToken, eventPayload)
  expect(first.status).toBe(200)
  expect(first.data.event_id).toBe("evt_durable_123")

  // 2. Simulate client not receiving ack (network dropped) and retrying with same payload
  const replay = await postEvent(runToken, eventPayload)
  expect(replay.status).toBe(200)
  expect(replay.data.event_id).toBe("evt_durable_123")
  expect(replay.data.duplicate).toBe(true)

  // 3. Inspect real SQLite persistence
  const events = store.events(runId)
  expect(events.length).toBe(1)
  expect(events[0].id).toBe("evt_durable_123")
  expect(events[0].tokens_in).toBe(500)
  expect(events[0].tokens_out).toBe(100)
  expect(events[0].cost_usd).toBe(0.015)

  // 4. Verify aggregated agent usage is counted only once
  const usage = store.agentUsage(agentId)
  expect(usage.tokens_in).toBe(500)
  expect(usage.tokens_out).toBe(100)
  expect(usage.cost).toBe(0.015)
})

test("reusing event identity with different payload is rejected explicitly with 409", async () => {
  const { runId, runToken } = setupAgentAndRun()

  const original = {
    event_id: "evt_shared_id",
    event_type: "step",
    payload: { action: "file_read" },
    tokens_in: 10,
    tokens_out: 2,
    cost_usd: 0.001,
  }

  const res1 = await postEvent(runToken, original)
  expect(res1.status).toBe(200)

  // Try reusing same event_id with different payload
  const conflictingPayload = {
    event_id: "evt_shared_id",
    event_type: "step",
    payload: { action: "file_write", target: "/etc/passwd" },
    tokens_in: 10,
    tokens_out: 2,
    cost_usd: 0.001,
  }

  const res2 = await postEvent(runToken, conflictingPayload)
  expect(res2.status).toBe(409)
  expect(res2.data.detail).toContain("already exists with a different payload")

  // Try reusing same event_id with different tokens
  const conflictingTokens = {
    ...original,
    tokens_in: 999,
  }
  const res3 = await postEvent(runToken, conflictingTokens)
  expect(res3.status).toBe(409)

  // SQLite still only has the original event
  const events = store.events(runId)
  expect(events.length).toBe(1)
  expect(JSON.parse(events[0].payload).action).toBe("file_read")
})

test("terminal runs reject pending and replayed events with 409", async () => {
  const { runId, runToken } = setupAgentAndRun()

  const eventPayload = {
    event_id: "evt_before_terminal",
    event_type: "step",
    payload: { message: "Accepted while active" },
    tokens_in: 10,
    tokens_out: 10,
    cost_usd: 0.001,
  }

  // 1. Post an event while the run is still active
  const accepted = await postEvent(runToken, eventPayload)
  expect(accepted.status).toBe(200)
  expect(store.events(runId).length).toBe(1)

  // 2. Finish run as succeeded
  store.endRun(runId, "succeeded")

  // 3. Replay the same event after terminal — must be rejected
  const replay = await postEvent(runToken, eventPayload)
  expect(replay.status).toBe(409)
  expect(replay.data.detail).toContain("already succeeded")

  // 4. Post a brand-new event after terminal — must also be rejected
  const newEvent = {
    event_id: "evt_late_1",
    event_type: "step",
    payload: { message: "Too late" },
    tokens_in: 10,
    tokens_out: 10,
    cost_usd: 0.001,
  }

  const res = await postEvent(runToken, newEvent)
  expect(res.status).toBe(409)
  expect(res.data.detail).toContain("already succeeded")

  // Ensure only the pre-terminal event was stored
  expect(store.events(runId).length).toBe(1)
  expect(store.events(runId)[0].id).toBe("evt_before_terminal")
})

test("reaped lost runs reject pending events with 409", async () => {
  const { runId, runToken } = setupAgentAndRun()

  // Make the run appear silent since 10 minutes ago
  const db = (store as any).db
  const past = new Date(Date.now() - LOST_AFTER_MS - 60_000).toISOString()
  db.query("UPDATE runs SET last_heartbeat_at = ?, started_at = ?, created_at = ? WHERE id = ?").run(
    past,
    past,
    past,
    runId,
  )

  // Run reaper sweep
  const result = sweep(store)
  expect(result.lost).toBe(1)
  expect(store.getRun(runId)?.status).toBe("failed")

  // Runner attempts to send event
  const res = await postEvent(runToken, {
    event_id: "evt_after_reap",
    event_type: "step",
    payload: { message: "Reporting after silence" },
  })
  expect(res.status).toBe(409)
  expect(res.data.detail).toContain("already failed")
})

test("protocol negotiation respects client capability", async () => {
  const agentId = store.createAgent(
    {
      label: "Proto Agent",
      os_shell: "linux_bash",
      location_label: null,
      task: "Test proto",
      model_provider: "anthropic",
      model_name: "claude-3-7-sonnet",
      llm_api_key_sealed: null,
      interactive: false,
      permission_mode: "strict",
      permission_request_timeout_seconds: 60,
      declared_env_vars: [],
    },
    [],
    [],
  )
  store.activateAgent(agentId)

  // Run 1: v1 runner (protocol_version: 1)
  const run1Id = store.createPendingRun(agentId)
  const token1 = createBootstrapToken(keys, agentId, run1Id)
  const hs1Req = new Request("http://localhost/agents/runtime/handshake", {
    method: "POST",
    headers: { Authorization: `Bearer ${token1.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ run_env: { protocol_version: 1 } }),
  })
  const hs1Res = await api.handshake(hs1Req)
  const hs1Data = await hs1Res.json()
  expect(hs1Data.protocol_version).toBe(1)

  // Run 2: v2 runner (protocol_version: 2)
  const run2Id = store.createPendingRun(agentId)
  const token2 = createBootstrapToken(keys, agentId, run2Id)
  const hs2Req = new Request("http://localhost/agents/runtime/handshake", {
    method: "POST",
    headers: { Authorization: `Bearer ${token2.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ run_env: { protocol_version: 2 } }),
  })
  const hs2Res = await api.handshake(hs2Req)
  const hs2Data = await hs2Res.json()
  expect(hs2Data.protocol_version).toBe(2)
})
