// Loomy (iFlytek's desktop agent) as a magpie provider: read the session its
// own app stores, ask its OpenAI-compatible gateway, and keep the Loomy
// version / trace headers its chat endpoint requires.
//
// The chat endpoint refuses a request without `traceparent` by holding it
// until the client times out, and rejects Bearer alone with `缺少 token`; both
// `token` and `Authorization` are sent, as Loomy's own llm-completion does.
import { createHash, randomBytes } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const PROVIDER = "loomy"
export const SITE_NAME = "Loomy"
export const DEFAULT_BASE = "https://loomyad.xunfei.cn/api/v1"
export const FALLBACK_APP_VERSION = "0.9.39"

// The chat models this account saw on 2026-10-23. The live /models answer
// replaces this list; the fallback is only for a gateway that is down.
export const FALLBACK_MODELS = [
  { id: "spark-x2.6", name: "Spark-X2.6 正式版(限时免费)(x0.0)", context: 1048576, output: 131072, rate: 0, reasoning: true, vision: false, tools: true },
  { id: "spark-x", name: "Spark-X2.5（限时免费）(x0.0)", context: 1048576, output: 65536, rate: 0, reasoning: true, vision: false, tools: true },
  { id: "DeepSeek-V4.1-Flash", name: "DeepSeek V4.1 Flash(x2.0)", context: 1048576, output: 384000, rate: 2, reasoning: true, vision: true, tools: true },
  { id: "MiniMax-M3", name: "MiniMax M3 （x4.0）", context: 1048576, output: 512000, rate: 4, reasoning: true, vision: true, tools: true },
  { id: "Kimi-k2.6", name: "Kimi k2.6 （x6.5）", context: 262144, output: 65536, rate: 6.5, reasoning: true, vision: true, tools: true },
  { id: "qwen-3.8-max", name: "Qwen 3.8 Max (x12.0)", context: 1000000, output: 65536, rate: 12, reasoning: true, vision: false, tools: true },
  { id: "GLM-5.3-Flash", name: "GLM 5.3 Flash(x0.8)", context: 1048576, output: 131072, rate: 0.8, reasoning: true, vision: true, tools: true },
  { id: "qwen3.8-flash", name: "qwen 3.8 flash（x0.8）", context: 1000000, output: 131072, rate: 0.8, reasoning: true, vision: true, tools: true },
  { id: "mimo-v2.5", name: "MiMo V2.5（x3.3）", context: 1048576, output: 131072, rate: 3.3, reasoning: true, vision: true, tools: true },
  { id: "auto", name: "自动 · 均衡", context: 0, output: 0, rate: undefined, reasoning: false, vision: false, tools: false },
]

export class LoomyAuthError extends Error {
  constructor(message, code = "no-session") {
    super(message)
    this.name = "LoomyAuthError"
    this.code = code
  }
}

export function userHash(username) {
  return createHash("sha256").update(String(username ?? "")).digest("hex").slice(0, 12)
}

// Windows keeps the app's per-user data under C:\Users\Public\Loomy\<hash>;
// the macOS and Linux paths are the ones Loomy's own avatar-gen skill reads.
export function loomyHome({ home = homedir(), platform = process.platform, env = process.env } = {}) {
  if (env.LOOMY_HOME) return env.LOOMY_HOME
  if (platform === "win32") {
    const user = env.USERNAME || env.USER || ""
    return join(env.PUBLIC || "C:/Users/Public", "Loomy", userHash(user))
  }
  if (platform === "darwin") return join(home, "Library", "Application Support", "Loomy")
  return join(home, ".config", "Loomy")
}

export function authSessionPath(opts = {}) {
  if (opts.file) return opts.file
  if (opts.env?.LOOMY_AUTH_SESSION) return opts.env.LOOMY_AUTH_SESSION
  const home = loomyHome(opts)
  return opts.platform === "win32" || opts.platform === undefined && process.platform === "win32"
    ? join(home, "userData", "auth-session.json")
    : join(home, "auth-session.json")
}

export function runtimeConfigPath(opts = {}) {
  return join(loomyHome(opts), "opencode", "opencode.json")
}

export function updateLogPath(opts = {}) {
  const home = loomyHome(opts)
  return opts.platform === "win32" || opts.platform === undefined && process.platform === "win32"
    ? join(home, "userData", "update-trace.log")
    : join(home, "update-trace.log")
}

export function readAuthSession(opts = {}) {
  const file = authSessionPath(opts)
  if (!existsSync(file)) {
    throw new LoomyAuthError(`没有找到 ${SITE_NAME} 的登录态（${file}）；先在 ${SITE_NAME} 客户端登录，或把 session 贴到插件选项里`, "no-session-file")
  }
  let data
  try {
    data = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""))
  } catch (e) {
    throw new LoomyAuthError(`${SITE_NAME} 的登录文件读不出来：${e?.message ?? e}`, "bad-session-file")
  }
  const session = String(data?.session ?? "").trim()
  if (!session) {
    throw new LoomyAuthError(`${SITE_NAME} 的 session 是空的；先在 ${SITE_NAME} 客户端登录`, "empty-session")
  }
  return {
    file,
    session,
    userid: String(data?.userid ?? "").trim(),
    phone: String(data?.phone ?? "").trim(),
    updatedAt: Number(data?.updatedAt ?? 0) || 0,
  }
}

export function normalizeBase(url) {
  const s = String(url ?? "").trim()
  if (!s) return ""
  return s.replace(/\/+$/, "")
}

