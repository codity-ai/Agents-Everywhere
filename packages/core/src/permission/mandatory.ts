import { readFileSync } from "node:fs"
import { Wildcard } from "../util/wildcard"

/**
 * Deny rules a control plane hands the engine in a file (`CODITY_MANDATORY_RULES`,
 * a JSON array of `{permission, pattern, action: "deny"}`). They are checked before
 * every config layer, so no project, agent or approved rule can outrank one: a more
 * specific allow wins over a vaguer deny everywhere else (`evaluate`), never here.
 * A file that is set but unreadable stops tool use rather than running unguarded.
 */
type Rule = { permission: string; pattern: string; action: "deny" }
let cached: { path: string; rules: Rule[] } | undefined

export function match(action: string, resource: string): Rule | undefined {
  const path = process.env.CODITY_MANDATORY_RULES
  if (!path) return
  if (cached?.path !== path) {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (
      !Array.isArray(value) ||
      !value.every((rule) => rule && typeof rule.permission === "string" && typeof rule.pattern === "string" && rule.action === "deny")
    )
      throw new Error("Invalid inherited Codity policy. Refusing to start tools.")
    cached = { path, rules: value }
  }
  return cached.rules.find((rule) => Wildcard.match(action, rule.permission) && Wildcard.match(resource, rule.pattern))
}
