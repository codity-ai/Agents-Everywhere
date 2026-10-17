/**
 * The control plane's key material and what it signs and seals: short-lived
 * runner tokens (HS256 JWTs, audience-scoped) and LLM keys at rest (AES-256-GCM).
 *
 * One secret, generated on first start and kept readable by this user only, or
 * supplied through the environment. Separate keys are derived from it for each
 * purpose, so a token key can never decrypt a stored LLM key.
 */
import crypto from "crypto"
import fs from "fs"
import path from "path"

export const SECRET_ENV = "AGENTS_EVERYWHERE_CONTROL_SECRET"
const SECRET_BYTES = 32

export class TokenError extends Error {}

export interface Keys {
  signing: Buffer
  encryption: Buffer
}

function derive(secret: Buffer, purpose: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", secret, Buffer.alloc(0), `agents-everywhere-control/${purpose}`, 32))
}

/** Reads the secret from the environment, or from `<dataDir>/secret.key`, creating it on first start. */
export function loadKeys(dataDir: string): Keys {
  const fromEnv = process.env[SECRET_ENV]
  let secret: Buffer
  if (fromEnv) {
    secret = Buffer.from(fromEnv, /^[0-9a-f]+$/i.test(fromEnv) ? "hex" : "base64")
    if (secret.length < SECRET_BYTES) throw new Error(`${SECRET_ENV} must decode to at least ${SECRET_BYTES} bytes`)
  } else {
    const file = path.join(dataDir, "secret.key")
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, crypto.randomBytes(SECRET_BYTES), { mode: 0o600, flag: "wx" })
    }
    if (process.platform !== "win32") {
      const mode = fs.statSync(file).mode & 0o077
      if (mode !== 0) throw new Error(`${file} is readable by other users; run: chmod 600 ${file}`)
    }
    secret = fs.readFileSync(file)
  }
  return { signing: derive(secret, "tokens"), encryption: derive(secret, "llm-keys") }
}

/** AES-256-GCM, stored as base64 of iv || tag || ciphertext. */
export function seal(keys: Keys, plaintext: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", keys.encryption, iv)
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64")
}

export function unseal(keys: Keys, sealed: string): string {
  const raw = Buffer.from(sealed, "base64")
  const decipher = crypto.createDecipheriv("aes-256-gcm", keys.encryption, raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8")
}

const ISSUER = "agents-everywhere-control"
export const BOOTSTRAP_AUDIENCE = "agent_bootstrap"
export const RUN_AUDIENCE = "agent_run"
export const BOOTSTRAP_TOKEN_SECONDS = 5 * 60
export const RUN_TOKEN_SECONDS = 24 * 60 * 60
// A beat made with less than this left on its token gets a replacement.
const RUN_TOKEN_REFRESH_SECONDS = 12 * 60 * 60

export interface RunClaims {
  agentId: string
  runId: string
  expiresAt: Date
}

const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url")

function sign(
  keys: Keys,
  audience: string,
  agentId: string,
  runId: string,
  lifetimeSeconds: number,
): { token: string; expiresAt: Date } {
  const now = Math.floor(Date.now() / 1000)
  const exp = now + lifetimeSeconds
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const payload = b64url(
    JSON.stringify({ iss: ISSUER, aud: audience, sub: runId, agent: agentId, iat: now, exp, jti: crypto.randomUUID() }),
  )
  const signature = crypto.createHmac("sha256", keys.signing).update(`${header}.${payload}`).digest("base64url")
  return { token: `${header}.${payload}.${signature}`, expiresAt: new Date(exp * 1000) }
}

function verify(keys: Keys, token: string, audience: string): RunClaims {
  const parts = token.split(".")
  if (parts.length !== 3) throw new TokenError("malformed token")
  const [header, payload, signature] = parts
  const expected = crypto.createHmac("sha256", keys.signing).update(`${header}.${payload}`).digest()
  const given = Buffer.from(signature, "base64url")
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected))
    throw new TokenError("bad signature")

  let head: any
  let claims: any
  try {
    head = JSON.parse(Buffer.from(header, "base64url").toString("utf8"))
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
  } catch {
    throw new TokenError("malformed token")
  }
  if (head.alg !== "HS256") throw new TokenError("unexpected algorithm")
  if (claims.iss !== ISSUER) throw new TokenError("wrong issuer")
  if (claims.aud !== audience) throw new TokenError("wrong audience")
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) throw new TokenError("expired")
  if (typeof claims.sub !== "string" || typeof claims.agent !== "string") throw new TokenError("missing claims")
  return { agentId: claims.agent, runId: claims.sub, expiresAt: new Date(claims.exp * 1000) }
}

/** Single-use by construction: it names a pending run, which the handshake claims once. */
export const createBootstrapToken = (keys: Keys, agentId: string, runId: string) =>
  sign(keys, BOOTSTRAP_AUDIENCE, agentId, runId, BOOTSTRAP_TOKEN_SECONDS)
export const verifyBootstrapToken = (keys: Keys, token: string) => verify(keys, token, BOOTSTRAP_AUDIENCE)

export const createRunToken = (keys: Keys, agentId: string, runId: string) =>
  sign(keys, RUN_AUDIENCE, agentId, runId, RUN_TOKEN_SECONDS)
export const verifyRunToken = (keys: Keys, token: string) => verify(keys, token, RUN_AUDIENCE)

export function runTokenNeedsRefresh(claims: RunClaims): boolean {
  return claims.expiresAt.getTime() - Date.now() < RUN_TOKEN_REFRESH_SECONDS * 1000
}

/** A high-entropy value for a person to paste, and its storable hash. */
export function randomToken(prefix: string): string {
  return `${prefix}${crypto.randomBytes(32).toString("base64url")}`
}

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex")
}
