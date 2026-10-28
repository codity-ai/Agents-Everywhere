import { LayerNode } from "@agents-everywhere/core/effect/layer-node"
import { ConfigPermissionV1 } from "@agents-everywhere/core/v1/config/permission"
import { InstanceState } from "@/effect/instance-state"
import { Wildcard } from "@agents-everywhere/core/util/wildcard"
import { match as mandatoryMatch } from "@agents-everywhere/core/permission/mandatory"
import { Deferred, Effect, Layer, Context } from "effect"
import os from "os"
import { PermissionV1 } from "@agents-everywhere/core/v1/permission"
import { EventV2Bridge } from "@/event-v2-bridge"

export const Event = PermissionV1.Event

export interface Interface {
  readonly ask: (input: PermissionV1.AskInput) => Effect.Effect<void, PermissionV1.Error>
  readonly reply: (input: PermissionV1.ReplyInput) => Effect.Effect<void, PermissionV1.NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionV1.Request>>
}

interface PendingEntry {
  info: PermissionV1.Request
  deferred: Deferred.Deferred<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>
}

interface State {
  pending: Map<PermissionV1.ID, PendingEntry>
  approved: PermissionV1.Rule[]
}

/** How much of a pattern is literal. A rule that spells out more of what it
 *  matches is a more deliberate statement about it than one that wildcards it,
 *  which is what makes it the right thing to rank by. */
function specificity(rule: PermissionV1.Rule): number {
  const literal = (value: string) => value.replace(/[*?]/g, "").length
  return literal(rule.permission) + literal(rule.pattern)
}

/**
 * Resolves conflicting rules for one permission/pattern pair.
 *
 * The most specific matching rule wins, and order decides only between rules of
 * equal specificity, where later wins.
 *
 * Order alone used to decide everything (`findLast` over the merged rules),
 * which made `{"*": "deny", "src/*": "allow"}` and `{"src/*": "allow", "*":
 * "deny"}` mean opposite things even though both plainly say "allow src, deny
 * the rest". A generated config cannot control JSON key order reliably, so that
 * turned a correct-looking permission set into a silent deny-everything.
 *
 * Order still has to decide equal-specificity conflicts, because that is how
 * layering works: rulesets are merged in increasing precedence (engine
 * defaults, then agent config, then the session's own approved rules), and
 * `{"*": "allow"}` from a default has to lose to `{"*": "deny"}` from a config
 * and vice versa. What changed is that a *vaguer* later rule no longer beats a
 * specific earlier one.
 *
 * No match at all is still "ask", so an unmentioned permission escalates rather
 * than silently resolving either way.
 */
