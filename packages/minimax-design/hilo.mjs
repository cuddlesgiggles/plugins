// MiniMax Design (internal name Hilo) as a magpie provider: its own sign-in on
// this machine, its own model directory, its own credit wallet.
//
// Measured on this machine 2026-10-17 against the installed 4.0.1 build and a
// logged-in account:
//   GET  https://design.minimax.cn/api/v1/config          -> 200 the account's providers and models
//   GET  https://design.minimax.cn/api/v1/credit/wallet   -> 200 wallets[].sub_credits[]
//   GET  https://design.minimax.cn/api/v1/credit/balance  -> 200 {total_credit}
//   POST https://hub.minimaxi.com/api/v1/messages         -> 200 Anthropic-shaped completion
// All four take the `token:` header — the account's JWT — and no signature: a bad
// token answers 401 {"error":{"type":"authentication_error","message":"…token is
// malformed…"}} and an empty one 401 "token 为空 / 用户未登录，请登录后重试".
// That is the whole reason this is a provider candidate: unlike TeleAgent, nothing
// has to be reconstructed from the binary.
//
// The sign-in is read from the app's own files rather than copied:
//   %APPDATA%/@hilo/desktop/hub-config.json  tokens.accessToken = "v2enc:iv:tag:cipher"
//   %APPDATA%/@hilo/desktop/.token-key       32 raw bytes, the AES-256-GCM key
// The plaintext is a JWT (HS256) whose payload is {exp, user{id,name,avatar,deviceID,
// isAnonymous}}; on this account exp is ~38 days out and user.deviceID is empty.
// There is no refresh token in the file (`tokens` carries only accessToken and
// adAttribution), and the app renews through an endpoint on the login domains whose
// request shape I did not read — so a dead token means signing in again in the app,
// which is what "expired" tells the user to do.
import { createDecipheriv } from "node:crypto"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const PROVIDER = "minimax-design"
export const SITE_NAME = "MiniMax Design"
// the cloud API: config, credit, everything but the chats
export const CLOUD = "https://design.minimax.cn"
// one hub, four protocols: the account's config names @ai-sdk/anthropic,
// @ai-sdk/openai and @ai-sdk/google providers that all sit on this baseURL
export const LLM = "https://hub.minimaxi.com/api/v1"
export const NPM_ANTHROPIC = "@ai-sdk/anthropic"

// what the app puts in every cloud query: app_id 3001 (HILO_APP_ID in the bundle),
// device_platform desktop, its own build's semver as version_code, unix in ms
export const APP_ID = "3001"
export const VERSION_CODE = "4.0.1"
// the key the app hands the SDK: a placeholder, the account rides the token header
export const PLACEHOLDER_KEY = "sk-hilo-placeholder"

export function appDataDir(home = homedir(), platform = process.platform) {
  if (platform === "win32") return join(home, "AppData", "Roaming")
  if (platform === "darwin") return join(home, "Library", "Application Support")
  return join(home, ".config")
}

export function pathsFor(home = homedir(), appData) {
  const dir = join(appData || appDataDir(home), "@hilo", "desktop")
  return { dir, config: join(dir, "hub-config.json"), key: join(dir, ".token-key") }
}

// a vendor number arrives as a string ("3000", "1792347175928"); null or a
// non-number means it said nothing, which is not the same as the number zero
export function num(v) {
  if (v === null || v === undefined || v === "") return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

const b64 = (s) => Buffer.from(String(s), "base64")

// decryptToken: "v2enc:" + base64(iv):base64(tag):base64(ciphertext), iv and tag
// both 16 bytes, key .token-key (aes-256-gcm, IV_LENGTH 16, KEY_LENGTH 32 in the
// app's own bundle). Anything else is a format this plugin has not seen.
export function decryptToken(key, text) {
  const body = String(text ?? "")
  if (!body.startsWith("v2enc:")) throw new Error("令牌不是 v2enc: 格式，这个版本的落点没测过")
  const parts = body.slice("v2enc:".length).split(":")
  if (parts.length !== 3) throw new Error("v2enc: 令牌应是 iv:tag:密文 三段")
  const [iv, tag, data] = parts.map(b64)
  if (iv.length !== 16) throw new Error("v2enc: 的 iv 应是 16 字节")
  if (key.length !== 32) throw new Error(".token-key 应是 32 字节")
  const d = createDecipheriv("aes-256-gcm", key, iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(data), d.final()]).toString("utf8")
}

export function jwtPayload(token) {
  const parts = String(token ?? "").split(".")
  if (parts.length !== 3) return {}
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
  } catch {
    return {}
  }
}

