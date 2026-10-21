# Running the control plane

`agents-everywhere control` is a small server with a web UI. You create agents in it, mint install commands, and then watch the agents running on your machines, answer what they ask for, and stop them. It keeps everything in one SQLite database.

## Start it

```bash
agents-everywhere control
```

It listens on `http://127.0.0.1:4800` and prints an admin token the first time it starts. Sign in to the UI with that token. It is shown once; `--rotate-admin-token` issues a new one and signs out every session.

Data lives in `~/.local/share/agents-everywhere-control` (or `--data <dir>`): the database, and `secret.key`, which signs run tokens and encrypts stored LLM keys. Back both up together; the database's keys cannot be read without it. `AGENTS_EVERYWHERE_CONTROL_SECRET` supplies the key from the environment instead.

## Let other machines reach it

Machines that run agents call the control plane, so it has to be reachable from them.

```bash
agents-everywhere control --hostname 0.0.0.0 --public-url https://agents.example.com --tls-cert cert.pem --tls-key key.pem
```

- `--public-url` is the address install commands point machines at.
- Listening beyond localhost without TLS is refused, because the admin token and every agent's LLM key would cross the network unencrypted. Behind a TLS-terminating reverse proxy, pass `--insecure` and keep the proxy's TLS in front.

## Engine binaries

An install command downloads the engine from the control plane. A release build of `agents-everywhere` serves its own binary for its own platform and redirects the others to the matching GitHub release. Running from source, or serving builds you made yourself, pass `--binaries <dir>` with `<dir>/<platform>/agents-everywhere` for each platform you need. Checksums are computed and served beside each file.

## Installing an agent on a machine

For a runnable example, independent harness builds, runner options and troubleshooting, see [Using the harness](harness.md).

On the agent's page, create an install command and run it in the directory the agent should work in. The machine needs Node.js 18 or newer and outbound access to the control plane. The command works once and expires after five minutes. If a machine does not behave, run the runner's own checks:

```bash
node ~/.agents-everywhere-runner/harness.cjs --preflight --api-url=https://agents.example.com
```

## Fleet activity

The Agents page opens with a Fleet activity panel for the last 24 hours, 7 days or 30 days, in UTC. Spend is the sum of costs runners reported in the interval, not a provider bill; when some usage reports carried no price, the Spend card says so instead of counting them as zero. Runs count by start time, Median run covers runs that ended in the interval, and Refused actions counts recorded `permission_denied` events. Agents running and Awaiting you are current snapshots. The same aggregates are available to scripts holding the admin token at `GET /api/fleet/metrics?range=24h|7d|30d`; the response carries counts, sums and agent names only, never transcripts or tool inputs.

## What protects what

- **Rules are enforced on the machine**, by the engine, on every tool call. The control plane only stores them; a stolen control-plane session can change rules for the next run but not reach into a running one.
- Rules that would make the path rules meaningless (allowing `sh`, `python`, `git *`, `make`, `tee` and similar) are refused unless explicitly acknowledged, and can never be added from a one-click approval.
- **The LLM key** is stored encrypted and sent only in the handshake of a run of that agent. Secrets from AWS, GCP or Vault are fetched by the machine itself; only their references are stored.
- **Admin access** is one token, stored as an argon2id hash. Browser sessions use an HttpOnly, SameSite=Strict cookie plus a CSRF token; sign-in attempts are rate limited.
- **Spending guardrails** are optional per-agent and per-run USD limits set in agent settings (or global config defaults; clear the field for no limit). The budget is transmitted to the runner during handshake and enforced at provider-step boundaries. If token usage occurs without known USD cost on a budgeted run, execution halts immediately with `unpriced_usage_halt` to prevent unmetered spend. Because enforcement occurs at turn boundaries, an in-flight provider step may incur additional cost before termination takes effect, so actual spend may slightly overshoot the configured threshold.
