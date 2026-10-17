import { api, ApiError, type Agent, type PaginatedRuns, type PermissionRequest, type Run } from "../api"
import { agoNode, h, money, refreshTimes, replace, replaceIfChanged, toast } from "../dom"
import { icon } from "../icons"
import { poll } from "../poll"
import { button, iconButton, isLive, linkButton, ruleGrid, runStatus, sectionHead } from "../shared"

const REFRESH_MS = 5000

const DECISIONS: Array<{ decision: string; text: string; variant?: "primary" | "danger" }> = [
  { decision: "approved_once", text: "Allow once", variant: "primary" },
  { decision: "approved_run", text: "Allow for this run" },
  { decision: "approved_permanent", text: "Always allow" },
  { decision: "denied", text: "Refuse", variant: "danger" },
]

const REQUEST_VERBS: Record<string, string> = {
  read: "read",
  edit: "change",
  glob: "list files in",
  grep: "search",
  list: "list",
  external_directory: "work outside its directory in",
  bash: "run",
  webfetch: "fetch",
}

/** What is being asked for, as a sentence with the target set apart as code. */
function describeRequest(req: PermissionRequest): { text: string; node: HTMLElement } {
  const verb = REQUEST_VERBS[req.permission] ?? `use ${req.permission} on`
  const target = req.patterns.join(", ") || "(no target given)"
  return { text: `Wants to ${verb} ${target}`, node: h("p", { class: "approval-what" }, `Wants to ${verb} `, h("code", {}, target)) }
}

function stat(label: string, value: string, attention = false) {
  return h(
    "div",
    { class: "stat", "data-tone": attention ? "attention" : null },
    h("span", { class: "micro-label" }, label),
    h("span", { class: "stat-value numeral" }, value),
  )
}