export function baseUrl(opts = {}) {
  const fromEnv = normalizeBase(opts.env?.LOOMY_BASE_URL)
  if (fromEnv) return fromEnv
  const configured = normalizeBase(opts.baseUrl)
  if (configured) return configured
  try {
    const cfg = JSON.parse(readFileSync(runtimeConfigPath(opts), "utf8").replace(/^\uFEFF/, ""))
    const url = normalizeBase(cfg?.provider?.imodel?.options?.baseURL)
    if (url) return url
  } catch {}
  return DEFAULT_BASE
}

export function appVersion(opts = {}) {
  const fromEnv = String(opts.env?.LOOMY_APP_VERSION ?? "").trim()
  if (fromEnv) return fromEnv
  const configured = String(opts.appVersion ?? "").trim()
  if (configured) return configured
  try {
    const text = readFileSync(updateLogPath(opts), "utf8")
    const matches = [...text.matchAll(/"version"\s*:\s*"([^"]+)"/g)]
    if (matches.length) return matches[matches.length - 1][1]
  } catch {}
  return FALLBACK_APP_VERSION
}

export function traceparent(random = randomBytes) {
  const hex = (n) => random(n).toString("hex")
  return `00-${hex(16)}-${hex(8)}-01`
}

// The chat endpoint's headers: Loomy's own client sends both `token` and
// `Authorization`, plus a traceparent (without it the request hangs), the
// app's version and the ids it uses to account a turn.
export function chatHeaders({ session, version, random = randomBytes, ids = {} } = {}) {
  const chatId = ids.chatId || `chat-${random(8).toString("hex")}`
  const msgId = ids.msgId || `msg-${random(8).toString("hex")}`
  return {
    token: String(session ?? ""),
    Authorization: `Bearer ${String(session ?? "")}`,
    traceparent: ids.traceparent || traceparent(random),
    "loomy-version": String(version || FALLBACK_APP_VERSION),
    ChatId: chatId,
    MsgId: msgId,
    TurnId: ids.turnId || msgId,
    InvokeOrigin: "user",
  }
}

export function rateFromName(name) {
  const m = String(name ?? "").match(/\(x\s*([0-9]+(?:\.[0-9]+)?)\)/i)
  return m ? Number(m[1]) : undefined
}

// The points API is on the same origin as the model gateway: the production
// base already ends in /api/v1, while the old ossptest base ends at
// /loomy/integration and needs /api/v1 added.
export function pointsBalanceUrl(base = DEFAULT_BASE) {
  const b = normalizeBase(base)
  return /\/api\/v1$/i.test(b) ? `${b}/points/balance` : `${b}/api/v1/points/balance`
}

export function parseBalance(json) {
  const d = json?.data
  if (!d || typeof d !== "object") return null
  const balance = Number(d.balance ?? 0)
  const dailyBalance = Number(d.dailyBalance ?? 0)
  const availableBalance = Number(d.availableBalance ?? balance + dailyBalance)
  if (![balance, dailyBalance, availableBalance].every(Number.isFinite)) return null
  return { balance, dailyBalance, availableBalance }
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)

// parseLive turns Loomy's /models answer into the chat models this package
// serves. Image-only models (output_modalities without text) are left out:
// magpie's provider models are chat models.
export function parseModels(json) {
  const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : []
  const out = []
  const seen = new Set()
  for (const m of rows) {
    if (!m || (m.type && m.type !== "chat")) continue
    const id = String(m.id ?? m.model ?? "").trim()
    if (!id || seen.has(id)) continue
    const caps = m.capabilities ?? {}
    const outputs = Array.isArray(caps.output_modalities) ? caps.output_modalities : []
    if (outputs.length && !outputs.includes("text")) continue
    const inputs = Array.isArray(caps.input_modalities) ? caps.input_modalities : []
    const name = String(m.name ?? m.display_name ?? id)
    const efforts = Array.isArray(m.reasoning_efforts) ? m.reasoning_efforts.map(String) : []
    out.push({
      id,
      name,
      context: num(m.context_length ?? m.context),
      output: num(m.max_output_tokens ?? m.max_tokens ?? caps.output),
      rate: rateFromName(name),
      reasoning: caps.reasoning === true,
      vision: caps.vision === true || inputs.includes("image"),
      tools: caps.function_calling !== false,
      efforts,
      defaultEffort: String(m.default_reasoning_effort ?? ""),
    })
    seen.add(id)
  }
  return out
}

export function modelOf(m, base = DEFAULT_BASE) {
  return {
    id: m.id,
    providerID: PROVIDER,
    name: m.name,
    api: { id: m.id, url: base, npm: "@ai-sdk/openai-compatible" },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.context || 0, output: m.output || 0 },
    capabilities: {
      temperature: true,
      reasoning: m.reasoning === true,
      attachment: m.vision === true,
      toolcall: m.tools === true,
      input: { text: true, image: m.vision === true, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: {},
    free: m.rate === 0,
    rate: m.rate ?? 0,
    rateWas: 0,
    ...(m.efforts?.length ? { reasoning_levels: m.efforts } : {}),
  }
}

export function configModels(list) {
  return Object.fromEntries(list.map((m) => [m.id, {
    name: m.name,
    limit: { context: m.context || 0, output: m.output || 0 },
    tool_call: m.tools !== false,
    ...(m.reasoning ? { reasoning: true } : {}),
    ...(m.rate !== undefined ? { rate: m.rate } : {}),
  }]))
}
