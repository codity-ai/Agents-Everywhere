import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { McpCatalog } from "@/mcp/catalog"
import { mcpCallMeta } from "@/session/tools"
import type { Session } from "@/session/session"

const options = { toolCallId: "call_mcp", abortSignal: new AbortController().signal } as any

function session(metadata: Record<string, unknown> | undefined) {
  return { id: "ses_one", metadata } as unknown as Session.Info
}

// A real MCP server over an in-memory transport, recording the `_meta` of each call.
async function recordingClient() {
  const seen: Array<Record<string, unknown> | undefined> = []
  const server = new Server({ name: "codityone", version: "1" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "list_dashboards", inputSchema: { type: "object", properties: {} } }],
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    seen.push(request.params._meta as Record<string, unknown> | undefined)
    return { content: [{ type: "text", text: "ok" }] }
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "1" })
  await client.connect(clientTransport)
  const def = (await client.listTools()).tools[0]
  return { client, def, seen }
}

describe("per-session MCP call metadata", () => {
  test("mcpCallMeta takes only this server's string values, plus the session id", () => {
    const meta = mcpCallMeta(
      session({
        mcp: {
          codityone: { meta: { "codityone/token": "tok-1", nested: { no: 1 }, count: 3 } },
          other: { meta: { "codityone/token": "not-this-one" } },
        },
        unrelated: "ignored",
      }),
      "codityone",
    )
    expect(meta).toEqual({ "agents-everywhere/session": "ses_one", "codityone/token": "tok-1" })
  })

  test("a session without metadata still names itself", () => {
    expect(mcpCallMeta(session(undefined), "codityone")).toEqual({ "agents-everywhere/session": "ses_one" })
  })

  test("convertTool reads the metadata at call time and sends it as _meta", async () => {
    const mcp = await recordingClient()
    const current = { token: "tok-old" }
    const converted = McpCatalog.convertTool(mcp.def, mcp.client, 5_000, async () => ({
      "agents-everywhere/session": "ses_one",
      "codityone/token": current.token,
    }))
    await converted.execute!({}, options)
    // A control plane refreshes the token while a call waits on a permission decision.
    current.token = "tok-new"
    await converted.execute!({}, options)
    expect(mcp.seen.map((meta) => meta?.["codityone/token"])).toEqual(["tok-old", "tok-new"])
    expect(mcp.seen[0]?.["agents-everywhere/session"]).toBe("ses_one")
  })

  test("without a provider no _meta beyond the SDK's own is sent", async () => {
    const mcp = await recordingClient()
    const converted = McpCatalog.convertTool(mcp.def, mcp.client, 5_000)
    await converted.execute!({}, options)
    expect(mcp.seen[0]?.["codityone/token"]).toBeUndefined()
  })
})
