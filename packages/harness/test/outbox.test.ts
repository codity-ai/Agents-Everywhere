import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "fs"
import http from "http"
import os from "os"
import path from "path"
import { RunnerClient } from "../src/client"
import {
  DurableOutbox,
  MAX_OUTBOX_EVENTS,
  outboxFilePath,
  recoverOutbox,
  sanitizePayload,
} from "../src/outbox"

let tmpDir: string
let outboxPath: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "outbox-test-"))
  outboxPath = path.join(tmpDir, "outbox-test-run.json")
})

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

test("sanitizePayload redacts sensitive keys and bearer tokens", () => {
  const input = {
    message: "Running tool with Bearer secret_1234567890abcdef and token",
    apiKey: "sk-proj-xyz123",
    password: "supersecretpassword",
    nested: {
      token: "secret_token_val",
      normal: "hello",
    },
  }
  const sanitized = sanitizePayload(input)
  expect(sanitized.apiKey).toBe("[REDACTED]")
  expect(sanitized.password).toBe("[REDACTED]")
  expect((sanitized.nested as any).token).toBe("[REDACTED]")
  expect((sanitized.nested as any).normal).toBe("hello")
  expect((sanitized.message as string)).toContain("Bearer [REDACTED]")
  expect((sanitized.message as string)).not.toContain("secret_1234567890abcdef")
})

test("sanitizePayload redacts sensitive values inside arrays", () => {
  const input = {
    headers: [
      { authorization: "Bearer sk-secret", name: "auth" },
      { token: "tok_value", name: "refresh" },
    ],
    messages: [
      "Use Bearer abc123xyz to authenticate",
      "Safe message",
    ],
    nested: [
      [{ apiKey: "key_inside_nested_array" }],
    ],
    plain: [1, 2, null, true],
  }
  const sanitized = sanitizePayload(input)

  // Object elements inside arrays should have sensitive keys redacted
  const headers = sanitized.headers as any[]
  expect(headers[0].authorization).toBe("[REDACTED]")
  expect(headers[0].name).toBe("auth")
  expect(headers[1].token).toBe("[REDACTED]")
  expect(headers[1].name).toBe("refresh")

  // String elements inside arrays should have bearer tokens redacted
  const messages = sanitized.messages as string[]
  expect(messages[0]).toContain("Bearer [REDACTED]")
  expect(messages[0]).not.toContain("abc123xyz")
  expect(messages[1]).toBe("Safe message")

  // Nested arrays should be recursively sanitized
  const nested = sanitized.nested as any[][]
  expect(nested[0][0].apiKey).toBe("[REDACTED]")

  // Primitives pass through unchanged
  expect(sanitized.plain).toEqual([1, 2, null, true])
})

test("outbox persists events before sending and uses restrictive permissions", async () => {
  const client = new RunnerClient("http://127.0.0.1:9999", "test-token")
  const outbox = new DurableOutbox(client, "test-run", () => {}, outboxPath)

  outbox.enqueue("step", { action: "read_file", path: "/tmp/foo.txt" }, { tokensIn: 10, tokensOut: 5, costUsd: 0.001 })

  expect(fs.existsSync(outboxPath)).toBe(true)
  const content = JSON.parse(fs.readFileSync(outboxPath, "utf8"))
  expect(content.version).toBe(1)
  expect(content.runId).toBe("test-run")
  expect(content.events.length).toBe(1)
  expect(content.events[0].eventType).toBe("step")
  expect(content.events[0].payload.action).toBe("read_file")
  expect(content.events[0].usage.tokensIn).toBe(10)

  // Verify file mode (permissions)
  const stat = fs.statSync(outboxPath)
  if (process.platform !== "win32") {
    // Mode should be 0o600 (owner read/write only)
    expect(stat.mode & 0o777).toBe(0o600)
  }

  outbox.cleanup()
  expect(fs.existsSync(outboxPath)).toBe(false)
})

