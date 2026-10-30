export * as DeployTool from "./deploy"
import { Effect, Layer, Schema } from "effect"
import { ToolFailure } from "@agents-everywhere/llm"
import { makeLocationNode } from "../effect/app-node"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { deployProcess } from "./deploy-process"
export const name = "codity_deploy"
const layer = Layer.effectDiscard(Effect.gen(function* () {
  const tools = yield* Tools.Service
  const mutation = yield* LocationMutation.Service
  const permission = yield* PermissionV2.Service
  yield* tools.register({ [name]: Tool.make({
    description: "Operate the deployment bound to this session. Prepare the repository recipe, obtain human approval in guided review, then apply. Never substitute shell deployment commands. Verify, recover and reconcile preserve uncertain outcomes.",
    input: Schema.Struct({ operationID: Schema.String, action: Schema.Literals(["prepare", "apply", "verify", "recover", "reconcile", "status"]), recipePath: Schema.optional(Schema.String) }),
    output: Schema.Struct({ result: Schema.String }),
    toModelOutput: ({ output }) => [{ type: "text", text: output.result }],
    execute: (input, context) => Effect.gen(function* () {
      const target = yield* mutation.resolve({ path: ".", kind: "directory" })
      const signal = yield* Effect.abortSignal
      const result = yield* Effect.tryPromise({
        try: () => deployProcess({ ...input, cwd: target.canonical, signal, approve: async (request) => {
          await Effect.runPromise(permission.assert({ action: "codity_deployment", resources: [request.preview], save: [], sessionID: context.sessionID, agent: context.agent, source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID }, metadata: { operationID: input.operationID, preview: request.preview } }), { signal })
        } }),
        catch: (cause) => new ToolFailure({ message: cause instanceof Error ? cause.message : "Deployment failed" }),
      })
      return { result }
    }).pipe(Effect.scoped, Effect.mapError((error) => error instanceof ToolFailure ? error : new ToolFailure({ message: error.message }))),
  }) }).pipe(Effect.orDie)
}))
export const node = makeLocationNode({ name: "tool/deploy", layer, deps: [ToolRegistry.node, PermissionV2.node, LocationMutation.node] })
