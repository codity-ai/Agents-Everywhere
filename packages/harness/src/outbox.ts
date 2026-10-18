import crypto from "crypto"
import fs from "fs"
import path from "path"
import { runnerHome } from "./brand"
import { RunnerClient } from "./client"
import { log } from "./log"
import type { EventType, Usage } from "./protocol"

export const MAX_OUTBOX_EVENTS = 1000
export const MAX_OUTBOX_BYTES = 5 * 1024 * 1024 // 5 MB
const INITIAL_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 10_000

export interface OutboxEntry {
  id: string
  seq: number
  eventType: EventType
  payload: Record<string, unknown>
  usage: Usage
  createdAt: string
  attempts: number
}

interface OutboxData {
  version: number
  runId: string
  events: OutboxEntry[]
}

const SENSITIVE_KEYS = /^(password|token|secret|apiKey|api_key|authorization|bearer|auth|cookie|key)$/i
const BEARER_PATTERN = /(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi

/** Recursively sanitize a single value (string, object, or array). */
function sanitizeValue(v: unknown): unknown {
  if (typeof v === "string") {
    return v.replace(BEARER_PATTERN, "$1[REDACTED]")
  }
  if (Array.isArray(v)) {
    return v.map(sanitizeValue)
  }
  if (v && typeof v === "object") {
    return sanitizePayload(v as Record<string, unknown>)
  }
  return v
}

/** Never persist raw credential values in the on-disk outbox. */
export function sanitizePayload(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.test(k)) {
      out[k] = "[REDACTED]"
    } else {
      out[k] = sanitizeValue(v)
    }
  }
  return out
}

export function outboxFilePath(fileId: string): string {
  return path.join(runnerHome(), `outbox-${fileId}.json`)
}

export class DurableOutbox {
  private queue: OutboxEntry[] = []
  private seqCounter = 0
  private delivering = false
  private stopped = false
  private backoffDelay = INITIAL_BACKOFF_MS
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private flushResolvers: Array<() => void> = []

  readonly filePath: string

  constructor(
    private readonly client: RunnerClient,
    private readonly fileId: string,
    private readonly logFn: (line: string) => void = log,
    customFilePath?: string,
  ) {
    this.filePath = customFilePath || outboxFilePath(fileId)
    this.load()
  }