test("outbox delivers events in FIFO order and removes acknowledged events", async () => {
  const received: Array<{ event_id?: string; payload: any }> = []

  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      const parsed = JSON.parse(body)
      received.push(parsed)
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ run_id: "test-run", status: "running", event_id: parsed.event_id, acknowledged: true }))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const port = (server.address() as any).port

  try {
    const client = new RunnerClient(`http://127.0.0.1:${port}`, "test-token")
    const outbox = new DurableOutbox(client, "test-run", () => {}, outboxPath)

    outbox.enqueue("step", { order: 1 })
    outbox.enqueue("step", { order: 2 })
    outbox.enqueue("step", { order: 3 })

    const flushed = await outbox.flush(5000)
    expect(flushed).toBe(true)
    expect(outbox.size()).toBe(0)
    expect(received.length).toBe(3)
    expect(received[0].payload.order).toBe(1)
    expect(received[1].payload.order).toBe(2)
    expect(received[2].payload.order).toBe(3)

    // Verify outbox file on disk is updated to empty events
    const content = JSON.parse(fs.readFileSync(outboxPath, "utf8"))
    expect(content.events.length).toBe(0)

    outbox.cleanup()
  } finally {
    server.close()
  }
})

test("outbox retries on transient errors and delivers once server recovers", async () => {
  let attempts = 0
  const server = http.createServer((req, res) => {
    attempts++
    if (attempts < 3) {
      // Fail first 2 attempts
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ detail: "temporary server error" }))
      return
    }
    // Succeed on 3rd attempt
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ run_id: "test-run", status: "running", acknowledged: true }))
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const port = (server.address() as any).port

  try {
    const client = new RunnerClient(`http://127.0.0.1:${port}`, "test-token")
    const outbox = new DurableOutbox(client, "test-run", () => {}, outboxPath)

    outbox.enqueue("step", { retryTest: true })

    const flushed = await outbox.flush(6000)
    expect(flushed).toBe(true)
    expect(attempts).toBeGreaterThanOrEqual(3)
    expect(outbox.size()).toBe(0)

    outbox.cleanup()
  } finally {
    server.close()
  }
})

test("outbox stops delivery when run is terminal (HTTP 409) but preserves queued events", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(409, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ detail: "Run is already succeeded" }))
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const port = (server.address() as any).port

  try {
    const client = new RunnerClient(`http://127.0.0.1:${port}`, "test-token")
    const outbox = new DurableOutbox(client, "test-run", () => {}, outboxPath)

    outbox.enqueue("step", { message: "late event" })

    await new Promise((r) => setTimeout(r, 200))
    // The event stays in the queue (not silently dropped) — recovery or manual
    // inspection can see what was lost.
    expect(outbox.size()).toBe(1)
    // But the outbox is stopped: new enqueues are rejected.
    const rejected = outbox.enqueue("step", { message: "another" })
    expect(rejected).toBeNull()
    outbox.cleanup()
  } finally {
    server.close()
  }
})

test("outbox rejects events when MAX_OUTBOX_EVENTS limit is reached", () => {
  const client = new RunnerClient("http://127.0.0.1:9999", "test-token")
  const outbox = new DurableOutbox(client, "test-run", () => {}, outboxPath)

  // Fill up queue to limit
  for (let i = 0; i < MAX_OUTBOX_EVENTS; i++) {
    const id = outbox.enqueue("step", { i })
    expect(id).not.toBeNull()
  }

  // Next enqueue must be rejected
  const rejectedId = outbox.enqueue("step", { overflow: true })
  expect(rejectedId).toBeNull()
  expect(outbox.size()).toBe(MAX_OUTBOX_EVENTS)

  outbox.cleanup()
})

