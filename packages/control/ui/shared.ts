import type { Rule } from "./api"
import { h } from "./dom"
import { icon, type IconName } from "./icons"

const LIVE = new Set(["handshaked", "running"])

export function isLive(status: string | null): boolean {
  return status !== null && LIVE.has(status)
}

export const STATUS: Record<string, [string, string]> = {
  pending: ["Waiting to install", "neutral"],
  handshaked: ["Starting", "info"],
  running: ["Running", "success"],
  succeeded: ["Finished", "neutral"],
  idle_timeout: ["Went quiet", "warning"],
  failed: ["Failed", "error"],
  killed: ["Stopped", "error"],
  budget_exceeded: ["Budget Exceeded", "warning"],
  unpriced_usage_halt: ["Unpriced Usage Halt", "warning"],
}

/** A run's state: a tone dot and a mono label. */
export function runStatus(status: string | null): HTMLElement {
  if (!status) return h("span", { class: "status" }, "Never run")
  const [text, tone] = STATUS[status] ?? [status, "neutral"]
  return h("span", { class: "status", "data-tone": tone }, text)
}

export interface ButtonOptions {
  icon?: IconName
  variant?: "primary" | "danger" | "ghost"
  type?: "button" | "submit"
  disabled?: boolean
  onclick?: (event: Event) => void
}

export function button(label: string, options: ButtonOptions = {}): HTMLButtonElement {
  const el = h(
    "button",
    {
      type: options.type ?? "button",
      class: `btn${options.variant ? ` btn-${options.variant}` : ""}`,
      disabled: options.disabled,
    },
    options.icon ? icon(options.icon) : null,
    label,
  )
  if (options.onclick) el.addEventListener("click", options.onclick)
  return el
}

/** An icon-only control, named by its label for screen readers and its tooltip for everyone. */
export function iconButton(name: IconName, label: string, onclick: (event: Event) => void, variant?: "danger" | "ghost") {
  const el = h(
    "button",
    { type: "button", class: `btn icon-btn${variant ? ` btn-${variant}` : ""}`, "aria-label": label, title: label },
    icon(name),
  )
  el.addEventListener("click", onclick)
  return el
}

export function linkButton(label: string, href: string, name?: IconName, primary = false) {
  return h("a", { class: `btn${primary ? " btn-primary" : ""}`, href }, name ? icon(name) : null, label)
}

/** The four groups a rule can belong to. */
export const RULE_GROUPS = [
  { id: "paths", title: "Paths", empty: "No paths. The agent can only read what you send it." },
  { id: "commands", title: "Commands", empty: "No commands. The agent cannot run anything." },
  { id: "urls", title: "URLs the agent may fetch", empty: "No URLs. The agent cannot fetch anything." },
  { id: "never", title: "Never allowed", empty: "Nothing explicitly refused." },
] as const

export type RuleGroupId = (typeof RULE_GROUPS)[number]["id"]

export function groupOf(rule: Rule): RuleGroupId {
  if (rule.effect === "deny") return "never"
  if (rule.kind === "bash_command") return "commands"
  if (rule.kind === "webfetch_host") return "urls"
  return "paths"
}

export function accessText(rule: Rule): string {
  if (rule.effect === "deny") return rule.kind === "filesystem" ? "path" : rule.kind === "bash_command" ? "command" : "url"
  if (rule.kind === "filesystem") return rule.access === "write" ? "read, write" : "read"
  return ""
}

export function ruleChip(rule: Rule, onRemove?: () => void): HTMLElement {
  const access = accessText(rule)
  return h(
    "span",
    { class: "chip", "data-tone": rule.effect === "deny" ? "deny" : "allow", "data-readonly": onRemove ? null : "true" },
    h("span", { class: "chip-text" }, rule.path_pattern),
    access ? h("span", { class: "chip-access" }, access) : null,
    onRemove
      ? (() => {
          const remove = h("button", { type: "button", "aria-label": `Remove ${rule.path_pattern}`, title: "Remove" }, icon("x"))
          remove.addEventListener("click", onRemove)
          return remove
        })()
      : null,
  )
}

/** A whole permission set, read-only, two by two. */
export function ruleGrid(rules: Rule[]): HTMLElement {
  return h(
    "div",
    { class: "rule-grid" },
    ...RULE_GROUPS.map((group) => {
      const items = rules.filter((r) => groupOf(r) === group.id)
      return h(
        "div",
        { class: "rule-group" },
        h("span", { class: "micro-label" }, group.title),
        items.length ? h("div", { class: "chips" }, ...items.map((r) => ruleChip(r))) : h("span", { class: "empty-line" }, group.empty),
      )
    }),
  )
}

export function sectionHead(title: string, ...right: Array<Node | string | null>): HTMLElement {
  return h("div", { class: "section-head" }, h("h2", { class: "micro-label" }, title), h("div", { class: "inline" }, ...right))
}
