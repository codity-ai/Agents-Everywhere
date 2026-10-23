import { brand } from "./brand"

export interface RunnerArgs {
  apiUrl: string
  token?: string
  preflight?: boolean
  recoverOutbox?: string
}

export function parseArgs(argv: string[]): RunnerArgs {
  const args: RunnerArgs = {
    apiUrl: process.env[brand().apiUrlEnv] || brand().defaultApiUrl,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === "--token") args.token = argv[(i += 1)]
    else if (a.startsWith("--token=")) args.token = a.slice("--token=".length)
    else if (a === "--api-url") args.apiUrl = argv[(i += 1)]
    else if (a.startsWith("--api-url=")) args.apiUrl = a.slice("--api-url=".length)
    else if (a === "--preflight") args.preflight = true
    else if (a === "--recover-outbox") args.recoverOutbox = argv[(i += 1)]
    else if (a.startsWith("--recover-outbox=")) args.recoverOutbox = a.slice("--recover-outbox=".length)
  }
  args.apiUrl = args.apiUrl.replace(/\/+$/, "")
  return args
}