test("recoverOutbox replays pending records without running model or task", async () => {
  // Pre-seed an outbox file simulating interrupted runner process
  const preSeededEvents = [
    {
      id: "recovered_evt_1",
      seq: 1,
      eventType: "step" as const,
      payload: { step: 1 },
      usage: { tokensIn: 5, tokensOut: 5, costUsd: 0.0001 },
      createdAt: new Date().toISOString(),
      attempts: 0,
    },
    {
      id: "recovered_evt_2",
      seq: 2,
      eventType: "step" as const,
      payload: { step: 2 },
      usage: { tokensIn: 10, tokensOut: 10, costUsd: 0.0002 },
      createdAt: new Date().toISOString(),
      attempts: 0,
    },
  ]
  fs.writeFileSync(outboxPath, JSON.stringify({ version: 1, runId: "test-run", events: preSeededEvents }), {
    mode: 0o600,
  })

  const deliveredEvents: any[] = []
  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      const parsed = JSON.parse(body)
      deliveredEvents.push(parsed)
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ run_id: "test-run", status: "running", event_id: parsed.event_id, acknowledged: true }))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const port = (server.address() as any).port

  try {
    const result = await recoverOutbox(`http://127.0.0.1:${port}`, "test-token", "test-run", () => {}, outboxPath)
    expect(result.delivered).toBe(2)
    expect(result.remaining).toBe(0)
    expect(deliveredEvents.length).toBe(2)
    expect(deliveredEvents[0].event_id).toBe("recovered_evt_1")
    expect(deliveredEvents[1].event_id).toBe("recovered_evt_2")
    // File cleaned up after full delivery
    expect(fs.existsSync(outboxPath)).toBe(false)
  } finally {
    server.close()
  }
})

test("timed-out flush preserves outbox file on disk for --recover-outbox", async () => {
  // Use an unreachable server so delivery never succeeds
  const client = new RunnerClient("http://127.0.0.1:1", "test-token")
  const outbox = new DurableOutbox(client, "test-run", () => {}, outboxPath)

  outbox.enqueue("step", { message: "event that won't be delivered" })
  expect(outbox.size()).toBe(1)

  // Flush with very short timeout — delivery will fail
  const flushed = await outbox.flush(100)
  expect(flushed).toBe(false)
  // The outbox file must still exist for later recovery
  expect(fs.existsSync(outboxPath)).toBe(true)
  expect(outbox.size()).toBe(1)

  outbox.stop()
  // Verify file still has the event
  const content = JSON.parse(fs.readFileSync(outboxPath, "utf8"))
  expect(content.events.length).toBe(1)
  expect(content.events[0].payload.message).toBe("event that won't be delivered")

  // Manual cleanup for the test
  outbox.cleanup()
})

test("payload-conflict 409 discards the single event but does not stop delivery of remaining events", async () => {
  let callCount = 0
  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      callCount++
      const parsed = JSON.parse(body)
      if (parsed.event_id === "evt_conflict") {
        // Payload-conflict 409 (not a terminal-run 409)
        res.writeHead(409, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ detail: "Event ID evt_conflict already exists with a different payload" }))
      } else {
        // All other events succeed
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ run_id: "test-run", status: "running", event_id: parsed.event_id, acknowledged: true }))
      }
    })
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const port = (server.address() as any).port

  try {
    const client = new RunnerClient(`http://127.0.0.1:${port}`, "test-token")
    const outbox = new DurableOutbox(client, "test-run", () => {}, outboxPath)

    // The first event will get a conflict 409 — should be discarded, not stop the outbox
    outbox.enqueue("step", { message: "will conflict" })
    // Manually override the id on the internal queue to force the conflict
    ;(outbox as any).queue[0].id = "evt_conflict"

    outbox.enqueue("step", { message: "should still deliver" })

    const flushed = await outbox.flush(5000)
    expect(flushed).toBe(true)
    expect(outbox.size()).toBe(0)
    // Both events were attempted: one discarded (conflict), one delivered
    expect(callCount).toBe(2)

    outbox.cleanup()
  } finally {
    server.close()
  }
})