  private load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf8")
        const parsed: OutboxData = JSON.parse(raw)
        if (Array.isArray(parsed.events)) {
          this.queue = parsed.events
          this.seqCounter = this.queue.reduce((max, e) => Math.max(max, e.seq || 0), 0)
          this.logFn(`Loaded ${this.queue.length} pending event(s) from outbox at ${this.filePath}`)
        }
      }
    } catch (err) {
      this.logFn(`Could not read existing outbox file: ${err}`)
    }
  }

  private persist(): boolean {
    try {
      const dir = path.dirname(this.filePath)
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const data: OutboxData = {
        version: 1,
        runId: this.fileId,
        events: this.queue,
      }
      const serialized = JSON.stringify(data, null, 2)
      if (Buffer.byteLength(serialized) > MAX_OUTBOX_BYTES) {
        this.logFn(`Outbox size limit exceeded (${Buffer.byteLength(serialized)} bytes > ${MAX_OUTBOX_BYTES} bytes)`)
        return false
      }
      const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
      fs.writeFileSync(tmpPath, serialized, { mode: 0o600 })
      try {
        fs.chmodSync(tmpPath, 0o600)
      } catch {
        /* best effort on windows */
      }
      try {
        fs.renameSync(tmpPath, this.filePath)
      } catch {
        // Cross-device or locked rename: move the existing file aside so we
        // never delete it before confirming the replacement succeeds.
        const backupPath = `${this.filePath}.${process.pid}.bak`
        let backedUp = false
        try {
          if (fs.existsSync(this.filePath)) {
            fs.renameSync(this.filePath, backupPath)
            backedUp = true
          }
        } catch {
          /* if we cannot move the old file aside, try the rename anyway */
        }
        try {
          fs.renameSync(tmpPath, this.filePath)
          // Replacement succeeded; remove the backup
          if (backedUp) {
            try {
              fs.unlinkSync(backupPath)
            } catch {
              /* best effort */
            }
          }
        } catch (renameErr) {
          // Replacement failed — restore the backup so the old data is preserved
          if (backedUp) {
            try {
              fs.renameSync(backupPath, this.filePath)
            } catch {
              /* last resort: at least the backup file survives on disk */
            }
          }
          throw renameErr
        }
      }
      return true
    } catch (err: any) {
      this.logFn(`Outbox write failed (disk full or write error): ${err?.message || err}`)
      return false
    }
  }

  /**
   * Enqueues an event: persists to disk before attempting delivery.
   * Delivered in documented strict per-run FIFO order.
   */
  enqueue(eventType: EventType, payload: Record<string, unknown>, usage: Usage = {}): string | null {
    if (this.stopped) {
      this.logFn("Outbox is stopped; rejecting new event")
      return null
    }

    if (this.queue.length >= MAX_OUTBOX_EVENTS) {
      this.logFn(`Outbox limit reached (${MAX_OUTBOX_EVENTS} events); rejecting new event`)
      return null
    }

    const id = crypto.randomUUID()
    this.seqCounter++
    const entry: OutboxEntry = {
      id,
      seq: this.seqCounter,
      eventType,
      payload: sanitizePayload(payload),
      usage: {
        tokensIn: usage.tokensIn || 0,
        tokensOut: usage.tokensOut || 0,
        costUsd: usage.costUsd ?? null,
      },
      createdAt: new Date().toISOString(),
      attempts: 0,
    }

    this.queue.push(entry)
    const persisted = this.persist()
    if (!persisted) {
      // Revert in-memory enqueue if disk write failed (disk full or quota exhausted)
      this.queue.pop()
      return null
    }

    this.triggerDelivery()
    return id
  }

  private triggerDelivery() {
    if (this.delivering || this.stopped || this.queue.length === 0) return
    this.delivering = true
    void this.drain()
  }

  private notifyFlush() {
    if (this.queue.length === 0) {
      const resolvers = this.flushResolvers
      this.flushResolvers = []
      for (const resolve of resolvers) resolve()
    }
  }

  private async drain() {
    while (!this.stopped && this.queue.length > 0) {
      const current = this.queue[0]
      try {
        const res = await this.client.postEvent(current.eventType, current.payload, current.usage, current.id)

        if (res.status === 200) {
          // Acknowledged by server: remove from outbox and update disk
          this.queue.shift()
          this.persist()
          this.backoffDelay = INITIAL_BACKOFF_MS
          this.notifyFlush()
          continue
        }

        if (res.status === 409) {
          const detail = typeof res.data === "object" && res.data ? String((res.data as any).detail || "") : ""
          if (detail.includes("already") || detail.includes("terminal") || detail.includes("ended")) {
            this.logFn(`Run is terminal on control plane (HTTP 409: ${detail}); stopping outbox delivery.`)
            this.stop()
            this.clear()
            break
          }
          // Payload conflict: duplicate event id with mismatched payload
          this.logFn(`Event ${current.id} rejected with conflict (HTTP 409): ${detail}. Discarding unrecoverable event.`)
          this.queue.shift()
          this.persist()
          this.notifyFlush()
          continue
        }

        if (res.status === 401 || res.status === 404) {
          this.logFn(`Run credentials refused or run not found (HTTP ${res.status}); stopping outbox delivery.`)
          this.stop()
          break
        }

        // 5xx or transient status
        current.attempts++
        const delay = Math.round(this.backoffDelay * (1.2 + Math.random() * 0.4))
        this.backoffDelay = Math.min(MAX_BACKOFF_MS, this.backoffDelay * 2)
        this.logFn(`Event delivery failed (HTTP ${res.status}); retrying in ${delay}ms (attempt ${current.attempts})`)
        await this.wait(delay)
      } catch (err: any) {
        current.attempts++
        const delay = Math.round(this.backoffDelay * (1.2 + Math.random() * 0.4))
        this.backoffDelay = Math.min(MAX_BACKOFF_MS, this.backoffDelay * 2)
        this.logFn(`Network error delivering event: ${err?.message || err}; retrying in ${delay}ms (attempt ${current.attempts})`)
        await this.wait(delay)
      }
    }

    this.delivering = false
    this.notifyFlush()
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      clearTimeout(this.retryTimer)
      this.retryTimer = setTimeout(resolve, ms)
    })
  }

  /** Awaits until all queued events are acknowledged or until timeout. */
  async flush(timeoutMs = 15_000): Promise<boolean> {
    if (this.queue.length === 0) return true
    this.triggerDelivery()
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>
      const onDone = () => {
        clearTimeout(timer)
        resolve(this.queue.length === 0)
      }
      timer = setTimeout(() => {
        const idx = this.flushResolvers.indexOf(onDone)
        if (idx !== -1) this.flushResolvers.splice(idx, 1)
        resolve(this.queue.length === 0)
      }, timeoutMs)
      this.flushResolvers.push(onDone)
    })
  }

  stop() {
    this.stopped = true
    clearTimeout(this.retryTimer)
  }

  clear() {
    this.queue = []
    this.persist()
    this.notifyFlush()
  }

  cleanup() {
    this.stop()
    try {
      if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath)
    } catch {
      /* ignore */
    }
  }

  size(): number {
    return this.queue.length
  }
}

/**
 * Replays unacknowledged outbox events from a previous run without resuming
 * model execution or repeating provider calls.
 */
export async function recoverOutbox(
  apiUrl: string,
  runToken: string,
  fileId: string,
  logFn: (line: string) => void = log,
  customFilePath?: string,
): Promise<{ delivered: number; remaining: number }> {
  const filePath = customFilePath || outboxFilePath(fileId)
  if (!fs.existsSync(filePath)) {
    logFn(`No outbox file found at ${filePath}`)
    return { delivered: 0, remaining: 0 }
  }

  const client = new RunnerClient(apiUrl, runToken)
  const outbox = new DurableOutbox(client, fileId, logFn, filePath)
  const initialCount = outbox.size()
  logFn(`Recovering ${initialCount} unacknowledged event(s) from outbox...`)

  await outbox.flush(30_000)
  const remaining = outbox.size()
  const delivered = initialCount - remaining

  if (remaining === 0) {
    logFn(`Successfully recovered and delivered all ${delivered} event(s).`)
    outbox.cleanup()
  } else {
    logFn(`Recovery finished: delivered ${delivered} event(s), ${remaining} remaining.`)
  }

  return { delivered, remaining }
}
