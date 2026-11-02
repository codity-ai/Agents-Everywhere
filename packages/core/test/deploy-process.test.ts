import { test, expect } from "bun:test"
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
test("native deployment binds operations, isolates credentials and honors denial", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codity-deploy-ipc-"))
  const id = "11111111-1111-4111-8111-111111111111"
  const executable = path.join(dir, "codity")
  await writeFile(executable, `#!/usr/bin/env node
const lines=require('node:readline').createInterface({input:process.stdin});let start;
lines.on('line',line=>{const value=JSON.parse(line);if(!start){start=value;if(process.env.CODITY_DEPLOYMENT_BINDING||!start.token||process.argv.some(v=>v.includes('private-secret')))process.exit(11);process.stdout.write(JSON.stringify({permission_required:true,permission:{challenge:'fresh',preview:'Concrete recipe',root:process.cwd(),operation_id:start.operation_id}})+'\\n');return;}
if(value.challenge!=='fresh'||value.approved!==true)process.exit(12);process.stdout.write(JSON.stringify({operation_id:start.operation_id,progress:'[1/3] Probing mount... Verified'})+'\\n');process.stdout.write(JSON.stringify({result:{operation_id:start.operation_id,state:'awaiting_approval'}})+'\\n');process.exit(0);});
`)
  await chmod(executable, 0o700)
  const oldPath = process.env.PATH
  process.env.PATH = dir + path.delimiter + oldPath
  process.env.CODITY_DEPLOYMENT_BINDING = JSON.stringify({ bridge_url: "http://127.0.0.1:1/deploy", token: "private-secret", operation_id: id })
  try {
    const { deployProcess } = await import("../src/tool/deploy-process")
    expect(process.env.CODITY_DEPLOYMENT_BINDING).toBeUndefined()
    await expect(deployProcess({ operationID: "unrelated", action: "apply", cwd: dir, approve: async () => {} })).rejects.toThrow("bound")
    await expect(deployProcess({ operationID: id, action: "prepare", cwd: dir, approve: async () => { throw new Error("denied") } })).rejects.toThrow("denied")
    let requests = 0
    const progress: string[] = []
    const result = await deployProcess({ operationID: id, action: "prepare", cwd: dir, onProgress: async (line) => { progress.push(line) }, approve: async (request) => { requests++; expect(request.preview).toBe("Concrete recipe") } })
    expect(requests).toBe(1)
    expect(progress).toEqual(["[1/3] Probing mount... Verified"])
    expect(JSON.parse(result).state).toBe("awaiting_approval")
    expect(result).not.toContain("private-secret")
  } finally { process.env.PATH = oldPath; delete process.env.CODITY_DEPLOYMENT_BINDING; await rm(dir, { recursive: true, force: true }) }
})
