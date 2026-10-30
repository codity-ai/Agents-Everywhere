import { spawn } from "node:child_process"
import { createInterface } from "node:readline"

export type Approval = {
  approval_required: true
  challenge: string
  fingerprint: string
  preview: string
  failed_checks: boolean
  root: string
  files: string[]
  commands: string[]
}

function isApproval(value: unknown): value is Approval {
  if (!value || typeof value !== "object") return false
  const input = value as Record<string, unknown>
  return input.approval_required === true && typeof input.challenge === "string" && /^[a-f0-9]{64}$/.test(input.challenge)
    && typeof input.fingerprint === "string" && /^[a-f0-9]{64}$/.test(input.fingerprint)
    && typeof input.preview === "string" && typeof input.root === "string"
    && Array.isArray(input.files) && input.files.every((item) => typeof item === "string")
    && Array.isArray(input.commands) && input.commands.every((item) => typeof item === "string")
}

/** Private IPC, not a model-controlled --yes flag. The caller must authorize
 * this preview through native permission before answering the fresh challenge. */
export async function publishProcess(input: {
  operationID: string
  cwd: string
  signal?: AbortSignal
  approve: (request: Approval) => Promise<void>
  executable?: string
}) {
  if (!/^[a-f0-9]{32}$/.test(input.operationID)) throw new Error("Invalid publish operation ID")
  const child = spawn(input.executable ?? "codity", ["pr", "_publish-permission", input.operationID], {
    cwd: input.cwd,
    env: { ...process.env, CODITY_NO_TTY: "1", NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    signal: input.signal,
  })
  let result = ""
  let error = ""
  let approvalSeen = false
  let failure: unknown
  let outputBytes = 0
  const timer = setTimeout(() => child.kill("SIGTERM"), 10 * 60 * 1000)
  const closed = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject)
    child.on("close", resolve)
  })
  // Observe early process errors even while awaiting an approval.
  void closed.catch(() => {})
  child.stderr.on("data", (data: Buffer) => { error = (error + data.toString()).slice(-8192) })
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      outputBytes += Buffer.byteLength(line)
      if (outputBytes > 2 * 1024 * 1024) throw new Error("Publish response exceeded its limit")
      const value: unknown = JSON.parse(line)
      if (isApproval(value)) {
        if (approvalSeen) throw new Error("Unexpected repeated publish approval")
        approvalSeen = true
        await input.approve(value)
        child.stdin.end(JSON.stringify({ challenge: value.challenge, fingerprint: value.fingerprint, approved: true, allow_failed_checks: value.failed_checks === true }) + "\n")
      } else if (value && typeof value === "object" && "result" in value) {
        result = JSON.stringify(value.result)
      } else throw new Error("Invalid publish response")
    }
  } catch (cause) {
    failure = cause
    child.stdin.destroy()
    child.kill("SIGTERM")
  } finally {
    clearTimeout(timer)
    lines.close()
  }
  const exit = await closed
  if (failure) throw failure
  if (exit !== 0 || !result) throw new Error(error || "Publish did not finish; use codity pr status to inspect the operation")
  return result
}