export function evaluate(permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule {
  // A control plane's mandatory deny outranks every layer (core/permission/mandatory.ts).
  const mandatory = mandatoryMatch(permission, pattern)
  if (mandatory) return mandatory
  let best: PermissionV1.Rule | undefined
  let bestScore = -1

  for (const ruleset of rulesets) {
    for (const rule of ruleset) {
      if (!Wildcard.match(permission, rule.permission) || !Wildcard.match(pattern, rule.pattern)) continue
      const score = specificity(rule)
      // >= rather than >, so that among equally specific rules the last one
      // still wins and layer precedence is preserved.
      if (score >= bestScore) {
        best = rule
        bestScore = score
      }
    }
  }

  return best ?? { action: "ask", permission, pattern: "*" }
}

export class Service extends Context.Service<Service, Interface>()("@agents-everywhere/Permission") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        void ctx
        const state = {
          pending: new Map<PermissionV1.ID, PendingEntry>(),
          approved: [],
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const ask = Effect.fn("Permission.ask")(function* (input: PermissionV1.AskInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const { ruleset, ...request } = input
      // Only what the rules leave open goes in front of the person: a pattern they
      // already allow needs no decision, and approving it permanently would add nothing.
      const undecided: string[] = []

      for (const pattern of request.patterns) {
        const rule = evaluate(request.permission, pattern, ruleset, approved)
        yield* Effect.logInfo("evaluated", { permission: request.permission, pattern, action: rule })
        if (rule.action === "deny") {
          return yield* new PermissionV1.DeniedError({
            ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
          })
        }
        if (rule.action === "allow") continue
        undecided.push(pattern)
      }

      if (undecided.length === 0) return

      const id = request.id ?? PermissionV1.ID.ascending()
      const info: PermissionV1.Request = {
        id,
        sessionID: request.sessionID,
        permission: request.permission,
        patterns: undecided,
        metadata: request.metadata,
        always: request.always,
        tool: request.tool,
      }
      yield* Effect.logInfo("asking", { id, permission: info.permission, patterns: info.patterns })

      const deferred = yield* Deferred.make<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>()
      pending.set(id, { info, deferred })
      yield* events.publish(Event.Asked, info)
      return yield* Effect.ensuring(
        Deferred.await(deferred),
        Effect.sync(() => {
          pending.delete(id)
        }),
      )
    })

    const reply = Effect.fn("Permission.reply")(function* (input: PermissionV1.ReplyInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const existing = pending.get(input.requestID)
      if (!existing) return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })

      pending.delete(input.requestID)
      yield* events.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })

      if (input.reply === "reject") {
        yield* Deferred.fail(
          existing.deferred,
          input.message
            ? new PermissionV1.CorrectedError({ feedback: input.message })
            : new PermissionV1.RejectedError(),
        )

        for (const [id, item] of pending.entries()) {
          if (item.info.sessionID !== existing.info.sessionID) continue
          pending.delete(id)
          yield* events.publish(Event.Replied, {
            sessionID: item.info.sessionID,
            requestID: item.info.id,
            reply: "reject",
          })
          yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
        }
        return
      }

      yield* Deferred.succeed(existing.deferred, undefined)
      if (input.reply === "once") return

      for (const pattern of existing.info.always) {
        approved.push({
          permission: existing.info.permission,
          pattern,
          action: "allow",
        })
      }

      for (const [id, item] of pending.entries()) {
        if (item.info.sessionID !== existing.info.sessionID) continue
        const ok = item.info.patterns.every(
          (pattern) => evaluate(item.info.permission, pattern, approved).action === "allow",
        )
        if (!ok) continue
        pending.delete(id)
        yield* events.publish(Event.Replied, {
          sessionID: item.info.sessionID,
          requestID: item.info.id,
          reply: "always",
        })
        yield* Deferred.succeed(item.deferred, undefined)
      }
    })

    const list = Effect.fn("Permission.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (item) => item.info)
    })

    return Service.of({ ask, reply, list })
  }),
)

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function fromConfig(permission: ConfigPermissionV1.Info) {
  const ruleset: PermissionV1.Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    ruleset.push(
      ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
    )
  }
  return ruleset
}

/**
 * Layers rulesets in increasing precedence (engine defaults, then agent, then
 * the user's config). A later layer replaces every earlier rule it covers, so
 * a config that says `"*": "deny"` means it, whatever the engine's defaults
 * allow about particular tools. Within one layer nothing is replaced and
 * evaluate() ranks by specificity, which is what makes a single config's key
 * order irrelevant.
 *
 * Specificity alone used to decide across layers too, and there it inverted
 * precedence: the engine's own `read: {"*": "allow"}` names a tool, so it
 * outranked a config's `"*": "deny"` and the locked-down compaction agent could
 * read.
 */
export function merge(...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule[] {
  let merged: PermissionV1.Rule[] = []
  for (const layer of rulesets) {
    merged = merged.filter(
      (earlier) =>
        !layer.some(
          (later) => Wildcard.match(earlier.permission, later.permission) && Wildcard.match(earlier.pattern, later.pattern),
        ),
    )
    merged.push(...layer)
  }
  return merged
}

export function disabled(tools: string[], ruleset: PermissionV1.Ruleset): Set<string> {
  const edits = ["edit", "write", "apply_patch"]
  const reads = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]
  return new Set(
    tools.filter((tool) => {
      const permission = edits.includes(tool) ? "edit" : reads.includes(tool) ? "read" : tool
      const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
      return rule?.pattern === "*" && rule.action === "deny"
    }),
  )
}

export function visibleTools<T>(tools: Record<string, T>, ruleset: PermissionV1.Ruleset): Record<string, T> {
  const hidden = disabled(Object.keys(tools), ruleset)
  return Object.fromEntries(Object.entries(tools).filter(([name]) => !hidden.has(name)))
}

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node] })

export * as Permission from "."