test("malformed outbox entries are skipped during load and only valid entries are queued", () => {
  // Write a file with a mix of valid and malformed entries
  const mixedEntries = [
    null,
    { id: "valid_1", seq: 1, eventType: "step", payload: { ok: true }, usage: {}, createdAt: new Date().toISOString(), attempts: 0 },
    42,
    { id: "missing_seq", eventType: "step", payload: {}, usage: {}, createdAt: new Date().toISOString(), attempts: 0 },
    { id: "valid_2", seq: 2, eventType: "step", payload: { also: "ok" }, usage: {}, createdAt: new Date().toISOString(), attempts: 0 },
    { id: "no_payload", seq: 3, eventType: "step", attempts: 0 },
  ]
  fs.writeFileSync(outboxPath, JSON.stringify({ version: 1, runId: "test-run", events: mixedEntries }), { mode: 0o600 })

  const logs: string[] = []
  const client = new RunnerClient("http://127.0.0.1:9999", "test-token")
  const outbox = new DurableOutbox(client, "test-run", (line) => logs.push(line), outboxPath)

  // Only the two fully valid entries should survive
  expect(outbox.size()).toBe(2)
  // Malformed entries should have been logged
  expect(logs.some((l) => l.includes("Discarding malformed outbox entry"))).toBe(true)

  outbox.cleanup()
})

test("credential redaction: redacts OPENAI_API_KEY, llm_api_key, and credentials embedded in message or command text", () => {
  const payload = {
    OPENAI_API_KEY: "sk-proj-12345678901234567890abcdef",
    llm_api_key: "sk-ant-12345678901234567890abcdef",
    access_token: "ghp_123456789012345678901234567890123456",
    refresh_token: "ref_1234567890abcdef",
    client_secret: "cs_1234567890abcdef",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    command: "export OPENAI_API_KEY='sk-12345678901234567890'; curl -H 'Authorization: Bearer my_secret_token' https://api.openai.com",
    message: "Failed authenticating with llm_api_key=sk-ant-secret-key-123456 and token sk-proj-12345678901234567890",
    nestedArray: [
      { OPENAI_API_KEY: "sk-in-array", text: "x-api-key: secret_key_12345" },
    ],
  }

  const sanitized = sanitizePayload(payload)

  // Keys must be redacted
  expect(sanitized.OPENAI_API_KEY).toBe("[REDACTED]")
  expect(sanitized.llm_api_key).toBe("[REDACTED]")
  expect(sanitized.access_token).toBe("[REDACTED]")
  expect(sanitized.refresh_token).toBe("[REDACTED]")
  expect(sanitized.client_secret).toBe("[REDACTED]")
  expect(sanitized.ANTHROPIC_API_KEY).toBe("[REDACTED]")

  // Command string must have embedded credentials redacted
  const cmd = sanitized.command as string
  expect(cmd).not.toContain("sk-12345678901234567890")
  expect(cmd).not.toContain("my_secret_token")
  expect(cmd).toContain("OPENAI_API_KEY='[REDACTED]'")
  expect(cmd).toContain("Bearer [REDACTED]")

  // Message string must have embedded credentials redacted
  const msg = sanitized.message as string
  expect(msg).not.toContain("sk-ant-secret-key-123456")
  expect(msg).not.toContain("sk-proj-12345678901234567890")
  expect(msg).toContain("llm_api_key=[REDACTED]")
  expect(msg).toContain("[REDACTED]")

  // Array elements
  const arr = sanitized.nestedArray as any[]
  expect(arr[0].OPENAI_API_KEY).toBe("[REDACTED]")
  expect(arr[0].text).toContain("x-api-key: [REDACTED]")
})