// readSession: the app's own sign-in, decrypted and parsed. Throws with the path
// in the message because "which file is missing" is the thing to act on.
export function readSession(home = homedir(), appData) {
  const p = pathsFor(home, appData)
  let raw
  try {
    raw = JSON.parse(readFileSync(p.config, "utf8"))
  } catch {
    throw new Error(`${p.config} 读不到 —— 先装并登录 ${SITE_NAME}，或在插件选项里把令牌贴进 token`)
  }
  const enc = typeof raw?.tokens?.accessToken === "string" ? raw.tokens.accessToken : ""
  if (!enc) throw new Error(`${p.config} 里没有 tokens.accessToken —— ${SITE_NAME} 还没登录`)
  let key
  try {
    key = readFileSync(p.key)
  } catch {
    throw new Error(`${p.key} 读不到 —— 它和 hub-config.json 同目录，是解密令牌的 32 字节密钥`)
  }
  const token = decryptToken(key, enc)
  const claims = jwtPayload(token)
  const user = claims.user ?? {}
  return {
    token,
    // the file's own user record wins for the id: on this account the JWT's
    // user.id and hub-config.json's user.userID are different numbers
    userId: String(raw?.user?.userID ?? user.id ?? ""),
    userName: String(raw?.user?.userName ?? user.name ?? ""),
    deviceId: String(user.deviceID ?? ""),
    expires: num(claims.exp) ? claims.exp * 1000 : 0,
  }
}

export function cloudQuery(now = Date.now(), extra = {}) {
  const q = { device_platform: "desktop", app_id: APP_ID, version_code: VERSION_CODE, unix: String(now), ...extra }
  return Object.entries(q)
    .filter(([, v]) => v !== "" && v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&")
}

export function cloudHeaders(token) {
  return { token, accept: "application/json", "content-type": "application/json" }
}

// the headers the app puts on a chat: the token, and its build's version_code;
// device_id and bedrock-lane only when it has a value for them (this account's
// JWT carries an empty deviceID, so device_id goes out absent rather than empty)
export function chatHeaders({ token, versionCode = VERSION_CODE, deviceId = "" }) {
  return {
    token,
    version_code: versionCode,
    ...(deviceId ? { device_id: deviceId } : {}),
  }
}

// readCachedModels: the app keeps the last answer of /api/v1/config in the same
// file, encrypted the same way, under `lkgProviderConfig`. It is the only offline
// source there is, and on a machine with the app installed and signed in it is
// current — measured to hold the same 9 models as the live endpoint.
export function readCachedModels(home = homedir(), appData) {
  try {
    const p = pathsFor(home, appData)
    const raw = JSON.parse(readFileSync(p.config, "utf8"))
    if (typeof raw?.lkgProviderConfig !== "string" || !raw.lkgProviderConfig.startsWith("v2enc:")) return []
    return parseModels(JSON.parse(decryptToken(readFileSync(p.key), raw.lkgProviderConfig)))
  } catch {
    return []
  }
}

// parseModels: /api/v1/config's provider block, per enabled provider. The ids are
// what the hub takes (probed: "MiniMax-M2.7" plain answers 200), while the app's
// own `model`/`agent_model` fields name them as "<provider>/<id>" — that form is
// only used here to mark the default.
export function parseModels(json) {
  const providers = json?.provider ?? {}
  const order = Array.isArray(json?.enabled_providers) && json.enabled_providers.length
    ? json.enabled_providers
    : Object.keys(providers)
  const defaultModel = typeof json?.model === "string" ? json.model : ""
  const access = json?.agent_model_access ?? {}
  const out = []
  const seen = new Set()
  for (const name of order) {
    const p = providers[name]
    if (!p) continue
    const url = p?.options?.baseURL || LLM
    const npm = p.npm || NPM_ANTHROPIC
    for (const [id, m] of Object.entries(p.models ?? {})) {
      if (!id || seen.has(id)) continue
      seen.add(id)
      const lim = m?.limit ?? {}
      out.push({
        id,
        name: m?.name || id,
        group: name,
        npm,
        url,
        context: num(lim.context) ?? 0,
        output: num(lim.output) ?? 0,
        input: num(lim.input),
        attachment: m?.attachment === true,
        reasoning: m?.reasoning === true,
        toolcall: m?.tool_call === true,
        temperature: m?.temperature === true,
        modalities: m?.modalities,
        options: m?.options && typeof m.options === "object" ? m.options : {},
        default: defaultModel === `${name}/${id}`,
        requirement: access[`${name}/${id}`]?.requirement || "",
      })
    }
  }
  return out
}

// modelOf: what magpie reads. `free`/`rate` are deliberately absent until the
// vendor names a multiplier: /api/v1/config rates a model's cost 1-5 in
// agent_model_display.metrics.cost, which is not a number of credits per call and
// will not be turned into one here.
export function modelOf(m) {
  const input = m.modalities?.input ?? []
  const has = (kind) => input.includes(kind)
  return {
    id: m.id,
    providerID: PROVIDER,
    name: m.name,
    api: { id: m.id, url: m.url || LLM, npm: m.npm || NPM_ANTHROPIC },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.context || 0, output: m.output || 0 },
    capabilities: {
      temperature: m.temperature !== false,
      reasoning: !!m.reasoning,
      attachment: !!m.attachment,
      toolcall: m.toolcall !== false,
      input: { text: has("text") || input.length === 0, image: has("image"), audio: has("audio"), video: has("video"), pdf: has("pdf") },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: {},
  }
}

export function configModels(list) {
  return Object.fromEntries(
    list.map((m) => [
      m.id,
      {
        name: m.name,
        limit: { context: m.context || 0, output: m.output || 0 },
        tool_call: m.toolcall !== false,
        ...(m.default ? { options: { isDefault: true } } : {}),
      },
    ]),
  )
}

const round = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""))

