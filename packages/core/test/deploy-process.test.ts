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
lines.on('line',line=>{const value=JSON.parse(line);if(!start){start=value;if(process.env.PREPARE_ERROR){process.stderr.write(process.env.PREPARE_ERROR+' '+start.token+' '+start.bridge_url);process.exit(7);return;}if(process.env.CODITY_DEPLOYMENT_BINDING||!start.token||process.argv.some(v=>v.includes('private-secret')))process.exit(11);process.stdout.write(JSON.stringify({permission_required:true,permission:{challenge:'fresh',preview:'Concrete recipe',root:process.cwd(),operation_id:start.operation_id}})+'\\n');return;}
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
for (const diagnostic of ["check out the exact deployment revision before preparing or applying", "prepare target validation: Docker context is not the explicitly selected local socket", "prepare preflight 1 (python3): deployment command failed or timed out: python3", "x".repeat(100000) + "working tree must be clean"]) {
  process.env.PREPARE_ERROR = diagnostic
  await assert.rejects(deployProcess({ operationID: ${JSON.stringify(id)}, action: "prepare", cwd: process.cwd(), approve: async () => { throw new Error("unexpected approval") } }), (error: Error) => {
    assert.ok(error.message.includes("Deployment prepare failed (exit 7)"))
    assert.ok(error.message.includes(diagnostic.length > 65536 ? "Diagnostic output exceeded its bound" : diagnostic.slice(-100)))
    assert.ok(!error.message.includes("private-secret"))
    assert.ok(!error.message.includes("http://127.0.0.1:1/deploy"))
    assert.ok(error.message.length < 4200)
    return true
  })
}
delete process.env.PREPARE_ERROR
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

test("typed native failures are bound, scrubbed and never treated as success", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codity-deploy-failure-"))
  try {
    await writeFile(path.join(dir, "codity"), `#!/usr/bin/env node
require('node:readline').createInterface({input:process.stdin}).once('line',line=>{
 const start=JSON.parse(line);const frame=JSON.parse(process.env.TEST_FRAME);
 const data=JSON.stringify({failure:frame})+'\\n';
 process.stdout.write(data.slice(0,31));setImmediate(()=>process.stdout.write(data.slice(31),()=>process.exit(Number(process.env.TEST_EXIT||1))));
});`)
    await chmod(path.join(dir, "codity"), 0o700)
    await writeFile(path.join(dir, "runner.ts"), `import assert from "node:assert/strict"
import { deployProcess } from ${JSON.stringify(new URL("../src/tool/deploy-process.ts", import.meta.url).href)}
import { DeploymentFailure } from ${JSON.stringify(new URL("../src/tool/deploy-diagnostic.ts", import.meta.url).href)}
const base={version:1,operation_id:"fixture",action:"status",stage:"source",code:"source_revision_mismatch",message:"Wrong revision private-secret model-secret \\u001b[31mred\\u001b[0m",next_action:"Correct checkout http://127.0.0.1:1/deploy",retry_policy:"after_correction"}
let reports=0
process.env.TEST_FRAME=JSON.stringify(base)
await assert.rejects(deployProcess({operationID:"fixture",action:"status",cwd:process.cwd(),approve:async()=>{throw Error("unexpected permission")},onFailure:async(d)=>{reports++;assert.equal(d.code,base.code);assert.ok(!JSON.stringify(d).includes("private-secret"));assert.ok(!JSON.stringify(d).includes("model-secret"));assert.ok(!JSON.stringify(d).includes("http://127.0.0.1:1/deploy"));assert.ok(!JSON.stringify(d).includes("\\\\u001b"))}}),(err:Error)=>err instanceof DeploymentFailure&&err.message.includes("source_revision_mismatch"))
assert.equal(reports,1)
for(const patch of [{version:2},{operation_id:"other"},{action:"apply"},{code:"arbitrary"},{message:"x".repeat(9000)},{extra:"private-secret"}]){
 process.env.TEST_FRAME=JSON.stringify({...base,...patch})
 await assert.rejects(deployProcess({operationID:"fixture",action:"status",cwd:process.cwd(),approve:async()=>{},onFailure:async()=>{throw Error("invalid diagnostic reported")}}),/Invalid deployment diagnostic/)
}
process.env.TEST_FRAME=JSON.stringify(base);process.env.TEST_EXIT="0"
await assert.rejects(deployProcess({operationID:"fixture",action:"status",cwd:process.cwd(),approve:async()=>{}}),/successful exit/)
`)
    const child = Bun.spawn([process.execPath, path.join(dir, "runner.ts")], { cwd: dir, env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH, TEST_API_KEY: "model-secret", CODITY_DEPLOYMENT_BINDING: JSON.stringify({ bridge_url: "http://127.0.0.1:1/deploy", token: "private-secret", operation_id: "fixture" }) }, stdout: "pipe", stderr: "pipe" })
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
  } finally { await rm(dir, { recursive: true, force: true }) }
})
