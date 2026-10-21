/**
 * Turns the engine's event stream into transcript lines for the control plane.
 *
 * A transcript says what the agent did, never what it saw: tool output is the
 * contents of a file or the output of a command on the machine, and none of it
 * is forwarded. The fields that are file contents in a tool's *input* are
 * dropped for the same reason, including from refusals, where a refused write
 * used to carry the text it tried to write.
 */
import path from "path"

export const TRANSCRIPT_TEXT_LIMIT = 4000
const TRANSCRIPT_LABEL_LIMIT = 300
const FILE_CONTENT_FIELDS = new Set(["content", "oldString", "newString", "patch", "patchText", "diff"])
// Engine bookkeeping that tells a reader nothing about the task.
const QUIET_TOOLS = new Set(["todowrite", "todoread", "todo", "question", "plan", "invalid"])

// How the engine words a refusal. A rule-based deny never becomes a
// `permission.asked` event at all: the engine refuses the call outright and the
// only trace is the failed tool part, so this is the one place a strict
// refusal can be noticed and reported. Matched on the engine's own wording
// (PermissionV1.DeniedError / RejectedError in core/v1/permission.ts).
export const PERMISSION_ERROR =
  /rule which prevents you from using this specific tool call|rejected permission to use this specific tool call/i

export interface TranscriptEntry {
  kind: "prompt" | "reply" | "tool" | "error" | "usage" | "notice"
  message: string
  tool?: string
  status?: "done" | "failed"
  verb?: string
  target?: string
  detail?: string
  [key: string]: unknown
}

export function clip(text: unknown, limit: number): string {
  const value = String(text == null ? "" : text).trim()
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
}

/** A path as someone reading the transcript would write it: relative to where
 *  the agent was started when it is inside that directory, absolute otherwise. */
function displayPath(target: unknown, cwd: string): string {
  if (!target || typeof target !== "string") return ""
  const absolute = path.isAbsolute(target) ? target : path.resolve(cwd, target)
  const relative = path.relative(cwd, absolute)
  if (!relative) return "."
  if (relative.startsWith("..") || path.isAbsolute(relative)) return absolute
  return `./${relative}`
}

type ToolInput = Record<string, any>

/** The files a patch touches, from its `*** Add/Update/Delete File:` headers. */
function patchedFiles(patchText: unknown, cwd: string): string {
  if (typeof patchText !== "string") return ""
  const files = [...patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => displayPath(m[1].trim(), cwd))
  return [...new Set(files)].join(", ")
}

// Each action in two tenses: what the agent did, and what it tried to do. A
// refused write never happened, so "Wrote" would be false on a refusal line.
// The target is kept apart from the verb because it is a path or a command,
// which a UI shows as a case-sensitive identifier.
const TOOL_ACTIONS: Record<
  string,
  { done: string; attempt: string; target: (input: ToolInput, cwd: string) => string }
> = {
  read: { done: "Read", attempt: "Read", target: (input, cwd) => displayPath(input.filePath || input.path, cwd) },
  write: { done: "Wrote", attempt: "Write", target: (input, cwd) => displayPath(input.filePath, cwd) },
  edit: { done: "Edited", attempt: "Edit", target: (input, cwd) => displayPath(input.filePath, cwd) },
  apply_patch: { done: "Changed", attempt: "Change", target: (input, cwd) => patchedFiles(input.patchText, cwd) },
  bash: { done: "Ran", attempt: "Run", target: (input) => input.command || "" },
  glob: {
    done: "Listed files matching",
    attempt: "List files matching",
    target: (input, cwd) => `${input.pattern || ""}${input.path ? ` in ${displayPath(input.path, cwd)}` : ""}`,
  },
  grep: {
    done: "Searched for",
    attempt: "Search for",
    target: (input, cwd) => `${input.pattern || ""}${input.path ? ` in ${displayPath(input.path, cwd)}` : ""}`,
  },
  webfetch: { done: "Fetched", attempt: "Fetch", target: (input) => input.url || "" },
  websearch: { done: "Searched the web for", attempt: "Search the web for", target: (input) => input.query || "" },
  task: {
    done: "Handed off to a subagent",
    attempt: "Hand off to a subagent",
    target: (input) => input.description || "",
  },
}

/** What a tool call did, or tried to do when `attempted`, split into a verb and
 *  a bounded target, plus the two joined for anything that reads a sentence. */
export function describeToolCall(tool: string, input: ToolInput | undefined, cwd: string, attempted = false) {
  const action = TOOL_ACTIONS[tool]
  const verb = action ? action[attempted ? "attempt" : "done"] : `${attempted ? "Use" : "Used"} ${tool}`
  const target = action ? clip(action.target(input || {}, cwd), TRANSCRIPT_LABEL_LIMIT) : ""
  return { verb, target, message: target ? `${verb} ${target}` : verb }
}

