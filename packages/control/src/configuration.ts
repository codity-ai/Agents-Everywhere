import { z } from "zod"
import { parseDocument } from "yaml"
import {
  OS_SHELLS,
  PERMISSION_ACCESS,
  PERMISSION_EFFECTS,
  PERMISSION_KINDS,
  PERMISSION_MODES,
} from "@agents-everywhere/harness/protocol"
import { MODEL_PROVIDER_IDS } from "./model-providers"
import { dedupeRules, MAX_PERMISSION_ROWS, PolicyError, type Rule } from "./policy"

export const MAX_CONFIG_YAML_BYTES = 64 * 1024
export const EMPTY_GLOBAL_YAML = "version: 1\npermissions: []\ndefaults: {}\n"
export const ENV_VAR_NAME = /^[A-Z_][A-Z0-9_]*$/

export const AGENT_DEFAULT_FIELDS = {
  task: z.string().trim().min(1).max(20_000),
  os_shell: z.enum(OS_SHELLS),
  location_label: z.string().trim().max(120).nullable(),
  model_provider: z.enum(MODEL_PROVIDER_IDS),
  model_name: z.string().trim().min(1).max(200),
  interactive: z.boolean(),
  permission_mode: z.enum(PERMISSION_MODES),
  permission_request_timeout_seconds: z.number().int().min(30).max(86_400),
  declared_env_vars: z.array(z.string().regex(ENV_VAR_NAME, "must be an environment variable name")).max(100),
  spend_limit_usd: z.number().positive("must be greater than 0").finite().max(100_000).nullable().optional(),
}

export const Permission = z
  .object({
    path_pattern: z.string().trim().min(1).max(1000),
    access: z.enum(PERMISSION_ACCESS).default("read"),
    kind: z.enum(PERMISSION_KINDS).default("filesystem"),
    effect: z.enum(PERMISSION_EFFECTS).default("allow"),
  })
  .strict()

const GlobalDocument = z
  .object({
    version: z.literal(1),
    permissions: z.array(Permission).max(MAX_PERMISSION_ROWS).default([]),
    defaults: z.object(AGENT_DEFAULT_FIELDS).partial().strict().default({}),
  })
  .strict()

const RejectionDocument = z
  .object({
    version: z.literal(1),
    permissions: z.array(Permission.extend({ effect: z.literal("deny").default("deny") })).max(MAX_PERMISSION_ROWS),
  })
  .strict()

export type GlobalDocument = z.infer<typeof GlobalDocument>

function parseYaml<S extends z.ZodType>(source: string, schema: S): z.infer<S> {
  if (Buffer.byteLength(source) > MAX_CONFIG_YAML_BYTES) throw new PolicyError("Configuration YAML exceeds 64 KiB")
  let value: unknown
  try {
    const document = parseDocument(source, { prettyErrors: false, strict: true, uniqueKeys: true, stringKeys: true })
    if (document.errors.length || document.warnings.length) throw new Error("Invalid YAML document")
    value = document.toJS({ maxAliasCount: 100 })
  } catch {
    throw new PolicyError("Invalid YAML. Use one document and check indentation, quoting, duplicate keys and aliases.")
  }
  const result = schema.safeParse(value)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw new PolicyError(`Configuration YAML ${issue.path.join(".") || "document"}: ${issue.message}`)
  }
  return result.data
}

export function parseGlobalYaml(source: string) {
  return parseYaml(source, GlobalDocument)
}

export function parseRejectionYaml(source: string) {
  return parseYaml(source, RejectionDocument.nullable())?.permissions ?? []
}

export function configuredRules(local: Rule[], rejectionYaml: string, global: Rule[] = []) {
  const rules = dedupeRules([...global, ...local, ...parseRejectionYaml(rejectionYaml)])
  if (rules.length > MAX_PERMISSION_ROWS)
    throw new PolicyError(`Combined configuration exceeds ${MAX_PERMISSION_ROWS} permission rules`)
  return rules
}