// an ms-epoch stamp as a string, or nothing
const iso = (v) => {
  const t = num(v)
  return t && t > 0 ? new Date(t).toISOString() : null
}

// parseWallet: credit/wallet plus credit/balance into magpie's usage shape. One
// window per wallet (what it was granted and how much of that is left), one per
// sub_credit source so a grant that dies tonight is visible, and when the soonest
// remaining credit is lost — magpie's routing spends that first.
export function parseWallet(walletJson, balanceJson, now = Date.now()) {
  const wallets = walletJson?.wallets
  if (!Array.isArray(wallets) || !wallets.length) {
    return { error: `${SITE_NAME} 没回答积分钱包`, windows: [], signIn: "kept" }
  }
  const balance = num(balanceJson?.total_credit)
  const windows = []
  let runsOutAt = 0
  let runsOut = 0
  for (const w of wallets) {
    const total = num(w?.total_credit) ?? 0
    // a source with time on its end_time already past is spent, whatever it says
    // it holds: showing it would have routing chase credit that is gone
    const parts = (Array.isArray(w?.sub_credits) ? w.sub_credits : []).filter((s) => {
      if ((num(s?.credit) ?? 0) <= 0) return false
      const at = num(s?.end_time)
      return !(at > 0 && at <= now)
    })
    const left = parts.reduce((a, s) => a + num(s.credit), 0)
    if (total > 0) {
      const w2 = {
        name: w?.plan_name || walletName(w?.source),
        used: total - left,
        amount: total - left,
        limit: total,
        unit: "积分",
        display: `${round(left)} / ${round(total)}`,
      }
      const end = iso(w?.end_time)
      if (end) w2.resetsAt = end
      const refresh = iso(w?.next_credit_refresh_time) ?? iso(w?.next_renewal_time)
      if (refresh) w2.renewsAt = refresh
      windows.push(w2)
    }
    for (const s of parts) {
      const end = iso(s.end_time)
      const at = end ? Date.parse(end) : 0
      const credit = num(s.credit) ?? 0
      if (at > now && (!runsOutAt || at < runsOutAt)) {
        runsOutAt = at
        runsOut = credit
      } else if (at > now && at === runsOutAt) runsOut += credit
      windows.push({
        name: sourceName(s.credit_type),
        used: 0,
        amount: 0,
        limit: credit,
        unit: "积分",
        aside: true,
        display: `${round(credit)} 剩`,
        ...(end ? { resetsAt: end } : {}),
      })
    }
  }
  const out = {
    plan: wallets.find((w) => w?.plan_name)?.plan_name || "",
    balance: balance !== undefined ? `${round(balance)} 积分` : null,
    windows,
    signIn: "kept",
  }
  if (runsOutAt) {
    out.runsOutAt = new Date(runsOutAt).toISOString()
    out.runsOut = runsOut
  }
  return out
}

// the wallet carries no name for a source, only numbers: say what is known and
// keep the number in the label rather than inventing a product name
const walletName = (source) => ({ 1: "积分", 2: "会员积分" })[num(source)] ?? `积分（钱包 ${source ?? "?"}）`
const sourceName = (creditType) => ({ 1: "包月", 2: "赠送", 3: "充值" })[num(creditType)] ?? `来源 ${creditType ?? "?"}`

// signInOf: 401 with the hub's authentication_error is the account being gone;
// anything else (429, 5xx, a 400 about the body) is the request or the service and
// must not rest the account.
export function signInOf(status, text) {
  const s = String(text ?? "")
  if (status === 401) return "expired"
  if (/authentication_error|token 为空|用户未登录/.test(s)) return "expired"
  return "kept"
}