test("completion with nonempty outbox preserves pending records on disk and gates cleanup", async () => {
  // Use an unreachable endpoint to simulate server outage during run
  const client = new RunnerClient("http://127.0.0.1:1", "test-token")
  const outbox = new DurableOutbox(client, "test-run", () => {}, outboxPath)

  outbox.enqueue("step", { task: "uncompleted step" }, { tokensIn: 100, tokensOut: 50, costUsd: 0.005 })
  expect(outbox.size()).toBe(1)
  expect(outbox.isEmpty()).toBe(false)

  // Flush times out
  const flushed = await outbox.flush(100)
  expect(flushed).toBe(false)

  // Check the policy: cleanup() MUST NOT be called if outbox is nonempty
  if (outbox.isEmpty()) {
    outbox.cleanup()
  } else {
    outbox.stop()
  }

  // Verify the outbox file survives on disk with the record intact
  expect(fs.existsSync(outboxPath)).toBe(true)
  const saved = JSON.parse(fs.readFileSync(outboxPath, "utf8"))
  expect(saved.events.length).toBe(1)
  expect(saved.events[0].payload.task).toBe("uncompleted step")
  expect(saved.events[0].usage.tokensIn).toBe(100)

  // Only when outbox is actually empty does cleanup delete it
  outbox.clear()
  expect(outbox.isEmpty()).toBe(true)
  outbox.cleanup()
  expect(fs.existsSync(outboxPath)).toBe(false)
})

test("recovery after termination halts delivery and preserves pending outbox records without deleting", async () => {
  // Simulate a control-plane server that has already marked the run terminal
  const server = http.createServer((_req, res) => {
    res.writeHead(409, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ detail: "Run is already succeeded" }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const port = (server.address() as any).port

  try {
    // Seed an outbox with pending events
    const preSeededEvents = [
      {
        id: "evt_terminal_1",
        seq: 1,
        eventType: "step",
        payload: { text: "after termination event" },
        usage: { tokensIn: 20, tokensOut: 10, costUsd: 0.001 },
        createdAt: new Date().toISOString(),
        attempts: 0,
      },
    ]
    fs.writeFileSync(outboxPath, JSON.stringify({ version: 1, runId: "test-run", events: preSeededEvents }), { mode: 0o600 })

    const logs: string[] = []
    const result = await recoverOutbox(`http://127.0.0.1:${port}`, "test-token", "test-run", (l) => logs.push(l), outboxPath)

    // Delivery must halt upon 409 terminal status
    expect(result.delivered).toBe(0)
    expect(result.remaining).toBe(1)

    // Outbox file must NOT be deleted
    expect(fs.existsSync(outboxPath)).toBe(true)
    const diskContent = JSON.parse(fs.readFileSync(outboxPath, "utf8"))
    expect(diskContent.events.length).toBe(1)
    expect(diskContent.events[0].id).toBe("evt_terminal_1")

    // Logs explain that run is terminal on control plane
    expect(logs.some((l) => l.includes("Run is terminal on control plane"))).toBe(true)

    // Manual cleanup for test
    fs.unlinkSync(outboxPath)
  } finally {
    server.close()
  }
})

test("stop() resolves pending backoff wait immediately without hanging", async () => {
  const client = new RunnerClient("http://127.0.0.1:1", "test-token")
  const outbox = new DurableOutbox(client, "test-run", () => {}, outboxPath)

  outbox.enqueue("step", { retry: true })

  // Wait a short moment for delivery attempt to fail and enter wait(delay)
  await new Promise((r) => setTimeout(r, 50))

  const start = Date.now()
  outbox.stop()
  // Wait a tick to let drain finish after unblocking
  await new Promise((r) => setTimeout(r, 20))
  const elapsed = Date.now() - start

  // stop() should resolve the wait immediately, taking well under 500ms initial backoff
  expect(elapsed).toBeLessThan(200)

  outbox.cleanup()
})

test("outboxFilePath validates fileId and prevents path traversal", () => {
  // Valid alphanumeric, underscore, hyphen
  expect(outboxFilePath("run-123_abc")).toContain("outbox-run-123_abc.json")

  // Path traversal attempts must be rejected
  expect(() => outboxFilePath("../etc/passwd")).toThrow("Invalid fileId")
  expect(() => outboxFilePath("..\\windows\\system32")).toThrow("Invalid fileId")
  expect(() => outboxFilePath("/absolute/path")).toThrow("Invalid fileId")
  expect(() => outboxFilePath("run/nested")).toThrow("Invalid fileId")
  expect(() => outboxFilePath("")).toThrow("Invalid fileId")
})
