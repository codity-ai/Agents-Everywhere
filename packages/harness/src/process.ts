/**
 * Child-process termination with bounded escalation.
 *
 * Sends SIGTERM first, waits for a bounded grace period, and escalates
 * to SIGKILL if the child process has not exited. Cleans up timers and
 * listeners reliably, avoids signalling exited or recycled processes,
 * and ensures idempotence across repeated cleanup calls.
 */
import type { ChildProcess } from "child_process"

export const TERMINATION_GRACE_PERIOD_MS = 2500

export interface TerminateChildOptions {
  gracePeriodMs?: number
}

export interface TerminationHandle {
  readonly escalated: boolean
  cancel(): void
}

const activeTerminations = new WeakMap<ChildProcess, TerminationHandle>()

export function terminateChildProcess(
  child: ChildProcess | null | undefined,
  options?: TerminateChildOptions,
): TerminationHandle {
  const noopHandle: TerminationHandle = { escalated: false, cancel: () => {} }
  if (!child) return noopHandle

  const existing = activeTerminations.get(child)
  if (existing) return existing

  // If already exited, do not attempt to signal
  if (child.exitCode !== null || child.signalCode !== null) {
    return noopHandle
  }

  const pid = child.pid
  if (!pid) return noopHandle

  const graceMs = options?.gracePeriodMs ?? TERMINATION_GRACE_PERIOD_MS
  let timer: ReturnType<typeof setTimeout> | null = null
  let exited = false
  let didEscalate = false

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    child.removeListener("exit", onExit)
    child.removeListener("close", onExit)
    activeTerminations.delete(child)
  }

  const onExit = () => {
    exited = true
    cleanup()
  }

  child.once("exit", onExit)
  child.once("close", onExit)

  // 1. Initial normal termination request (SIGTERM)
  try {
    child.kill("SIGTERM")
  } catch {
    cleanup()
    return noopHandle
  }

  // 2. Escalation timer: if still alive after grace period, send SIGKILL where supported
  timer = setTimeout(() => {
    timer = null
    if (exited) {
      cleanup()
      return
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      cleanup()
      return
    }
    // Verify target process matches the original child PID before signalling
    if (child.pid === pid) {
      try {
        const killed = child.kill("SIGKILL")
        if (killed !== false) {
          didEscalate = true
        }
      } catch {
        /* best-effort kill; process may have already exited */
      }
    }
    cleanup()
  }, graceMs)

  if (timer && typeof timer.unref === "function") {
    timer.unref()
  }

  const handle: TerminationHandle = {
    get escalated() {
      return didEscalate
    },
    cancel: () => {
      cleanup()
    },
  }

  activeTerminations.set(child, handle)
  return handle
}