/** A tool's input with any file contents removed. */
export function safeToolInput(input: ToolInput | undefined): ToolInput {
  const out: ToolInput = {}
  for (const [key, value] of Object.entries(input || {})) {
    if (FILE_CONTENT_FIELDS.has(key)) continue
    out[key] = typeof value === "string" ? clip(value, TRANSCRIPT_LABEL_LIMIT) : value
  }
  return out
}

/**
 * The transcript line for one thing the engine reported, or null when it is
 * not worth a line. Both run modes go through this, so a headless and an
 * interactive run of the same task read the same way.
 *
 * Prompts are only worth recording where a person typed them: in a headless
 * run the prompt is the task, which the control plane already shows.
 */
export function transcriptEntry(
  part: any,
  role: string | undefined,
  cwd: string,
  { prompts = false }: { prompts?: boolean } = {},
): TranscriptEntry | null {
  if (!part || part.synthetic) return null

  if (part.type === "text") {
    const text = clip(part.text, TRANSCRIPT_TEXT_LIMIT)
    if (!text) return null
    if (role === "user") return prompts ? { kind: "prompt", message: text } : null
    // Text streams in pieces; only the finished reply is a line.
    if (!(part.time && part.time.end)) return null
    return { kind: "reply", message: text }
  }

  if (part.type === "tool") {
    const state = part.state || {}
    if (state.status !== "completed" && state.status !== "error") return null
    if (QUIET_TOOLS.has(part.tool)) return null
    // A refusal is reported as a permission_denied event of its own.
    if (state.status === "error" && PERMISSION_ERROR.test(String(state.error || ""))) return null
    const entry: TranscriptEntry = {
      kind: "tool",
      tool: part.tool,
      status: state.status === "completed" ? "done" : "failed",
      ...describeToolCall(part.tool, state.input, cwd),
    }
    if (state.status === "error") entry.detail = clip(state.error, TRANSCRIPT_LABEL_LIMIT)
    return entry
  }

  return null
}

/** An engine error as a sentence. The engine's error objects carry the full
 *  provider response, headers and request URL included. */
export function engineErrorMessage(error: any): string {
  if (!error) return ""
  if (typeof error === "string") return clip(error, TRANSCRIPT_LABEL_LIMIT)
  const data = error.data || {}
  return clip(data.message || error.message || error.name || "an unknown error", TRANSCRIPT_LABEL_LIMIT)
}

/** The line for a reply that never came because the model call failed, or null.
 *  Without it a transcript shows a question with no answer and no reason. */
export function errorEntry(info: any): TranscriptEntry | null {
  if (!info || info.role !== "assistant" || !info.error) return null
  return {
    kind: "error",
    message: clip(`The model returned an error: ${engineErrorMessage(info.error)}`, TRANSCRIPT_LABEL_LIMIT),
  }
}

/**
 * Turns the engine's event stream into transcript lines, once each. A part is
 * reported many times as it streams and settles, so each one is sent the first
 * time it has something worth saying and never again.
 */
export function createTranscript(cwd: string, options: { prompts?: boolean }) {
  const roles = new Map<string, string>()
  const sent = new Set<string>()
  return {
    observe(event: any): TranscriptEntry | null {
      const props = event.properties || {}
      if (event.type === "message.updated" && props.info && props.info.id) {
        roles.set(props.info.id, props.info.role)
        const failed = errorEntry(props.info)
        if (!failed || sent.has(`error:${props.info.id}`)) return null
        sent.add(`error:${props.info.id}`)
        return failed
      }
      if (event.type !== "message.part.updated" || !props.part) return null
      const part = props.part
      if (part.id && sent.has(part.id)) return null
      const entry = transcriptEntry(part, roles.get(part.messageID), cwd, options)
      if (entry && part.id) sent.add(part.id)
      return entry
    },
  }
}

/**
 * The tokens a step actually sent and received, from the engine's split view.
 * The engine counts cached input apart from `input`, and reasoning apart from
 * `output`, so that it can price each at its own rate. Reporting only the two
 * headline fields showed a few dozen tokens beside a real bill: with prompt
 * caching almost the whole prompt is a cache read.
 */
export function tokenCounts(tokens: any): { in: number; out: number } {
  const sanitize = (val: unknown): number =>
    typeof val === "number" && Number.isFinite(val) ? Math.max(0, Math.floor(val)) : 0
  const t = tokens || {}
  const cache = t.cache || {}
  return {
    in: sanitize(t.input) + sanitize(cache.read) + sanitize(cache.write),
    out: sanitize(t.output) + sanitize(t.reasoning),
  }
}
