const stages = ["directory", "source", "recipe", "target", "preflight", "inspection", "permission", "control"]
const codes = ["working_directory_mismatch", "source_revision_mismatch", "dirty_worktree", "repository_mismatch", "recipe_target_mismatch", "recipe_invalid", "target_unavailable", "target_identity_mismatch", "preflight_failed", "prior_release_unavailable", "permission_denied", "control_outcome_uncertain", "control_refused", "deployment_failed"]
export const deploymentGuidance = "Operate only the deployment bound to this session. Prepare the recipe from the exact reviewed revision in a clean configured repository, obtain human plan approval in guided review, then apply. Do not edit recipes, switch checkouts, create targets, or retry unchanged failed prerequisites. Report the diagnostic stage, code and next action; wait for an explicit correction. Recipe-target mismatch requires a compatible reviewed recipe or reconciled operation. Uncertain outcomes require status and reconciliation, never blind retry. Never deploy through generic shell commands or replay a bootstrap token. Verify, recover and reconcile preserve approval and evidence boundaries."
export type DeploymentDiagnostic = {
  version: 1; operation_id: string; action: string; stage: string; code: string
  message: string; next_action: string; retry_policy: "after_correction" | "after_reconciliation"
}

export function decodeDeploymentDiagnostic(value: unknown, operationID: string, action: string): DeploymentDiagnostic {
  if (!value || typeof value !== "object") throw new Error("Invalid deployment diagnostic")
  const v = value as Record<string, unknown>
  if (Object.keys(v).some((key) => !["version", "operation_id", "action", "stage", "code", "message", "next_action", "retry_policy"].includes(key))
    || v.version !== 1 || v.operation_id !== operationID || v.action !== action
    || typeof v.stage !== "string" || !stages.includes(v.stage) || typeof v.code !== "string" || !codes.includes(v.code)
    || typeof v.message !== "string" || !v.message.trim() || Buffer.byteLength(v.message) > 8192
    || typeof v.next_action !== "string" || !v.next_action.trim() || Buffer.byteLength(v.next_action) > 8192
    || !["after_correction", "after_reconciliation"].includes(String(v.retry_policy))) throw new Error("Invalid deployment diagnostic or operation binding")
  return v as DeploymentDiagnostic
}

export function scrubDeploymentDiagnostic(text: string, secrets: string[]) {
  const clean = secrets.filter(Boolean).reduce((value, secret) => value.replaceAll(secret, "[REDACTED]"), text)
  return clean.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
    .replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 4096)
}

export class DeploymentFailure extends Error {
  constructor(readonly diagnostic: DeploymentDiagnostic, reported = true) {
    super(`Deployment ${diagnostic.action} failed [${diagnostic.stage}/${diagnostic.code}]: ${diagnostic.message} Next: ${diagnostic.next_action} Retry: ${diagnostic.retry_policy}.${reported ? "" : " Failure-event delivery was unavailable; inspect the terminal diagnostic."}`)
  }
}
