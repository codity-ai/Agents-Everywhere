# Runner protocol

How a runner (the script an install command puts on a machine) and a control plane talk. Any server that implements this can drive the runner in `packages/harness`. The types are in `packages/harness/src/protocol.ts`, which both sides import, and `packages/control/test/conformance/suite.ts` checks a server against it from the outside.

## Shape of the conversation

The runner always calls and the control plane only answers. Nothing ever connects to the machine the runner is on, so every instruction for a running agent travels in the reply to the runner's next heartbeat: a request to stop, a chat message, a permission decision.

1. **Handshake.** The runner presents a single-use install token and receives a run token plus everything the run needs.
2. **Heartbeat**, every 10 seconds (every 2 while a permission decision is outstanding). Keeps the run alive and carries instructions back.
3. **Events**, whenever the agent does something worth recording.
4. **Permission requests**, in request mode, when the agent tries something no rule covers.
5. **Finish**, once, with a terminal status.

All requests are `POST` with a JSON body and `Authorization: Bearer <token>`. Errors are JSON `{"detail": "<message>"}`. Paths are relative to the control plane's base URL.

## Tokens

- The **install token** comes from the install command. It names one pending run and expires five minutes after it is minted. Using it claims the run; using it again gets `409`.
- The **run token** comes from the handshake. It is valid for 24 hours. When less than 12 hours remain, a heartbeat reply includes a replacement in `run_token`, and the runner switches to it.
- A run token proves identity, not state: a run that has ended is refused with `409` even while its token is still valid.

## `POST /agents/runtime/handshake`

Bearer: the install token.

```json
{ "hostname": "web-01", "run_env": { "platform": "linux", "node": "v20.11.0", "protocol_version": 1, "capabilities": ["transcript", "messages"] } }
```

Reply:

| Field | Meaning |
|---|---|
| `run_id`, `run_token`, `run_token_expires_at` | The run this machine is now, and its credential. |
| `task` | The first prompt. |
| `permissions` | Rules: `{path_pattern, access: read\|write, kind: filesystem\|bash_command\|webfetch_host, effect: allow\|deny}`. |
| `secrets` | References to resolve on the machine: `{secret_arn, key_to_env_var, provider: aws\|gcp\|vault\|env, provider_config}`. A reference, never a value. |
| `declared_env_vars` | Names of variables the machine already has for the agent. |
| `model_provider`, `model_name` | Which model to run. |
| `llm_api_key` | The provider key, or null. This is the only time it leaves the control plane. |
| `interactive` | Hand the terminal to the engine's TUI instead of running headless. |
| `permission_mode` | `strict` refuses anything outside the rules; `request` asks a person. |
| `permission_request_timeout_seconds` | How long a request waits before it counts as refused. |
| `protocol_version` | `1` or `2` (negotiated with the runner). |

`401` for a missing or invalid token, `409` when the run was already claimed or the agent was revoked.

## `POST /agents/runtime/heartbeat`

Bearer: the run token.

```json
{ "after_event_id": "<id of the last chat message delivered, or null>", "applied_permission_request_ids": ["<ids of decisions applied to the engine>"] }
```

Reply:

| Field | Meaning |
|---|---|
| `kill` | Stop the agent and finish as `killed`. |
| `status` | The run's status; the first heartbeat moves `handshaked` to `running`. |
| `messages` | Chat messages after `after_event_id`, oldest first: `{id, message}`. The runner delivers them in order and stops at the first it cannot deliver, so that one is offered again. |
| `permission_decisions` | Decided requests not yet acknowledged: `{request_id, engine_request_id, permission, patterns, decision}`. A decision keeps coming back until the runner lists its `request_id` in `applied_permission_request_ids`. |
| `run_token` | A replacement token, or null. |

A malformed cursor or acknowledgement id is ignored, never an error, because the heartbeat is the only way a stop request reaches the runner. `401`, `404` or `409` tell the runner the server has finished with this run, and it stops the agent.

## `POST /agents/runtime/events`

```json
{ "event_id": "c1f7b0a2-...", "event_type": "step", "payload": { "kind": "tool", "message": "Read ./logs/app.log" }, "tokens_in": 1200, "tokens_out": 80, "cost_usd": 0.0031 }
```

`event_id` is an optional runner-generated unique ID (UUIDv4) persisted in the runner's on-disk outbox before sending.
When provided, the control plane ensures idempotent processing: replaying an event with the same ID, payload and usage after a dropped acknowledgement returns HTTP 200 without creating duplicate transcript entries or double-counting usage.
Reusing an existing `event_id` with a different payload, event type or usage is rejected with HTTP 409.
Posting events to a run that has already finished or ended is rejected with HTTP 409.

`event_type` is one of `heartbeat`, `step`, `summary`, `error`, `permission_denied`, `permission_request`. A runner cannot post `user_message`: that type is reserved for what a person sends. Payloads say what the agent did, never what it saw: file contents and command output stay on the machine.

## `POST /agents/runtime/permission-requests`

Sent in request mode when the engine asks about something no rule covers. The runner keeps the engine's own request open, so the tool call waits instead of failing.

```json
{ "engine_request_id": "per_123", "permission": "read", "patterns": ["/etc/hostname"], "metadata": {} }
```

Reply: `{request_id, status, expires_at, accepted}`. `accepted: false` means nobody will decide it (strict mode, or too many already waiting), and the runner refuses the call at once. The same `engine_request_id` sent again returns the same request, so a retry after a dropped connection does not ask twice.

## `POST /agents/runtime/finish`

```json
{ "status": "succeeded", "message": "Task completed." }
```

`status` is one of `succeeded`, `failed`, `killed`, `idle_timeout` (the session went quiet without finishing its work). A non-terminal status gets `400`, a finished run `409`.

## Downloads

A control plane also serves what the install command fetches:

- `GET /agent/install.sh`
- `GET /agent/harness.js`, the runner
- `GET /agent/bin/<platform>/agents-everywhere` for `linux-x64`, `linux-arm64`, `darwin-x64` and `darwin-arm64`, with its SHA-256 at `.../agents-everywhere.sha256` in `sha256sum` format. The runner refuses a download that does not match a published checksum. Redirects are followed.
- `GET /health`, used by `harness.js --preflight`.

## Extensions

A server may add fields to the handshake and heartbeat replies. The runner ignores fields it does not know, and a runner distribution can handle them with a `RunnerExtension` (`packages/harness/src/extension.ts`), which sees each reply and may add context to the conversation but cannot change permissions or the run's lifecycle.
