import { expect, test } from "bun:test"
import { completionBinding, completionRequest } from "../src/util/pr-completion"

test("completion binding accepts only the local authenticated session", () => {
  expect(completionBinding()).toBeUndefined()
  expect(completionBinding(JSON.stringify({ url: "https://remote.invalid", token: "fixture", session_id: "session" }))).toBeUndefined()
  const binding = completionBinding(JSON.stringify({ url: "http://127.0.0.1:1234", token: "fixture", session_id: "session", started_at: 100 }))
  expect(binding?.sessionID).toBe("session")
  expect(binding?.startedAt).toBe(100)
})

test("terminal inspect and completion requests carry authentication without an approval boolean", async () => {
  const requests: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      expect(request.headers.get("authorization")).toBe("Bearer fixture-token")
      expect(await request.text()).toBe("")
      requests.push(new URL(request.url).pathname)
      return Response.json(new URL(request.url).pathname === "/inspect" ? { ready: true } : { state: "declined", message: "Continue chatting or /pr." })
    },
  })
  try {
    const binding = completionBinding(JSON.stringify({ url: server.url.toString(), token: "fixture-token", session_id: "fixture-session" }))!
    expect((await completionRequest(binding, "inspect")).ready).toBe(true)
    expect((await completionRequest(binding, "complete")).state).toBe("declined")
    expect(requests).toEqual(["/inspect", "/complete"])
  } finally { await server.stop(true) }
})
