import { Effect, Schema } from "effect"
import { deployProcess } from "@agents-everywhere/core/tool/deploy-process"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import { define, type Context } from "./tool"
export const DeployTool = define("codity_deploy", Effect.succeed({
  description: "Operate the deployment bound to this agent. Prepare its recipe, then obtain human plan approval in guided review before apply. Use verify/recover/reconcile for observed outcomes. Never deploy through shell commands.",
  parameters: Schema.Struct({ operationID: Schema.String, action: Schema.Literals(["prepare", "apply", "verify", "recover", "reconcile", "status"]), recipePath: Schema.optional(Schema.String) }),
  execute: (input: { operationID: string; action: "prepare" | "apply" | "verify" | "recover" | "reconcile" | "status"; recipePath?: string }, ctx: Context) => Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const bridge = yield* EffectBridge.make()
    const output = yield* Effect.tryPromise({
      try: () => deployProcess({ ...input, cwd: instance.directory, signal: ctx.abort, approve: (request) => bridge.promise(ctx.ask({ permission: "codity_deployment", patterns: [request.preview], always: [], metadata: { operationID: input.operationID, preview: request.preview } })) }),
      catch: (cause) => new Error(cause instanceof Error ? cause.message : "Deployment failed"),
    })
    return { title: "Managed deployment result", output, metadata: {} }
  }).pipe(Effect.orDie),
}))
