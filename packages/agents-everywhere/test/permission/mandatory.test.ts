import { test, expect } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Permission } from "@/permission"
import { PermissionV2 } from "@agents-everywhere/core/permission"

test("mandatory denies override specific per-agent and saved approvals in both engines", () => {
  const dir = mkdtempSync(join(tmpdir(), "codity-policy-"))
  const previous = process.env.CODITY_MANDATORY_RULES
  try {
    const filename = join(dir, "rules.json")
    writeFileSync(filename, JSON.stringify([{ permission: "read", pattern: "/root/*", action: "deny" }]))
    process.env.CODITY_MANDATORY_RULES = filename
    expect(Permission.evaluate("read", "/root/file", [{ permission: "read", pattern: "/root/file", action: "allow" }]).action).toBe("deny")
    expect(PermissionV2.evaluate("read", "/root/file", [{ action: "read", resource: "/root/file", effect: "allow" }]).effect).toBe("deny")
    expect(Permission.evaluate("read", "/logs/file", [{ permission: "read", pattern: "/logs/*", action: "allow" }]).action).toBe("allow")
  } finally {
    if (previous) process.env.CODITY_MANDATORY_RULES = previous
    else delete process.env.CODITY_MANDATORY_RULES
    rmSync(dir, { recursive: true })
  }
})

test("a mandatory rules file that is not a deny list stops tool use", () => {
  const dir = mkdtempSync(join(tmpdir(), "codity-policy-"))
  const previous = process.env.CODITY_MANDATORY_RULES
  try {
    const filename = join(dir, "bad.json")
    writeFileSync(filename, JSON.stringify([{ permission: "read", pattern: "*", action: "allow" }]))
    process.env.CODITY_MANDATORY_RULES = filename
    expect(() => Permission.evaluate("read", "/x", [])).toThrow("Invalid inherited Codity policy")
  } finally {
    if (previous) process.env.CODITY_MANDATORY_RULES = previous
    else delete process.env.CODITY_MANDATORY_RULES
    rmSync(dir, { recursive: true })
  }
})
