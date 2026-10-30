export * as PublishPRTool from "./publish-pr"

import path from "node:path"
import { Effect, Layer, Schema } from "effect"
import { ToolFailure } from "@agents-everywhere/llm"
import { makeLocationNode } from "../effect/app-node"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { publishProcess } from "./pr-publish-process"

export const name = "codity_publish_pr"
const layer = Layer.effectDiscard(Effect.gen(function* () {
  const tools = yield* Tools.Service
  const mutation = yield* LocationMutation.Service
  const permission = yield* PermissionV2.Service
  yield* tools.register({ [name]: Tool.make({
    description: "Publish a prepared Codity PR operation after the developer asks to raise a PR. Prepare with codity pr prepare first. Always requests operation-bound human approval, preserves Git permissions, and returns the confirmed PR reference. Never merge or force push.",
    input: Schema.Struct({ operationID: Schema.String }),
    output: Schema.Struct({ result: Schema.String }),
    toModelOutput: ({ output }) => [{ type: "text", text: output.result }],
    execute: (input, context) => Effect.gen(function* () {
      const target = yield* mutation.resolve({ path: ".", kind: "directory" })
      const signal = yield* Effect.abortSignal
      const result = yield* Effect.tryPromise({
        try: () => publishProcess({ operationID: input.operationID, cwd: target.canonical, signal, approve: async (request) => {
          if (path.resolve(request.root) !== path.resolve(target.canonical)) throw new Error("Publish operation belongs to another repository")
          const source = { type: "tool" as const, messageID: context.assistantMessageID, callID: context.toolCallID }
          const ask = (action: string, resources: string[]) => Effect.runPromise(permission.assert({
            action, resources, save: [], sessionID: context.sessionID, agent: context.agent, source,
            metadata: { operationID: input.operationID, fingerprint: request.fingerprint, preview: request.preview },
          }), { signal })
          await ask("bash", request.commands)
          await ask("edit", request.files.map((file) => path.join(request.root, file)))
          await ask("codity_pr_publish", [request.preview + (request.failed_checks ? "\nApproving acknowledges the failed checks above." : "")])
        } }),
        catch: (cause) => new ToolFailure({ message: cause instanceof Error ? cause.message : "Publish failed" }),
      })
      return { result }
    }).pipe(Effect.scoped, Effect.mapError((error) => error instanceof ToolFailure ? error : new ToolFailure({ message: error.message }))),
  }) }).pipe(Effect.orDie)
}))
export const node = makeLocationNode({ name: "tool/publish-pr", layer, deps: [ToolRegistry.node, PermissionV2.node, LocationMutation.node] })
