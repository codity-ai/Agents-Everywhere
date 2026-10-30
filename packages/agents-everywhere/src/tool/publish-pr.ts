import path from "node:path"
import { Effect, Schema } from "effect"
import { publishProcess } from "@agents-everywhere/core/tool/pr-publish-process"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import { define, type Context } from "./tool"

export const PublishPRTool = define("codity_publish_pr", Effect.succeed({
  description: "Publish a prepared Codity GitHub PR operation only after the developer has asked to raise a PR. First use codity pr prepare with explicit files, title/body files and a check report. This tool shows the exact preview and always asks the human for operation-bound permission, even when Bash was already allowed. It returns the confirmed PR result and never merges. A denied approval leaves changes uncommitted. Requires Git, gh authentication, and the Codity CLI on the target machine.",
  parameters: Schema.Struct({ operationID: Schema.String }),
  execute: (input: {operationID:string}, ctx: Context) => Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const bridge = yield* EffectBridge.make()
    const output = yield* Effect.tryPromise({
      try: () => publishProcess({
        operationID: input.operationID,
        cwd: instance.directory,
        signal: ctx.abort,
        approve: async (request) => {
          if (path.resolve(request.root) !== path.resolve(instance.directory) && path.resolve(request.root) !== path.resolve(instance.worktree)) throw new Error("Publish operation belongs to another repository")
          await bridge.promise(ctx.ask({ permission: "bash", patterns: request.commands, always: [], metadata: { command: request.commands.join("\n") } }))
          await bridge.promise(ctx.ask({ permission: "edit", patterns: request.files.map((file) => path.join(request.root, file)), always: [], metadata: { operationID: input.operationID } }))
          await bridge.promise(ctx.ask({
            permission: "codity_pr_publish",
            patterns: [request.preview + (request.failed_checks ? "\nAPPROVING THIS OPERATION ACKNOWLEDGES THE FAILED CHECKS ABOVE." : "")],
            always: [],
            metadata: { operationID: input.operationID, fingerprint: request.fingerprint, preview: request.preview },
          }))
        },
      }),
      catch: (cause) => new Error(cause instanceof Error ? cause.message : "Publish failed"),
    })
    return { title: "GitHub PR publish result", output, metadata: {} }
  }).pipe(Effect.orDie),
}))
