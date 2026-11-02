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
  try {
    // Binding capture happens once at process startup, independent of the suite's module cache.
    const runner = path.join(dir, "runner.ts")
    await writeFile(runner, `import assert from "node:assert/strict"
import { deployProcess } from ${JSON.stringify(new URL("../src/tool/deploy-process.ts", import.meta.url).href)}
assert.equal(process.env.CODITY_DEPLOYMENT_BINDING, undefined)
await assert.rejects(deployProcess({ operationID: "unrelated", action: "apply", cwd: process.cwd(), approve: async () => {} }), /bound/)
await assert.rejects(deployProcess({ operationID: ${JSON.stringify(id)}, action: "prepare", cwd: process.cwd(), approve: async () => { throw new Error("denied") } }), /denied/)
let requests = 0
const progress: string[] = []
const result = await deployProcess({ operationID: ${JSON.stringify(id)}, action: "prepare", cwd: process.cwd(), onProgress: async (line) => { progress.push(line) }, approve: async (request) => { requests++; assert.equal(request.preview, "Concrete recipe") } })
assert.equal(requests, 1)
assert.deepEqual(progress, ["[1/3] Probing mount... Verified"])
assert.equal(JSON.parse(result).state, "awaiting_approval")
assert.ok(!result.includes("private-secret"))
`)
    const child = Bun.spawn([process.execPath, runner], {
      cwd: dir,
      env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH, CODITY_DEPLOYMENT_BINDING: JSON.stringify({ bridge_url: "http://127.0.0.1:1/deploy", token: "private-secret", operation_id: id }) },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
  } finally { await rm(dir, { recursive: true, force: true }) }
})