export async function renderDetail(main: HTMLElement, id: string): Promise<() => void> {
  const approvals = h("div", { "aria-live": "polite" })
  const approvalCount = h("span", { class: "micro-label" })
  const runsBody = h("div")
  const band = h("section", { class: "panel" })
  const rulesBody = h("div", { class: "panel-body stack" })
  const seen = new Set<string>()
  let agent = await api.get<Agent>(`/api/agents/${id}`)

  const drawRules = () => replaceIfChanged(rulesBody, JSON.stringify([agent.effective_permissions, agent.use_global_config, agent.rejection_yaml, agent.status]), () => [
    h("p", { class: "hint" }, agent.status === "revoked" ? "This agent is revoked. Its own Access and rejection YAML are shown below." : `Rules for the next run include Access, this agent's rejection YAML${agent.use_global_config ? ", and the saved global config" : ""}. Active runs keep the rules they started with.`),
    ruleGrid(agent.effective_permissions),
  ])

  const drawApprovals = async () => {
    if (agent.permission_mode !== "request" && agent.pending_permission_requests === 0) {
      replace(approvalCount, "")
      replaceIfChanged(approvals, "strict", () => [
        h("p", { class: "panel-body muted" }, "This agent refuses anything outside its rules, so it never asks."),
      ])
      return
    }
    const pending = await api.get<PermissionRequest[]>(`/api/agents/${id}/permission-requests?pending=1`)
    replace(approvalCount, pending.length ? `${pending.length} waiting` : "")
    if (pending.length === 0) {
      replaceIfChanged(approvals, "none", () => [h("p", { class: "panel-body muted" }, "Nothing is waiting on you.")])
      return
    }
    replaceIfChanged(approvals, pending.map((r) => r.id).join(","), () =>
      pending.map((req) =>
        h(
          "article",
          { class: `approval${seen.size && !seen.has(req.id) ? " is-new" : ""}`, "aria-label": describeRequest(req).text },
          describeRequest(req).node,
          h(
            "p",
            { class: "hint" },
            `${req.run_hostname ?? "A machine"}, asked `,
            agoNode(req.created_at),
            ". Refused ",
            agoNode(req.expires_at),
            " if nobody answers.",
          ),
          h(
            "div",
            { class: "actions" },
            ...DECISIONS.map(({ decision, text, variant }) =>
              button(text, {
                variant,
                onclick: async (event) => {
                  const el = event.currentTarget as HTMLButtonElement
                  el.disabled = true
                  try {
                    await api.post(`/api/agents/${id}/permission-requests/${req.id}/decision`, { decision })
                    toast(decision === "denied" ? "Refused" : "Allowed")
                    await refresh()
                  } catch (err) {
                    toast(err instanceof ApiError ? err.message : String(err))
                    el.disabled = false
                  }
                },
              }),
            ),
          ),
        ),
      ),
    )
    for (const req of pending) seen.add(req.id)
  }

  const RUNS_PAGE_SIZE = 20
  let pageIndex = 0
  let pageCursors: Array<string | null> = [null]
  let currentRuns: Run[] = []
  let totalRuns = agent.total_runs ?? agent.runs.filter((r) => r.status !== "pending").length
  let hasMore = false
  let nextCursor: string | null = null

  const loadRunsPage = async (index: number) => {
    const cursor = pageCursors[index]
    const url = `/api/agents/${id}/runs?limit=${RUNS_PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
    const res = await api.get<PaginatedRuns>(url)
    pageIndex = index
    currentRuns = res.runs.filter((r) => r.status !== "pending")
    if (typeof res.total === "number") {
      totalRuns = res.total
    }
    hasMore = res.has_more
    nextCursor = res.next_cursor
    // Replace forward cursor for the current page and discard any beyond
    pageCursors = pageCursors.slice(0, index + 1)
    if (nextCursor) {
      pageCursors.push(nextCursor)
    }
    drawRuns()
  }

  const drawRuns = () => {
    const live = agent.runs.filter((r) => isLive(r.status)).length
    const runs = currentRuns
    const totalRunsCount = totalRuns
    replaceIfChanged(band, `${agent.total_cost_usd}:${agent.total_tokens_in}:${agent.total_tokens_out}:${live}:${totalRunsCount}`, () => [
      h(
        "div",
        { class: "stat-row" },
        stat("Spend", money(agent.total_cost_usd)),
        stat("Runs", String(totalRunsCount)),
        stat("Running now", String(live)),
        stat("Tokens", (agent.total_tokens_in + agent.total_tokens_out).toLocaleString()),
      ),
    ])
    if (pageIndex === 0 && runs.length === 0 && !hasMore) {
      replaceIfChanged(runsBody, "none", () => [h("p", { class: "panel-body muted" }, "No machine has run this agent yet.")])
      return
    }

    const tableRows = runs.map((run) =>
      h(
        "tr",
        {},
        h(
          "td",
          { "data-label": "Machine" },
          h("a", { class: "name-link", href: `#/agents/${id}/runs/${run.id}` }, run.hostname ?? "Unnamed machine"),
        ),
        h(
          "td",
          { "data-label": "Status" },
          run.kill_requested && isLive(run.status)
            ? h("span", { class: "status", "data-tone": "warning" }, "Stopping")
            : runStatus(run.status),
        ),
        h(
          "td",
          { "data-label": "Last heard" },
          h("span", { class: "hint" }, agoNode(run.last_heartbeat_at ?? run.created_at, { "data-heard": run.id })),
        ),
      ),
    )

    const prevBtn = button("Previous", {
      disabled: pageIndex === 0,
      onclick: () => void loadRunsPage(pageIndex - 1),
    })
    const nextBtn = button("Next", {
      disabled: !hasMore,
      onclick: () => void loadRunsPage(pageIndex + 1),
    })

    const paginationBar = (pageIndex > 0 || hasMore)
      ? h(
          "div",
          { class: "pagination-bar" },
          h("div", { class: "pagination-nav" }, prevBtn, h("span", { class: "hint" }, `Page ${pageIndex + 1}`), nextBtn),
          !hasMore ? h("span", { class: "hint" }, "End of run history") : null,
        )
      : h("div", { class: "end-of-history" }, h("span", { class: "hint" }, "End of run history"))

    const key = `${pageIndex}:${hasMore}:${runs.map((r) => `${r.id}:${r.status}:${r.kill_requested}:${r.last_heartbeat_at ? 1 : 0}`).join(",")}`
    replaceIfChanged(runsBody, key, () => [
      h(
        "table",
        { class: "grid-table" },
        h("caption", { class: "visually-hidden" }, "Runs"),
        h("thead", {}, h("tr", {}, h("th", {}, "Machine"), h("th", {}, "Status"), h("th", {}, "Last heard"))),
        h("tbody", {}, ...tableRows),
      ),
      paginationBar,
    ])
    // The table is rebuilt only when a run changes state; when each was last
    // heard changes every beat, so that is updated where it stands.
    for (const run of runs) {
      const heard = runsBody.querySelector<HTMLElement>(`[data-heard="${run.id}"]`)
      if (heard) heard.dataset.ago = run.last_heartbeat_at ?? run.created_at
    }
  }

  const refresh = async () => {
    agent = await api.get<Agent>(`/api/agents/${id}`)
    drawRules()
    const cursor = pageCursors[pageIndex]
    const url = `/api/agents/${id}/runs?limit=${RUNS_PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
    const res = await api.get<PaginatedRuns>(url)
    currentRuns = res.runs.filter((r) => r.status !== "pending")
    if (typeof res.total === "number") {
      totalRuns = res.total
    } else if (typeof agent.total_runs === "number") {
      totalRuns = agent.total_runs
    } else {
      totalRuns = agent.runs.filter((r) => r.status !== "pending").length
    }
    hasMore = res.has_more
    nextCursor = res.next_cursor
    // Replace forward cursor for the current page and discard any beyond
    pageCursors = pageCursors.slice(0, pageIndex + 1)
    if (nextCursor) {
      pageCursors.push(nextCursor)
    }
    drawRuns()
    await drawApprovals()
    refreshTimes(main)
  }

  // ── Install ──
  const commandBox = h("div", { class: "install", "aria-live": "polite" })
  const mint = button("Create install command", { icon: "terminal", variant: "primary", disabled: agent.status === "revoked" })
  mint.addEventListener("click", async () => {
    mint.disabled = true
    try {
      const minted = await api.post<{ command: string; expires_at: string }>(`/api/agents/${id}/install-command`)
      const copy = iconButton("copy", "Copy the install command", async () => {
        try {
          await navigator.clipboard.writeText(minted.command)
          commandBox.querySelector("[data-copy-fallback]")?.remove()
          replace(copy, icon("check"))
          toast("Copied")
        } catch {
          replace(copy, icon("copy"))
          toast("Copy failed — see instructions below.")
          if (!commandBox.querySelector("[data-copy-fallback]")) {
            commandBox.appendChild(
              h(
                "p",
                { class: "hint", "data-copy-fallback": "true" },
                `Clipboard copy failed. Select the command above and press Ctrl+C (or ⌘+C on macOS) before ${new Date(minted.expires_at).toLocaleTimeString()}. To retry copying, reuse this command — only create a new one after this one expires.`,
              ),
            )
          }
        }
      })
      replace(
        commandBox,
        h("div", { class: "well install-well" }, h("pre", { tabindex: 0, "aria-label": "Install command" }, minted.command), copy),
        h(
          "p",
          { class: "hint" },
          `Works once, until ${new Date(minted.expires_at).toLocaleTimeString()}. It carries a credential, so paste it only on the machine that should run the agent.`,
        ),
      )
    } catch (err) {
      toast(err instanceof ApiError ? err.message : String(err))
    } finally {
      mint.disabled = agent.status === "revoked"
    }
  })

  const revoke = iconButton(
    "ban",
    "Revoke this agent",
    async () => {
      if (!confirm(`Revoke ${agent.label}? Every machine running it stops, and its install commands stop working. This cannot be undone.`)) return
      const result = await api.post<{ runs_signaled: number }>(`/api/agents/${id}/revoke`)
      toast(`Revoked. ${result.runs_signaled} machine(s) told to stop.`)
      // Re-rendered through the router, so this view's refresh timer is stopped first.
      window.dispatchEvent(new HashChangeEvent("hashchange"))
    },
    "danger",
  )

  const credentials = [...agent.secrets.flatMap((s) => Object.values(s.key_to_env_var)), ...agent.declared_env_vars]

  replace(
    main,
    h(
      "div",
      { class: "masthead" },
      h(
        "div",
        { class: "masthead-text" },
        h("a", { class: "crumb", href: "#/" }, icon("back"), "Agents"),
        h("h1", {}, agent.label),
        h(
          "div",
          { class: "masthead-meta" },
          h("span", { class: "machine-label" }, `${agent.model_provider}/${agent.model_name}`),
          h("span", { class: "tag" }, agent.os_shell === "macos_zsh" ? "macOS" : "Linux"),
          h("span", { class: "tag" }, agent.status === "revoked" ? "Revoked" : agent.permission_mode === "request" ? "Asks first" : "Strict"),
          agent.interactive ? h("span", { class: "tag" }, "Interactive") : null,
          agent.location_label ? h("span", { class: "hint" }, agent.location_label) : null,
        ),
      ),
      agent.status === "revoked" ? null : h("div", { class: "inline" }, linkButton("Edit", `#/agents/${id}/edit`, "pencil"), revoke),
    ),
    band,
    h(
      "div",
      { class: "columns spaced" },
      h(
        "div",
        { class: "stack" },
        h(
          "section",
          { class: "panel" },
          sectionHead("Install on a machine"),
          h(
            "div",
            { class: "panel-body install" },
            h("p", { class: "muted" }, "Run the command in the directory the agent should work in. The machine needs Node.js 18 or newer."),
            h("div", {}, mint),
            commandBox,
          ),
        ),
        h("section", { class: "panel" }, sectionHead("Rules"), rulesBody),
        h(
          "section",
          { class: "panel" },
          sectionHead("Task"),
          h(
            "div",
            { class: "panel-body stack" },
            h("p", { class: "entry-reply" }, agent.task),
            credentials.length
              ? h(
                  "div",
                  { class: "field" },
                  h("span", { class: "micro-label" }, "Credentials on the machine"),
                  h("span", { class: "machine-label" }, credentials.join(", ")),
                )
              : null,
          ),
        ),
      ),
      h(
        "div",
        { class: agent.runs.length ? "stack lead" : "stack" },
        h("section", { class: "panel" }, sectionHead("Waiting on you", approvalCount), approvals),
        h("section", { class: "panel" }, sectionHead("Runs"), runsBody),
      ),
    ),
  )
  await loadRunsPage(0)
  drawRules()
  drawRuns()
  await drawApprovals()
  return poll(REFRESH_MS, refresh)
}
