import { MODEL_PROVIDERS, type ModelProviderId } from "../../src/model-providers"
import type { ModelOption } from "../../src/model-catalog"
import { defaultDenyRules, isBashGateway } from "../../src/policy"
import { api, ApiError, MAX_YAML_LENGTH, type Agent, type GlobalConfig, type Rule, type Secret } from "../api"
import { h, replace, toast } from "../dom"
import { icon, type IconName } from "../icons"
import { select, type SelectOption } from "../select"
import { button, groupOf, iconButton, ruleChip, RULE_GROUPS, type RuleGroupId } from "../shared"

const SECRET_STORES: SelectOption<Secret["provider"]>[] = [
  { value: "aws", label: "AWS Secrets Manager" },
  { value: "gcp", label: "GCP Secret Manager" },
  { value: "vault", label: "HashiCorp Vault" },
  { value: "env", label: "Machine environment" },
]

const SECRET_HINT: Record<Secret["provider"], string> = {
  aws: "arn:aws:secretsmanager:us-east-1:123456789012:secret:name",
  gcp: "projects/my-project/secrets/name",
  vault: "team/app",
  env: "EXISTING_VARIABLE",
}

/** Settings a store needs beyond the reference, as [field, placeholder, accessible name]. */
const STORE_SETTINGS: Partial<Record<Secret["provider"], Array<[string, string, string]>>> = {
  gcp: [
    ["project", "Project id (or a full projects/... name)", "GCP project id"],
    ["version", "Version (default: latest)", "Secret version"],
  ],
  vault: [
    ["address", "Address, e.g. https://vault.internal:8200", "Vault address"],
    ["mount", "KV mount (default: secret)", "Vault KV mount"],
    ["role", "Kubernetes role (without VAULT_TOKEN)", "Vault Kubernetes auth role"],
  ],
}

type Mapping = { jsonKey: string; envVar: string }
type SecretDraft = { provider: Secret["provider"]; reference: string; config: Record<string, string>; mappings: Mapping[] }

const emptySecret = (): SecretDraft => ({ provider: "aws", reference: "", config: {}, mappings: [{ jsonKey: "", envVar: "" }] })

/** Only the settings the chosen store reads, without blanks. */
function storeConfig(draft: SecretDraft): Record<string, string> {
  const fields = (STORE_SETTINGS[draft.provider] ?? []).map(([field]) => field)
  return Object.fromEntries(fields.flatMap((f) => (draft.config[f]?.trim() ? [[f, draft.config[f].trim()]] : [])))
}

const price = (m: ModelOption) => `$${m.cost_input} in, $${m.cost_output} out per 1M`

function row(label: string, hint: string, ...controls: Array<Node | null>) {
  return h(
    "div",
    { class: "form-row" },
    h("div", { class: "form-label" }, h("span", { class: "form-label-text" }, label), h("span", { class: "hint" }, hint)),
    h("div", { class: "form-control" }, ...controls),
  )
}

/** A row with one control, which is named by the row's label and described by its hint. */
function fieldRow(label: string, hint: string, control: HTMLInputElement | HTMLTextAreaElement) {
  const hintId = `${control.id}-hint`
  control.setAttribute("aria-describedby", hintId)
  return h(
    "div",
    { class: "form-row" },
    h(
      "div",
      { class: "form-label" },
      h("label", { class: "form-label-text", for: control.id }, label),
      h("span", { class: "hint", id: hintId }, hint),
    ),
    h("div", { class: "form-control" }, control),
  )
}

function segmented<T extends string>(
  name: string,
  label: string,
  value: T,
  options: Array<{ value: T; text: string; icon?: IconName; sub?: string }>,
  onChange: (v: T) => void,
) {
  return h(
    "div",
    { class: "segmented", role: "radiogroup", "aria-label": label },
    ...options.map((o) => {
      const input = h("input", { type: "radio", name, value: o.value, checked: o.value === value })
      input.addEventListener("change", () => onChange(o.value))
      return h(
        "label",
        { class: "segment" },
        input,
        o.icon ? icon(o.icon) : null,
        o.text,
        o.sub ? h("span", { class: "machine-label" }, o.sub) : null,
      )
    }),
  )
}

