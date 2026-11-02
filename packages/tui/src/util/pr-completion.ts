export function completionBinding(raw = process.env.CODITY_PR_COMPLETION_BINDING) {
  if (!raw) return
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== "object") return
  const binding = value as Record<string, unknown>
  if (typeof binding.url !== "string" || typeof binding.token !== "string" || typeof binding.session_id !== "string") return
  const url = new URL(binding.url)
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) return
  return { url: url.origin, token: binding.token, sessionID: binding.session_id, startedAt: typeof binding.started_at === "number" ? binding.started_at : Date.now() }
}

export async function completionRequest(binding: NonNullable<ReturnType<typeof completionBinding>>, action: "inspect" | "complete") {
  const response = await fetch(`${binding.url}/${action}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${binding.token}` },
    signal: AbortSignal.timeout(action === "inspect" ? 15000 : 30 * 60 * 1000),
  })
  const data: unknown = await response.json()
  if (!response.ok) throw new Error(data && typeof data === "object" && "message" in data ? String(data.message) : "PR completion is unavailable")
  return data as { ready?: boolean; state?: string; message?: string; pr_url?: string; guided_review_url?: string }
}
