import { api, ApiError, type AgentSummary, type Run, type RunEvent } from "../api"
import { clock, h, money, replace, replaceIfChanged, toast } from "../dom"
import { icon } from "../icons"
import { poll } from "../poll"
import { button, isLive, runStatus, sectionHead } from "../shared"

const REFRESH_MS = 3000

/** One line of the transcript, or null for bookkeeping nobody needs to read. */
function line(event: RunEvent): HTMLElement | null {
  const p = event.payload || {}
  const text = (value: unknown) => String(value ?? "")
  let body: HTMLElement | null = null
  switch (event.event_type) {
    case "user_message":
      body = h("div", { class: "entry-prompt" }, h("span", { class: "visually-hidden" }, "You said: "), text(p.message))
      break
    case "step":
      if (p.kind === "usage" || p.kind === "delivered") return null
      if (p.kind === "reply") body = h("div", { class: "entry-reply" }, text(p.message))
      else if (p.kind === "prompt") body = h("div", { class: "entry-prompt" }, text(p.message))
      else if (p.kind === "tool")
        body = h(
          "div",
          { class: "entry-tool" },
          text(p.verb),
          " ",
          p.target ? h("code", { class: "code" }, text(p.target)) : null,
          p.status === "failed" ? h("span", { class: "entry-error" }, ` failed: ${text(p.detail)}`) : null,
        )
      else if (p.kind === "error") body = h("div", { class: "entry-error" }, text(p.message))
      else if (p.kind === "approval") body = h("div", { class: "entry-asked" }, text(p.message))
      else body = h("div", { class: "entry-notice" }, text(p.message))
      break
    case "permission_denied":
      body = h(
        "div",
        { class: "entry-refused" },
        text(p.message || `Refused ${text(p.permission)} on ${(p.patterns || []).join(", ")}`),
      )
      break
    case "permission_request":
      body = p.decision
        ? h(
            "div",
            { class: "entry-asked" },
            `Decision on ${text(p.permission)} ${(p.patterns || []).join(", ")}: ${text(p.decision).replace("_", " ")}`,
          )
        : h("div", { class: "entry-asked" }, `Asked to use ${text(p.permission)} on ${(p.patterns || []).join(", ")}`)
      break
    case "summary":
      body = h("div", { class: "entry-notice" }, text(p.message))
      break
    case "error":
      body = h("div", { class: "entry-error" }, text(p.message))
      break
    default:
      return null
  }
  return h("li", {}, h("time", { datetime: event.created_at }, clock(event.created_at)), body)
}

export async function renderRun(main: HTMLElement, agentId: string, runId: string): Promise<() => void> {
  const [agent, initialRun] = await Promise.all([
    api.get<AgentSummary>(`/api/agents/${agentId}`),
    api.get<Run>(`/api/agents/${agentId}/runs/${runId}`),
  ])
  let run = initialRun

  const timeline = h("ol", { class: "timeline", "aria-live": "polite", "aria-label": "Transcript" })
  const header = h("div")
  const statusLine = h("div", { class: "masthead-meta" })
  // A plain-text copy of what is on screen, for pasting into a ticket or a review.
  const exportButton = button("Text transcript (.txt)", {
    icon: "download",
    onclick: () => {
      const lines = [...timeline.querySelectorAll("li")].map((li) => {
        const time = li.querySelector("time")?.textContent ?? ""
        const body = li.querySelector("div")?.textContent ?? ""
        return `${time}  ${body}`.trim()
      })
      const text = [`# ${agent.label} on ${run.hostname ?? "an unnamed machine"}`, `Run ${run.id}, ${run.status}`, "", ...lines, ""].join("\n")
      const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }))
      const a = h("a", { href: url, download: `transcript-${run.id.slice(0, 8)}.txt` })
      a.click()
      URL.revokeObjectURL(url)
    },
  })
  // The complete stored event history as NDJSON: every event in sequence
  // order with timestamps, types and usage, not just the rendered lines.
  const exportNdjson = button("Full history (.ndjson)", {
    icon: "download",
    onclick: async () => {
      try {
        const res = await fetch(`/api/agents/${agentId}/runs/${runId}/export`, { credentials: "same-origin" })
        if (!res.ok) throw new ApiError(res.status, `The server answered ${res.status}.`)
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const disposition = res.headers.get("content-disposition") ?? ""
        const named = disposition.match(/filename="([^"]+)"/)?.[1] ?? `run-${runId.slice(0, 8)}.ndjson`
        const a = h("a", { href: url, download: named })
        a.click()
        URL.revokeObjectURL(url)
      } catch (err) {
        toast(err instanceof ApiError ? err.message : String(err))
      }
    },
  })
  let lastSeq = 0
  let cost = 0
  const placeholder = h("li", {}, h("time"), h("div", { class: "entry-notice" }, "Nothing reported yet."))

  const loadEvents = async () => {
    const events = await api.get<RunEvent[]>(`/api/agents/${agentId}/runs/${runId}/events?after=${lastSeq}`)
    const pinned = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80
    for (const e of events) {
      lastSeq = Math.max(lastSeq, e.seq)
      cost += e.cost_usd ?? 0
      const li = line(e)
      if (li) {
        placeholder.remove()
        timeline.appendChild(li)
      }
    }
    if (events.length && pinned) window.scrollTo({ top: document.body.scrollHeight })
  }

  const stop = button("Stop the agent", { variant: "danger", icon: "stop" })
  stop.addEventListener("click", async () => {
    if (!confirm("Stop this run? The agent is interrupted wherever it is.")) return
    stop.disabled = true
    try {
      await api.post(`/api/agents/${agentId}/runs/${runId}/kill`)
      toast("Stopping. The machine hears it on its next check-in.")
    } catch (err) {
      toast(err instanceof ApiError ? err.message : String(err))
      stop.disabled = false
    }
  })

  const drawHeader = () => {
    const live = isLive(run.status)
    // Rebuilt only when something shown changed, so a refresh never takes
    // focus off the stop button.
    const key = `${run.status}:${run.kill_requested}:${cost.toFixed(4)}`
    if (!replaceIfChanged(header, key, () => [])) return
    replace(
      header,
      h(
        "div",
        { class: "masthead" },
        h(
          "div",
          { class: "masthead-text" },
          h("a", { class: "crumb", href: `#/agents/${agentId}` }, icon("back"), agent.label),
          h("h1", {}, run.hostname ?? "Unnamed machine"),
          statusLine,
        ),
        h("div", { class: "inline" }, exportButton, exportNdjson, live && !run.kill_requested ? stop : null),
      ),
    )
    replace(
      statusLine,
      run.kill_requested && live ? h("span", { class: "status", "data-tone": "warning" }, "Stopping") : runStatus(run.status),
      cost > 0 ? h("span", { class: "hint" }, h("span", { class: "numeral" }, money(cost)), live ? " so far" : " in total") : null,
      run.run_env && run.run_env.platform ? h("span", { class: "tag" }, String(run.run_env.platform)) : null,
    )
  }

  replace(main, header, h("section", { class: "panel" }, sectionHead("Transcript"), timeline))
  await loadEvents()
  drawHeader()
  if (!timeline.childElementCount) timeline.appendChild(placeholder)

  return poll(REFRESH_MS, async () => {
    const wasLive = isLive(run.status)
    run = await api.get<Run>(`/api/agents/${agentId}/runs/${runId}`)
    if (wasLive || isLive(run.status)) await loadEvents()
    drawHeader()
  })
}
