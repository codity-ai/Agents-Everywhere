import fs from "fs"
import path from "path"
import type { Server } from "bun"
import { AdminApi } from "./admin"
import { loadAssets, BinaryServer, type StaticFile } from "./assets"
import { AdminAuth } from "./auth"
import { loadKeys } from "./crypto"
import { ModelCatalog } from "./model-catalog"
import { openDatabase } from "./db"
import { errorResponse, HttpError, json, withSecurityHeaders } from "./http"
import { startReaper } from "./reaper"
import { RuntimeApi } from "./runtime"
import { Store } from "./store"

export interface ControlOptions {
  port: number
  hostname: string
  dataDir: string
  /** The URL machines use to reach this server; install commands point here. */
  publicUrl: string
  binariesDir: string | null
  tls: { cert: string; key: string } | null
  log: (line: string) => void
}

const UI_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ")

type Handler = (req: Request, params: Record<string, string>) => Promise<Response> | Response

export interface RunningControl {
  server: Server<undefined>
  store: Store
  auth: AdminAuth
  /** Set only when this start created the admin token; shown once. */
  newAdminToken: string | null
  stop(): Promise<void>
}

export async function startControl(options: ControlOptions): Promise<RunningControl> {
  fs.mkdirSync(options.dataDir, { recursive: true, mode: 0o700 })
  const db = openDatabase(path.join(options.dataDir, "control.db"))
  const store = new Store(db)
  const keys = loadKeys(options.dataDir)
  const secure = options.tls !== null || options.publicUrl.startsWith("https://")
  const auth = new AdminAuth(store, secure)
  const newAdminToken = await auth.ensureAdminToken()
  const runtime = new RuntimeApi(store, keys, options.log)
  const admin = new AdminApi(store, keys, options.publicUrl, options.log)
  const assets = await loadAssets()
  const binaries = new BinaryServer(options.binariesDir)
  const models = new ModelCatalog(process.env.AGENTS_EVERYWHERE_MODELS_URL, options.log)
  const publicOrigin = new URL(options.publicUrl).origin

  const guard =
    (
      handler: Handler,
      requireAdmin: boolean,
    ): ((req: Request & { params?: Record<string, string> }) => Promise<Response>) =>
    async (req) => {
      let res: Response
      try {
        if (requireAdmin) await auth.require(req, publicOrigin, address(req))
        res = await handler(req, req.params ?? {})
      } catch (err) {
        res = errorResponse(err, options.log)
      }
      return withSecurityHeaders(res, secure)
    }
  const runner = (handler: Handler) => guard(handler, false)
  const adminOnly = (handler: Handler) => guard(handler, true)
  const staticFile = (file: StaticFile | undefined, extra: Record<string, string> = {}) => {
    const body = file?.encoding === "base64" ? Buffer.from(file.body, "base64") : file?.body
    return guard(() => {
      if (!file) throw new HttpError(404, "Not found")
      return new Response(body, { headers: { "Content-Type": file.type, "Cache-Control": "no-cache", ...extra } })
    }, false)
  }

  const address = (req: Request) => server.requestIP(req)?.address ?? "unknown"

  const server: Server<undefined> = Bun.serve({
    port: options.port,
    hostname: options.hostname,
    ...(options.tls ? { tls: { cert: Bun.file(options.tls.cert), key: Bun.file(options.tls.key) } } : {}),
    routes: {
      "/health": runner(() => json({ status: "ok" })),

      // The runner protocol. Paths match every other control plane that speaks it.
      "/agents/runtime/handshake": { POST: runner(runtime.handshake) },
      "/agents/runtime/heartbeat": { POST: runner(runtime.heartbeat) },
      "/agents/runtime/events": { POST: runner(runtime.event) },
      "/agents/runtime/finish": { POST: runner(runtime.finish) },
      "/agents/runtime/permission-requests": { POST: runner(runtime.permissionRequest) },

      // What a machine downloads.
      "/agent/install.sh": staticFile({ body: assets.install, type: "text/x-shellscript; charset=utf-8" }),
      "/agent/harness.js": staticFile({ body: assets.runner, type: "application/javascript; charset=utf-8" }),
      "/agent/bin/:platform/:file": runner(async (req, p) => {
        if (p.file === "agents-everywhere") return binaries.serve(req, p.platform, false)
        if (p.file === "agents-everywhere.sha256") return binaries.serve(req, p.platform, true)
        throw new HttpError(404, "Not found")
      }),

      // Signing in and out.
      "/api/session": {
        GET: runner((req) => {
          const session = auth.current(req)
          return json(session ? { signed_in: true, csrf_token: session.csrfToken } : { signed_in: false })
        }),
        POST: runner(async (req) => auth.login((await admin.loginBody(req)).token, address(req))),
        DELETE: runner((req) => auth.logout(req)),
      },

      // The admin API.
      "/api/models": { GET: adminOnly(models.list) },
      "/api/config/global": { GET: adminOnly(admin.getGlobalConfig), PUT: adminOnly(admin.saveGlobalConfig) },
      "/api/agents": { GET: adminOnly(admin.listAgents), POST: adminOnly(admin.createAgent) },
      "/api/agents/:id": {
        GET: adminOnly((req, p) => admin.getAgent(req, p.id)),
        PATCH: adminOnly((req, p) => admin.updateAgent(req, p.id)),
      },
      "/api/agents/:id/runs": { GET: adminOnly((req, p) => admin.listRuns(req, p.id)) },
      "/api/agents/:id/runs/:runId": { GET: adminOnly((req, p) => admin.getRun(req, p.id, p.runId)) },
      "/api/agents/:id/permissions": { PUT: adminOnly((req, p) => admin.replacePermissions(req, p.id)) },
      "/api/agents/:id/install-command": { POST: adminOnly((req, p) => admin.installCommand(req, p.id)) },
      "/api/agents/:id/revoke": { POST: adminOnly((req, p) => admin.revoke(req, p.id)) },
      "/api/agents/:id/runs/:runId/events": { GET: adminOnly((req, p) => admin.runEvents(req, p.id, p.runId)) },
      "/api/agents/:id/runs/:runId/export": { GET: adminOnly((req, p) => admin.runExport(req, p.id, p.runId)) },
      "/api/agents/:id/runs/:runId/messages": { POST: adminOnly((req, p) => admin.sendMessage(req, p.id, p.runId)) },
      "/api/agents/:id/runs/:runId/kill": { POST: adminOnly((req, p) => admin.killRun(req, p.id, p.runId)) },
      "/api/agents/:id/permission-requests": { GET: adminOnly((req, p) => admin.permissionRequests(req, p.id)) },
      "/api/agents/:id/permission-requests/:requestId/decision": {
        POST: adminOnly((req, p) => admin.decide(req, p.id, p.requestId)),
      },

      // The web UI. Routing happens in the page (#/agents/...), so these are all it needs.
      "/": staticFile(assets.ui["index.html"], { "Content-Security-Policy": UI_CSP }),
      "/app.js": staticFile(assets.ui["app.js"]),
      "/styles.css": staticFile(assets.ui["styles.css"]),
      "/logo.svg": staticFile(assets.ui["logo.svg"]),
      "/fonts/archivo.woff2": staticFile(assets.ui["fonts/archivo.woff2"], { "Cache-Control": "public, max-age=604800" }),
      "/fonts/jetbrains-mono.woff2": staticFile(assets.ui["fonts/jetbrains-mono.woff2"], {
        "Cache-Control": "public, max-age=604800",
      }),
    },
    fetch: (req) => withSecurityHeaders(json({ detail: `Not found: ${new URL(req.url).pathname}` }, 404), secure),
    error: (err) => withSecurityHeaders(errorResponse(err, options.log), secure),
  })

  const stopReaper = startReaper(store, options.log)

  return {
    server,
    store,
    auth,
    newAdminToken,
    async stop() {
      stopReaper()
      await server.stop(true)
      db.close()
    },
  }
}