export async function renderForm(main: HTMLElement, agentId?: string) {
  const agent = agentId ? await api.get<Agent>(`/api/agents/${agentId}`) : null
  const editing = agent !== null
  let globalConfig = await api.get<GlobalConfig>("/api/config/global")
  const dirtyDefaults = new Set<keyof GlobalConfig["document"]["defaults"]>()

  // New agents start with the standard refusals as real, editable rules.
  let rules: Rule[] = agent ? [...agent.permissions] : defaultDenyRules().map((r) => ({ ...r }))
  let secrets: SecretDraft[] = (agent?.secrets ?? []).map((s) => ({
    provider: s.provider,
    reference: s.reference,
    config: Object.fromEntries(Object.entries(s.provider_config).map(([k, v]) => [k, String(v)])),
    mappings: Object.entries(s.key_to_env_var).map(([jsonKey, envVar]) => ({ jsonKey, envVar })),
  }))
  let osShell = agent?.os_shell ?? "linux_bash"
  let mode: "strict" | "request" = agent?.permission_mode ?? "strict"
  let interactive = agent?.interactive ?? false

  // ── Identity ──
  const name = h("input", { id: "agent-name", class: "input", maxlength: 255, value: agent?.label ?? "", placeholder: "e.g. nginx-log-triage", autocomplete: "off" })
  const task = h(
    "textarea",
    { id: "agent-task", class: "input", maxlength: 20000, placeholder: "e.g. Read the nginx error logs in ./logs and write a summary of the top failures to ./out/summary.md" },
    agent?.task ?? "",
  )
  const where = h("input", { class: "input", maxlength: 120, value: agent?.location_label ?? "", placeholder: "Location, e.g. prod bastion", "aria-label": "Where the machine is (optional)" })
  const osControl = segmented(
    "os",
    "Operating system",
    osShell as "linux_bash" | "macos_zsh",
    [
      { value: "linux_bash", text: "Linux", icon: "terminal", sub: "bash" },
      { value: "macos_zsh", text: "macOS", icon: "monitor", sub: "zsh" },
    ],
    (v) => { osShell = v; dirtyDefaults.add("os_shell") },
  )
  if (editing) osControl.querySelectorAll("input").forEach((i) => ((i as HTMLInputElement).disabled = true))

  const rejection = h("textarea", { id: "agent-rejection-yaml", class: "input input-mono", rows: 8, maxlength: MAX_YAML_LENGTH, spellcheck: "false", placeholder: "version: 1\npermissions:\n  - path_pattern: ./secrets\n    kind: filesystem\n    access: read\n    effect: deny\n" }, agent?.rejection_yaml ?? "")
  const useGlobal = h("input", { type: "checkbox", checked: agent?.use_global_config ?? false })
  const globalNote = h("p", { class: "hint", role: "status" })
  const globalPreview = h("pre", { class: "well", tabindex: 0, "aria-label": "Saved global YAML" }, globalConfig.yaml)
  const drawGlobalNote = () => {
    replace(globalNote, useGlobal.checked
      ? `Using revision ${globalConfig.revision}: ${globalConfig.document.permissions.length} shared permission rules. ${editing ? "Existing agent values are kept." : "Defaults fill fields you have not edited."}`
      : "Global config is not selected. This agent uses its own settings and rules.")
    replace(globalPreview, globalConfig.yaml)
  }
  const reloadGlobal = button("Reload global config", { onclick: async () => {
    reloadGlobal.disabled = true
    try {
      globalConfig = await api.get<GlobalConfig>("/api/config/global")
      applyGlobalDefaults()
      drawGlobalNote()
      refreshGateways()
    } catch (failure) {
      toast(failure instanceof ApiError ? failure.message : "Could not reload global config. Try again.")
    } finally {
      reloadGlobal.disabled = false
    }
  } })

  // ── Access ──
  const ackGateways = h("input", { type: "checkbox" })
  const gatewayNotice = h("div", { class: "notice", hidden: true })
  const ackField = h(
    "label",
    { class: "check", hidden: true },
    ackGateways,
    "I understand these commands can run anything, so the path rules no longer contain the agent.",
  )
  const groupLists = new Map<RuleGroupId, HTMLElement>()

  const refreshGateways = () => {
    const combined = [...rules, ...(useGlobal.checked ? globalConfig.document.permissions : [])]
    const gateways = combined.filter((r) => r.kind === "bash_command" && r.effect === "allow" && isBashGateway(r.path_pattern))
    gatewayNotice.hidden = ackField.hidden = gateways.length === 0
    replace(
      gatewayNotice,
      h("strong", {}, "These commands can run other commands: "),
      gateways.map((g) => g.path_pattern).join(", "),
      ". The engine checks every command it can see, but not what an interpreter runs, so allowing one makes the path rules advisory.",
    )
  }

  const drawGroup = (id: RuleGroupId) => {
    const list = groupLists.get(id)!
    const items = rules.filter((r) => groupOf(r) === id)
    const empty = RULE_GROUPS.find((g) => g.id === id)!.empty
    replace(
      list,
      ...(items.length
        ? items.map((r) =>
            ruleChip(r, () => {
              rules = rules.filter((x) => x !== r)
              drawGroup(id)
              refreshGateways()
            }),
          )
        : [h("span", { class: "empty-line" }, empty)]),
    )
  }

  const addRule = (rule: Rule) => {
    const pattern = rule.path_pattern.trim()
    if (!pattern) return false
    const exists = rules.some(
      (r) => r.path_pattern === pattern && r.kind === rule.kind && r.effect === rule.effect && r.access === rule.access,
    )
    if (!exists) rules = [...rules, { ...rule, path_pattern: pattern }]
    drawGroup(groupOf(rule))
    refreshGateways()
    return true
  }

  const ruleGroupEditor = (id: RuleGroupId) => {
    const group = RULE_GROUPS.find((g) => g.id === id)!
    const input = h("input", { class: "input input-mono", "aria-label": `Add to ${group.title}` })
    let access: Rule["access"] = "read"
    let denyKind: Rule["kind"] = "filesystem"
    const extra =
      id === "paths"
        ? select<Rule["access"]>({
            label: "Access",
            value: access,
            options: [
              { value: "read", label: "Read" },
              { value: "write", label: "Read and write" },
            ],
            onChange: (v) => (access = v),
          }).el
        : id === "never"
          ? select<Rule["kind"]>({
              label: "Kind",
              value: denyKind,
              options: [
                { value: "filesystem", label: "Path" },
                { value: "bash_command", label: "Command" },
                { value: "webfetch_host", label: "URL" },
              ],
              onChange: (v) => (denyKind = v),
            }).el
          : null
    input.placeholder = { paths: "./logs", commands: "git status", urls: "https://api.github.com/*", never: "./secrets" }[id]
    const add = () => {
      const rule: Rule =
        id === "paths"
          ? { path_pattern: input.value, kind: "filesystem", access, effect: "allow" }
          : id === "commands"
            ? { path_pattern: input.value, kind: "bash_command", access: "read", effect: "allow" }
            : id === "urls"
              ? { path_pattern: input.value, kind: "webfetch_host", access: "read", effect: "allow" }
              : { path_pattern: input.value, kind: denyKind, access: "read", effect: "deny" }
      if (addRule(rule)) input.value = ""
      input.focus()
    }
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault()
        add()
      }
    })
    const list = h("div", { class: "chips" })
    groupLists.set(id, list)
    return h(
      "div",
      { class: "rule-group" },
      h("span", { class: "micro-label" }, group.title),
      h("div", { class: "inline" }, input, extra, iconButton("plus", `Add to ${group.title}`, add)),
      list,
    )
  }

  const ruleGrid = h("div", { class: "rule-grid" }, ...RULE_GROUPS.map((g) => ruleGroupEditor(g.id)))

  // ── Secrets ──
  const secretRows = h("div", { class: "stack" })
  const textInput = (value: string, placeholder: string, label: string, onInput: (v: string) => void, mono = true) => {
    const el = h("input", { class: `input${mono ? " input-mono" : ""}`, value, placeholder, "aria-label": label, autocomplete: "off" })
    el.addEventListener("input", () => onInput(el.value))
    return el
  }
  // Redrawing replaces the controls, so focus is put back where the person was working.
  const drawSecrets = (focusLabel?: string) => {
    replace(
      secretRows,
      ...secrets.map((s, n) => {
        const store = select<Secret["provider"]>({
          label: `Secret ${n + 1} store`,
          value: s.provider,
          options: SECRET_STORES,
          onChange: (v) => {
            // A reference means something different in each store.
            s.provider = v
            s.reference = ""
            s.config = {}
            drawSecrets(`Secret ${n + 1} store`)
          },
        })
        const settings = STORE_SETTINGS[s.provider] ?? []
        return h(
          "div",
          { class: "well secret" },
          h(
            "div",
            { class: "inline" },
            store.el,
            textInput(s.reference, SECRET_HINT[s.provider], `Secret ${n + 1} reference`, (v) => (s.reference = v)),
            iconButton("x", `Remove secret ${n + 1}`, () => ((secrets = secrets.filter((x) => x !== s)), drawSecrets(), addSecret.focus()), "ghost"),
          ),
          settings.length
            ? h(
                "div",
                { class: "inline" },
                ...settings.map(([field, placeholder, label]) =>
                  textInput(s.config[field] ?? "", placeholder, label, (v) => (s.config[field] = v), false),
                ),
              )
            : null,
          h("span", { class: "micro-label" }, "Keys to variables"),
          ...s.mappings.map((m, k) =>
            h(
              "div",
              { class: "secret-mapping" },
              textInput(m.jsonKey, "JSON key, e.g. password", `Secret ${n + 1} key ${k + 1}`, (v) => (m.jsonKey = v)),
              h("span", { class: "hint", "aria-hidden": "true" }, "to"),
              textInput(m.envVar, "ENV_VAR", `Secret ${n + 1} variable ${k + 1}`, (v) => (m.envVar = v)),
              s.mappings.length > 1
                ? iconButton("x", `Remove key ${k + 1}`, () => ((s.mappings = s.mappings.filter((x) => x !== m)), drawSecrets(`Secret ${n + 1} key 1`)), "ghost")
                : null,
            ),
          ),
          h(
            "div",
            {},
            button("Add a key", {
              icon: "plus",
              variant: "ghost",
              onclick: () => {
                s.mappings = [...s.mappings, { jsonKey: "", envVar: "" }]
                drawSecrets(`Secret ${n + 1} key ${s.mappings.length}`)
              },
            }),
          ),
        )
      }),
    )
    if (focusLabel) secretRows.querySelector<HTMLElement>(`[aria-label="${focusLabel}"]`)?.focus()
  }
  const addSecret = button("Add a secret", {
    icon: "plus",
    variant: "ghost",
    onclick: () => {
      secrets = [...secrets, emptySecret()]
      drawSecrets(`Secret ${secrets.length} store`)
    },
  })
  const envVars = h("input", { class: "input input-mono", value: (agent?.declared_env_vars ?? []).join(", "), placeholder: "AWS_PROFILE, GITHUB_TOKEN", "aria-label": "Variables already set on the machine" })

  // ── Model ──
  let modelProvider: ModelProviderId = (agent?.model_provider as ModelProviderId | undefined) ?? "anthropic"
  let modelName = agent?.model_name ?? ""
  let catalogRequest = 0
  const providerSelect = select<ModelProviderId>({
    label: "Model provider",
    value: modelProvider,
    options: MODEL_PROVIDERS.map((p) => ({ value: p.id, label: p.label })),
    onChange: (v) => {
      modelProvider = v
      dirtyDefaults.add("model_provider")
      dirtyDefaults.add("model_name")
      // Model ids are not shared across providers, so the old pick cannot carry over.
      modelName = ""
      void loadModels()
    },
  })
  const modelSelect = select<string>({
    label: "Model",
    value: modelName,
    options: [],
    onChange: (v) => {
      modelName = v
      dirtyDefaults.add("model_provider")
      dirtyDefaults.add("model_name")
      refreshFooter()
    },
    placeholder: "Loading models",
    searchable: true,
    searchPlaceholder: "Search models",
  })
  modelSelect.el.classList.add("select-grow")
  // Used when the catalog cannot be reached, so a server with no internet still works.
  const modelTyped = h("input", { class: "input input-mono", placeholder: "Model id", "aria-label": "Model", autocomplete: "off", hidden: true })
  modelTyped.addEventListener("input", () => {
    modelName = modelTyped.value.trim()
    refreshFooter()
  })
  const modelNote = h("p", { class: "hint", hidden: true })

  const loadModels = async () => {
    const request = ++catalogRequest
    modelSelect.setDisabled(true)
    modelSelect.setOptions([], "")
    modelSelect.setPlaceholder("Loading models")
    refreshFooter()
    try {
      const { models } = await api.get<{ models: ModelOption[] }>(`/api/models?provider=${encodeURIComponent(modelProvider)}`)
      if (request !== catalogRequest) return
      const options: SelectOption[] = models.map((m) => ({ value: m.id, label: m.name, detail: price(m) }))
      // An agent saved with a model the catalog has since dropped keeps it, labelled as such.
      if (modelName && !options.some((o) => o.value === modelName)) options.unshift({ value: modelName, label: modelName, detail: "not in the catalog" })
      if (!modelName) modelName = options[0]?.value ?? ""
      modelSelect.setOptions(options, modelName)
      modelSelect.setPlaceholder(options.length ? "Choose a model" : "No priced models for this provider")
      modelSelect.setDisabled(options.length === 0)
      modelSelect.el.hidden = false
      modelTyped.hidden = modelNote.hidden = true
    } catch (err) {
      if (request !== catalogRequest) return
      modelSelect.el.hidden = true
      modelTyped.hidden = modelNote.hidden = false
      modelTyped.value = modelName
      replace(modelNote, err instanceof ApiError ? err.message : String(err))
    }
    refreshFooter()
  }

  const key = h("input", {
    class: "input input-mono",
    type: "password",
    autocomplete: "off",
    "aria-label": "API key for this model",
    placeholder: editing && agent.has_llm_api_key ? "Leave blank to keep the stored key" : "API key for this model",
  })
  const clearKey = h("input", { type: "checkbox" })

  // ── Behaviour ──
  const timeout = h("input", { class: "input input-narrow", type: "number", min: 0.5, max: 1440, step: "any", value: (agent?.permission_request_timeout_seconds ?? 900) / 60, "aria-label": "Minutes to wait" })
  const timeoutRow = h("label", { class: "inline hint" }, "Refuse after", timeout, "minutes if nobody answers")
  timeoutRow.hidden = mode !== "request"
  const modeNote = h("p", { class: "segment-note" })
  const drawModeNote = () =>
    replace(
      modeNote,
      mode === "request"
        ? "The agent waits while you approve or refuse it here, then carries on."
        : "Anything outside the rules is refused on the spot. The agent works around it or reports back.",
    )
  const runNote = h("p", { class: "segment-note" })
  const drawRunNote = () =>
    replace(
      runNote,
      interactive
        ? "Whoever runs the install command works with the agent in their terminal."
        : "Runs unattended and reports back here. Nothing to watch.",
    )

  // ── Spending limit ──
  const spendLimit = h("input", {
    id: "agent-spend-limit",
    class: "input input-mono input-narrow",
    type: "number",
    min: "0.01",
    max: "100000",
    step: "any",
    placeholder: "No limit",
    value: agent?.spend_limit_usd != null ? String(agent.spend_limit_usd) : "",
    "aria-label": "Spending limit in USD",
  })
  const validateSpendLimit = () => {
    const raw = spendLimit.value.trim()
    if (!raw) return null
    const val = Number(raw)
    if (!Number.isFinite(val) || val <= 0) return "Spending limit must be greater than $0."
    if (val > 100_000) return "Spending limit cannot exceed $100,000."
    return null
  }

  // ── Footer ──
  const missing = h("span", { class: "hint" })
  const submit = button(editing ? "Save changes" : "Deploy agent", { type: "submit", variant: "primary", icon: editing ? "check" : "send" })
  const errorBox = h("div", { class: "notice", "data-tone": "error", role: "alert", hidden: true })
  const whatsMissing = () => {
    if (!name.value.trim()) return "Name the agent to deploy it."
    if (!task.value.trim()) return "Describe the task to deploy it."
    if (!modelName) return "Choose a model to deploy it."
    if (!editing && !key.value) return "Add the provider's API key to deploy it."
    const limitError = validateSpendLimit()
    if (limitError) return limitError
    return editing ? "Changes apply from the next run." : "Ready. You get an install command next."
  }
  const refreshFooter = () => {
    const note = whatsMissing()
    replace(missing, note)
    submit.disabled = note.endsWith("to deploy it.") || note.startsWith("Spending limit")
  }
  for (const el of [name, task, key, spendLimit]) el.addEventListener("input", refreshFooter)
  for (const [element, field] of [
    [task, "task"],
    [where, "location_label"],
    [envVars, "declared_env_vars"],
    [timeout, "permission_request_timeout_seconds"],
    [spendLimit, "spend_limit_usd"],
  ] as const) {
    element.addEventListener("input", () => dirtyDefaults.add(field))
  }
  modelTyped.addEventListener("input", () => { dirtyDefaults.add("model_provider"); dirtyDefaults.add("model_name") })

  const applyGlobalDefaults = () => {
    if (editing) return
    const defaults = useGlobal.checked ? globalConfig.document.defaults : {}
    if (!dirtyDefaults.has("task")) task.value = defaults.task ?? ""
    if (!dirtyDefaults.has("location_label")) where.value = defaults.location_label ?? ""
    if (!dirtyDefaults.has("os_shell")) osShell = defaults.os_shell ?? "linux_bash"
    if (!dirtyDefaults.has("interactive")) interactive = defaults.interactive ?? false
    if (!dirtyDefaults.has("permission_mode")) mode = defaults.permission_mode ?? "strict"
    if (!dirtyDefaults.has("permission_request_timeout_seconds")) timeout.value = String((defaults.permission_request_timeout_seconds ?? 900) / 60)
    if (!dirtyDefaults.has("declared_env_vars")) envVars.value = (defaults.declared_env_vars ?? []).join(", ")
    if (!dirtyDefaults.has("spend_limit_usd")) {
      spendLimit.value = defaults.spend_limit_usd != null ? String(defaults.spend_limit_usd) : ""
    }
    if (!dirtyDefaults.has("model_provider")) {
      modelProvider = defaults.model_provider ?? "anthropic"
      providerSelect.setOptions(MODEL_PROVIDERS.map((p) => ({ value: p.id, label: p.label })), modelProvider)
    }
    if (!dirtyDefaults.has("model_name")) {
      modelName = !defaults.model_provider || defaults.model_provider === modelProvider ? defaults.model_name ?? "" : ""
      modelTyped.value = modelName
    }
    for (const [group, value] of [["os", osShell], ["run", interactive ? "tui" : "headless"], ["mode", mode]]) {
      form.querySelectorAll<HTMLInputElement>(`input[name="${group}"]`).forEach((input) => { input.checked = input.value === value })
    }
    timeoutRow.hidden = mode !== "request"
    drawModeNote()
    drawRunNote()
    void loadModels()
    refreshFooter()
  }
  useGlobal.addEventListener("change", () => { applyGlobalDefaults(); drawGlobalNote(); refreshGateways() })

  const form = h(
    "form",
    { class: "panel", novalidate: true },
    h("div", { class: "section-head" }, h("h2", { class: "micro-label" }, editing ? "Edit agent" : "New agent")),
    fieldRow("Name", "How it shows in the fleet list.", name),
    fieldRow("Task", "The first thing the agent is told. Mention real paths and add matching access below.", task),
    row("Runs on", "Decides the shape of the install command.", h("div", { class: "inline" }, osControl, where)),
    fieldRow("Rejection YAML", "Optional deny rules for this agent only. Use version: 1 and permissions with effect: deny. The same specificity rules as Access apply; this YAML cannot grant access.", rejection),
    row("Global config", "Choose whether this agent inherits the saved global permission rules. Defaults apply only when creating an agent.",
      h("label", { class: "check" }, useGlobal, "Use global config for this agent"), globalNote,
      h("div", { class: "inline" }, h("a", { class: "btn btn-ghost", href: "#/config", target: "_blank", rel: "noopener" }, "Edit global config"), reloadGlobal),
      h("details", {}, h("summary", {}, "View saved global YAML"), globalPreview),
    ),
    row(
      "Access",
      "Nothing is allowed unless it is listed. A more specific rule beats a broader one, and paths are relative to where the install command runs.",
      ruleGrid,
      gatewayNotice,
      ackField,
    ),
    row(
      "Secrets",
      "Optional. The machine fetches them with its own identity. Only the reference is stored here, never the value.",
      secretRows,
      h("div", {}, addSecret),
      h("span", { class: "micro-label" }, "Already set on the machine"),
      envVars,
    ),
    row(
      "Model",
      "Billed to your own provider key. It is encrypted before it is stored and never shown again.",
      h("div", { class: "inline" }, providerSelect.el, modelSelect.el, modelTyped),
      modelNote,
      key,
      editing && agent.has_llm_api_key ? h("label", { class: "check" }, clearKey, "Remove the stored key") : null,
    ),
    row(
      "Spending limit",
      "Optional guardrail in USD per run. Reaching the threshold stops further provider turns.",
      h("div", { class: "inline" }, h("span", { class: "micro-label" }, "$"), spendLimit),
      h(
        "p",
        { class: "hint" },
        "Spending is checked at provider-step boundaries. An already-running provider step may incur additional cost before termination takes effect, so actual spend can exceed this threshold.",
      ),
    ),
    row(
      "Behaviour",
      "How the agent runs, and what happens at the edge of its rules.",
      h(
        "div",
        { class: "choice-grid" },
        h(
          "div",
          { class: "field" },
          h("span", { class: "micro-label" }, "Run mode"),
          segmented(
            "run",
            "Run mode",
            interactive ? "tui" : "headless",
            [
              { value: "headless", text: "Headless" },
              { value: "tui", text: "Interactive (TUI)" },
            ],
            (v) => {
              interactive = v === "tui"
              dirtyDefaults.add("interactive")
              drawRunNote()
            },
          ),
          runNote,
        ),
        h(
          "div",
          { class: "field" },
          h("span", { class: "micro-label" }, "When something isn't allowed"),
          segmented(
            "mode",
            "When something isn't allowed",
            mode,
            [
              { value: "strict", text: "Refuse", icon: "shield" },
              { value: "request", text: "Ask me", icon: "hand" },
            ],
            (v) => {
              mode = v
              dirtyDefaults.add("permission_mode")
              timeoutRow.hidden = mode !== "request"
              drawModeNote()
            },
          ),
          modeNote,
          timeoutRow,
        ),
      ),
    ),
    h("div", { class: "form-row", hidden: true }, errorBox),
    h(
      "div",
      { class: "form-footer" },
      missing,
      h("div", { class: "inline" }, editing ? h("a", { class: "btn btn-ghost", href: `#/agents/${agent.id}` }, "Cancel") : null, submit),
    ),
  )
  const errorRow = errorBox.parentElement!

  form.addEventListener("submit", async (event) => {
    event.preventDefault()
    if (submit.disabled) return
    errorRow.hidden = true
    errorBox.hidden = true
    const rawLimit = spendLimit.value.trim()
    if (rawLimit) {
      const parsedLimit = Number(rawLimit)
      if (!Number.isFinite(parsedLimit) || parsedLimit <= 0 || parsedLimit > 100_000) {
        errorRow.hidden = false
        errorBox.hidden = false
        replace(errorBox, "Spending limit must be a positive number up to $100,000.")
        errorRow.scrollIntoView({ block: "center" })
        refreshFooter()
        return
      }
    }
    const spendLimitUsd = rawLimit ? Number(rawLimit) : null
    const secretsOut: Secret[] = secrets.flatMap((s) => {
      const mappings = s.mappings.filter((m) => m.envVar.trim())
      if (!s.reference.trim() || mappings.length === 0) return []
      return [
        {
          provider: s.provider,
          reference: s.reference.trim(),
          key_to_env_var: Object.fromEntries(mappings.map((m) => [m.jsonKey.trim() || m.envVar.trim(), m.envVar.trim()])),
          provider_config: storeConfig(s),
        },
      ]
    })
    const fields = {
      label: name.value.trim(),
      location_label: where.value.trim() || null,
      task: task.value.trim(),
      model_provider: modelProvider,
      model_name: modelName,
      ...(key.value ? { llm_api_key: key.value } : {}),
      interactive,
      permission_mode: mode,
      permission_request_timeout_seconds: Math.round(Math.max(0.5, Number(timeout.value) || 15) * 60),
      declared_env_vars: envVars.value
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
      spend_limit_usd: spendLimitUsd,
      secrets: secretsOut,
      rejection_yaml: rejection.value,
      use_global_config: useGlobal.checked,
      permissions: rules,
      acknowledge_bash_gateways: ackGateways.checked,
    }
    submit.disabled = true
    try {
      if (editing) {
        await api.patch(`/api/agents/${agent.id}`, { ...fields, ...(clearKey.checked ? { clear_llm_api_key: true } : {}) })
        toast("Changes saved. They apply from the next run.")
        window.location.hash = `#/agents/${agent.id}`
      } else {
        const created = await api.post<Agent>("/api/agents", {
          ...fields,
          os_shell: osShell,
          // The standard refusals are already in the list above, where they can be edited.
          seed_default_denies: false,
        })
        toast("Agent deployed. Create its install command next.")
        window.location.hash = `#/agents/${created.id}`
      }
    } catch (err) {
      errorRow.hidden = false
      errorBox.hidden = false
      replace(errorBox, err instanceof ApiError ? err.message : String(err))
      errorRow.scrollIntoView({ block: "center" })
      refreshFooter()
    }
  })

  for (const g of RULE_GROUPS) drawGroup(g.id)
  refreshGateways()
  drawGlobalNote()
  drawSecrets()
  void loadModels()
  drawModeNote()
  drawRunNote()
  refreshFooter()

  replace(
    main,
    h(
      "div",
      { class: "masthead" },
      h(
        "div",
        { class: "masthead-text" },
        editing ? h("a", { class: "crumb", href: `#/agents/${agent.id}` }, icon("back"), agent.label) : h("a", { class: "crumb", href: "#/" }, icon("back"), "Agents"),
        h("h1", {}, editing ? `Edit ${agent.label}` : "New agent"),
        h(
          "p",
          {},
          editing
            ? "Changes apply to the next run. A running agent keeps the rules it started with."
            : "Describe the job, choose a model, and decide what the agent may touch.",
        ),
      ),
    ),
    form,
  )
  name.focus()
}
