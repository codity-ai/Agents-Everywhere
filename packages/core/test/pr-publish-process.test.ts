import { test, expect } from "bun:test"
import { mkdtemp, writeFile, chmod, rm, access } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { publishProcess } from "../src/tool/pr-publish-process"

test("native publish IPC waits for exact approval and closes on denial", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codity-publish-ipc-"))
  const executable = path.join(dir, "codity-fixture")
  const marker = path.join(dir, "published")
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const request={approval_required:true,challenge:'a'.repeat(64),fingerprint:'b'.repeat(64),preview:'Exact prepared preview',failed_checks:true,root:process.cwd(),files:['feature.txt'],commands:['git push -- origin HEAD:refs/heads/feature']};
process.stdout.write(JSON.stringify(request)+'\\n');
let buffer='';process.stdin.on('data',chunk=>{buffer+=chunk;if(!buffer.includes('\\n'))return;const answer=JSON.parse(buffer);if(answer.challenge!==request.challenge||answer.fingerprint!==request.fingerprint||answer.approved!==true||answer.allow_failed_checks!==true)process.exit(1);fs.writeFileSync(${JSON.stringify(marker)},'approved');process.stdout.write(JSON.stringify({result:{state:'created',pr:{url:'https://github.com/test/repo/pull/1'}}})+'\\n');process.exit(0);});
`)
  await chmod(executable, 0o700)
  try {
    await expect(publishProcess({ operationID: "c".repeat(32), cwd: dir, executable, approve: async () => { throw new Error("denied") } })).rejects.toThrow("denied")
    expect(await access(marker).then(() => true, () => false)).toBe(false)
    let asked = 0
    const result = await publishProcess({ operationID: "c".repeat(32), cwd: dir, executable, approve: async (request) => {
      asked++
      expect(request.preview).toBe("Exact prepared preview")
      expect(request.failed_checks).toBe(true)
      expect(await access(marker).then(() => true, () => false)).toBe(false)
    } })
    expect(asked).toBe(1)
    expect(JSON.parse(result).state).toBe("created")
    expect(await access(marker).then(() => true, () => false)).toBe(true)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
