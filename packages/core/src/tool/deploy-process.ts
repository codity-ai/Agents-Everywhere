import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import path from "node:path"
import { realpathSync } from "node:fs"

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
  approve: (request: DeploymentPermission) => Promise<void>
}) {
  if (!binding || input.operationID !== binding.operation_id) throw new Error("No managed deployment is bound to this session")
  if (input.recipePath && (path.isAbsolute(input.recipePath) || input.recipePath.split(/[\\/]/).includes(".."))) throw new Error("Recipe must be repository relative")
  const env = { ...process.env }
  delete env.CODITY_DEPLOYMENT_BINDING
  const child = spawn("codity", ["deploy", "_agent"], { cwd: input.cwd, env, stdio: ["pipe", "pipe", "pipe"], signal: input.signal })
  child.stdin.write(JSON.stringify({ ...binding, action: input.action, recipe_path: input.recipePath ?? ".codity/deploy.json", cwd: input.cwd }) + "\n")
  const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve) })
  void closed.catch(() => {})
  const timer = setTimeout(() => child.kill("SIGTERM"), 30 * 60 * 1000)
  let result = ""
  let bytes = 0
  child.stderr.resume()
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      bytes += Buffer.byteLength(line)
      if (bytes > 4 * 1024 * 1024) throw new Error("Deployment response exceeded its bound")
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== "object") throw new Error("Invalid deployment response")
      const value = parsed as Record<string, unknown>
      if (value.permission_required === true && value.permission && typeof value.permission === "object") {
        const request = value.permission as Record<string, unknown>
        if (request.operation_id !== input.operationID || typeof request.challenge !== "string" || typeof request.preview !== "string" || typeof request.root !== "string" || realpathSync(request.root) !== realpathSync(input.cwd)) throw new Error("Deployment permission belongs to another operation or repository")
        await input.approve(request as DeploymentPermission)
        child.stdin.write(JSON.stringify({ challenge: request.challenge, approved: true }) + "\n")
        continue
      }
      if (!value.result || typeof value.result !== "object") throw new Error("Invalid deployment result")
      const output = value.result as Record<string, unknown>
      if (output.operation_id !== input.operationID) throw new Error("Deployment result belongs to another operation")
      result = JSON.stringify(output)
    }
    if (await closed !== 0 || !result) throw new Error("Deployment did not finish. Inspect guided review status before retrying.")
    return result
  } finally {
    clearTimeout(timer)
    lines.close()
    child.stdin.destroy()
    if (child.exitCode === null) child.kill("SIGTERM")
  }
}
