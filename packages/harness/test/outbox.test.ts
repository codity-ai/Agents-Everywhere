import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "fs"
import http from "http"
import os from "os"
import path from "path"
import { RunnerClient } from "../src/client"
import {
  DurableOutbox,
  MAX_OUTBOX_EVENTS,
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

test("outbox stops retrying and clears when run is terminal (HTTP 409)", async () => {
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
    expect(outbox.size()).toBe(0)
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
