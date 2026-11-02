import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import path from "node:path"
import { realpathSync } from "node:fs"
import { decodeDeploymentDiagnostic, DeploymentFailure, scrubDeploymentDiagnostic, type DeploymentDiagnostic } from "./deploy-diagnostic"

const binding = (() => {
  const raw = process.env.CODITY_DEPLOYMENT_BINDING
  delete process.env.CODITY_DEPLOYMENT_BINDING
  if (!raw) return undefined
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== "object") throw new Error("Invalid deployment binding")
  const input = value as Record<string, unknown>
  if (typeof input.bridge_url !== "string" || typeof input.token !== "string" || typeof input.operation_id !== "string") throw new Error("Invalid deployment binding")
  const url = new URL(input.bridge_url)
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) throw new Error("Deployment bridge must be loopback")
  return { bridge_url: input.bridge_url, token: input.token, operation_id: input.operation_id }
})()
export type DeploymentPermission = { challenge: string; preview: string; root: string; operation_id: string }
export const deploymentAvailable = () => Boolean(binding)
export async function deployProcess(input: {
  operationID: string
  action: "prepare" | "apply" | "verify" | "recover" | "reconcile" | "status"
  recipePath?: string
  cwd: string
  signal?: AbortSignal
  onProgress?: (message: string) => Promise<void>
  onFailure?: (diagnostic: DeploymentDiagnostic) => Promise<void>
  approve: (request: DeploymentPermission) => Promise<void>
}) {
  if (!binding || input.operationID !== binding.operation_id) throw new Error("No managed deployment is bound to this session")
  if (input.recipePath && (path.isAbsolute(input.recipePath) || input.recipePath.split(/[\\/]/).includes(".."))) throw new Error("Recipe must be repository relative")
  const env = { ...process.env }
  const secrets = [binding.token, binding.bridge_url, ...Object.entries(env).filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)).map(([, value]) => value ?? "")]
  const reportFailure = (diagnostic: DeploymentDiagnostic) => input.onFailure
    ? input.onFailure(diagnostic).then(() => true)
    : fetch(binding.bridge_url + "/failure", { method: "POST", headers: { Authorization: "Bearer " + binding.token, "Content-Type": "application/json" }, body: JSON.stringify(diagnostic), signal: AbortSignal.timeout(5000) }).then((response) => response.ok, () => false)
  delete env.CODITY_DEPLOYMENT_BINDING
  const child = spawn("codity", ["deploy", "_agent"], { cwd: input.cwd, env, stdio: ["pipe", "pipe", "pipe"], signal: input.signal })
  child.stdin.write(JSON.stringify({ ...binding, action: input.action, recipe_path: input.recipePath ?? ".codity/deploy.json", cwd: input.cwd }) + "\n")
  const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve) })
  void closed.catch(() => {})
  const timer = setTimeout(() => child.kill("SIGTERM"), 30 * 60 * 1000)
  let result = ""
  let bytes = 0
  let stderr = ""
  let stderrExceeded = false
  let failure: DeploymentDiagnostic | undefined
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    if (stderrExceeded) return
    stderr += chunk
    if (Buffer.byteLength(stderr) > 65536) { stderr = ""; stderrExceeded = true }
  })
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      bytes += Buffer.byteLength(line)
      if (bytes > 4 * 1024 * 1024) throw new Error("Deployment response exceeded its bound")
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== "object") throw new Error("Invalid deployment response")
      const value = parsed as Record<string, unknown>
      if (value.failure !== undefined) {
        if (failure || result) throw new Error("Unexpected repeated deployment result")
        const diagnostic = decodeDeploymentDiagnostic(value.failure, input.operationID, input.action)
        failure = { ...diagnostic, message: scrubDeploymentDiagnostic(diagnostic.message, secrets), next_action: scrubDeploymentDiagnostic(diagnostic.next_action, secrets) }
        continue
      }
      if (failure) throw new Error("Unexpected output after deployment failure")
      if (typeof value.progress === "string") {
        if (value.operation_id !== input.operationID || value.progress.length > 4096 || /[\x00-\x1f\x7f]/.test(value.progress)) throw new Error("Invalid deployment progress")
        await input.onProgress?.(value.progress)
        continue
      }
      if (value.permission_required === true && value.permission && typeof value.permission === "object") {
        const request = value.permission as Record<string, unknown>
        if (request.operation_id !== input.operationID || typeof request.challenge !== "string" || typeof request.preview !== "string" || typeof request.root !== "string" || realpathSync(request.root) !== realpathSync(input.cwd)) throw new Error("Deployment permission belongs to another operation or repository")
        try {
          await input.approve(request as DeploymentPermission)
        } catch {
          input.signal?.throwIfAborted()
          const diagnostic: DeploymentDiagnostic = { version: 1, operation_id: input.operationID, action: input.action, stage: "permission", code: "permission_denied", message: "Native deployment permission was denied or unavailable.", next_action: "Obtain explicit human permission before continuing.", retry_policy: "after_correction" }
          throw new DeploymentFailure(diagnostic, await reportFailure(diagnostic))
        }
        child.stdin.write(JSON.stringify({ challenge: request.challenge, approved: true }) + "\n")
        continue
      }
      if (!value.result || typeof value.result !== "object") throw new Error("Invalid deployment result")
      const output = value.result as Record<string, unknown>
      if (output.operation_id !== input.operationID) throw new Error("Deployment result belongs to another operation")
      result = JSON.stringify(output)
    }
    const exit = await closed
    if (failure) {
      if (exit === 0) throw new Error("Deployment failure returned a successful exit")
      throw new DeploymentFailure(failure, await reportFailure(failure))
    }
    if (exit !== 0 || !result) {
      // Never expose the private bootstrap if a child includes it in diagnostics.
      const detail = stderrExceeded ? "Diagnostic output exceeded its bound; inspect status and update the CLI if its diagnostic protocol is unsupported." : scrubDeploymentDiagnostic(stderr, secrets)
      throw new Error(`Deployment ${input.action} failed (${child.signalCode ?? `exit ${exit}`}): ${detail || "No diagnostic returned; inspect operation status before retrying."}`)
    }
    return result
  } finally {
    clearTimeout(timer)
    lines.close()
    child.stdin.destroy()
    if (child.exitCode === null) child.kill("SIGTERM")
  }
}
