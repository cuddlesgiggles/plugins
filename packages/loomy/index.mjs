// OpenCode/magpie provider plugin for Loomy (iFlytek's desktop agent).
//
// Loomy's own app stores a session in auth-session.json; its OpenAI-compatible
// gateway lives at the base URL in its runtime opencode.json. This plugin reads
// that session per request (never copies it), asks /models, and relays
// /chat/completions with the headers Loomy's client sends — token,
// Authorization, traceparent (a request without it hangs), loomy-version and
// the ChatId/MsgId/TurnId ids.
import { statSync } from "node:fs"
import {
  appVersion,
  authSessionPath,
  baseUrl,
  chatHeaders,
  configModels,
  FALLBACK_MODELS,
  modelOf,
  parseBalance,
  parseModels,
  pointsBalanceUrl,
  PROVIDER,
  readAuthSession,
  SITE_NAME,
  LoomyAuthError,
} from "./loomy.mjs"

function stampOf(file) {
  try {
    const s = statSync(file)
    return `${s.mtimeMs}:${s.size}`
  } catch {
    return "missing"
  }
}

export const LoomyAuthPlugin = async (_input, options = {}) => {
  const opts = {
    home: options.home,
    platform: options.platform,
    env: options.env,
    file: options.authSession,
    baseUrl: options.baseUrl,
    appVersion: options.appVersion,
  }
  const pinned = typeof options.token === "string" && options.token.trim() ? options.token.trim() : ""
  let cache = { stamp: "", session: null }

  function sessionFromFile() {
    const file = authSessionPath(opts)
    const stamp = stampOf(file)
    if (cache.stamp === stamp && cache.session) return cache.session
    const found = readAuthSession(opts)
    cache = { stamp, session: found }
    return found
  }

  async function sessionFor(auth) {
    if (auth?.type === "api" && String(auth.key ?? "").trim()) {
      return { session: String(auth.key).trim(), userid: "", phone: "", file: "" }
    }
    if (pinned) return { session: pinned, userid: "", phone: "", file: "" }
    return sessionFromFile()
  }

  const base = baseUrl(opts)

  async function fetchModels(auth) {
    const found = await sessionFor(auth)
    const res = await fetch(`${base}/models`, {
      method: "GET",
      headers: { Accept: "application/json", token: found.session },
      signal: AbortSignal.timeout(20000),
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    if (!res.ok) throw new Error(`${SITE_NAME} /models HTTP ${res.status}`)
    if (json?.code && String(json.code) !== "000000") throw new Error(String(json.desc || `${SITE_NAME} code ${json.code}`))
    const models = parseModels(json)
    return models.length ? models : FALLBACK_MODELS
  }

  // Loomy answers a failed call as HTTP 200 with {code, desc}. Magpie needs a
  // real status so it can rest the account or fail over; 100002 is the
  // session-expired code its own client clears the token on.
  async function envelope(res) {
    if (res.status < 200 || res.status >= 300) return res
    const type = res.headers.get("content-type") || ""
    if (!type.includes("application/json")) return res
    let json = null
    try { json = JSON.parse(await res.clone().text()) } catch {}
    if (!json || json.code == null) return res
    const code = String(json.code)
    if (code === "000000") return res
    const status = code === "100002" ? 401 : 502
    const headers = new Headers(res.headers)
    headers.delete("content-length")
    headers.delete("content-encoding")
    headers.set("content-type", "application/json; charset=utf-8")
    if (code === "100002") headers.set("X-Magpie-Sign-In", "expired")
    return new Response(JSON.stringify({
      error: { message: String(json.desc || json.message || `${SITE_NAME} code ${code}`), type: "loomy_error", code },
    }), { status, headers })
  }

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {}
      const pr = cfg.provider[PROVIDER]
      pr.name ??= SITE_NAME
      pr.npm ??= "@ai-sdk/openai-compatible"
      pr.api ??= base
      pr.models = { ...configModels(FALLBACK_MODELS), ...(pr.models ?? {}) }
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        try {
          const models = await fetchModels(auth)
          return Object.fromEntries(models.map((m) => [m.id, modelOf(m, base)]))
        } catch {
          return provider.models
        }
      },
    },

    auth: {
      provider: PROVIDER,
      methods: [
        {
          type: "oauth",
          label: `${SITE_NAME} 桌面端的登录`,
          async authorize() {
            return {
              url: "",
              instructions: `先在 ${SITE_NAME} 客户端完成登录；这个插件只读本机的 ${SITE_NAME} 登录态，不复制账号。`,
              method: "auto",
              async callback() {
                try {
                  const found = readAuthSession(opts)
                  return {
                    type: "success",
                    refresh: "",
                    access: "",
                    expires: 0,
                    source: "desktop",
                    accountId: found.userid || found.phone || SITE_NAME,
                  }
                } catch (e) {
                  return { type: "failed", error: e?.message ?? String(e) }
                }
              },
            }
          },
        },
        {
          type: "api",
          label: `${SITE_NAME} session（auth-session.json 里的 session）`,
          placeholder: "Loomy session",
        },
      ],

      // The points card: availableBalance is what the account can spend now;
      // balance and dailyBalance are the two sources it is made of. The
      // endpoint answers {code:"000000",data:{balance,dailyBalance,
      // availableBalance}}; 100002 is the same expired-session code as chat.
      async usage(getAuth) {
        try {
          const found = await sessionFor(await getAuth())
          const res = await fetch(pointsBalanceUrl(base), {
            method: "GET",
            headers: { Accept: "application/json", token: found.session },
            signal: AbortSignal.timeout(20000),
          })
          const text = await res.text()
          let json = null
          try { json = JSON.parse(text) } catch {}
          if (!res.ok) return { error: `${SITE_NAME} 积分 HTTP ${res.status}`, windows: [], signIn: "kept" }
          if (json?.code && String(json.code) !== "000000") {
            return {
              error: String(json.desc || `${SITE_NAME} code ${json.code}`),
              windows: [],
              signIn: String(json.code) === "100002" ? "expired" : "kept",
            }
          }
          const points = parseBalance(json)
          if (!points) return { error: `${SITE_NAME} 没有回答积分余额`, windows: [], signIn: "kept" }
          const sources = [
            { name: "基础积分", display: `${points.balance} 积分`, unit: "points", aside: true },
            ...(points.dailyBalance
              ? [{ name: "每日积分", display: `${points.dailyBalance} 积分`, unit: "points", aside: true }]
              : []),
          ]
          return {
            plan: SITE_NAME,
            balance: `${points.availableBalance} 积分`,
            windows: sources,
            signIn: "kept",
          }
        } catch (e) {
          return { error: e?.message ?? String(e), windows: [], signIn: "kept" }
        }
      },

      async loader(getAuth) {
        const auth = await getAuth()
        const found = await sessionFor(auth)
        const version = appVersion(opts)
        return {
          baseURL: baseUrl(opts),
          apiKey: found.session,
          async fetch(input, init) {
            const url = new URL(typeof input === "string" ? input : input?.url)
            const method = String(init?.method ?? (typeof input === "object" ? input?.method : "") ?? "GET").toUpperCase()
            const headers = new Headers(init?.headers ?? (typeof input === "object" ? input?.headers : undefined) ?? {})
            headers.set("token", found.session)
            if (url.pathname.replace(/\/+$/, "").endsWith("/chat/completions")) {
              const chat = chatHeaders({ session: found.session, version })
              for (const [k, v] of Object.entries(chat)) headers.set(k, v)
            } else if (method !== "GET") {
              headers.set("Authorization", `Bearer ${found.session}`)
            }
            const res = await fetch(input, { ...init, headers })
            return envelope(res)
          },
        }
      },
    },
  }
}

export const _internal = { sessionFile: authSessionPath, LoomyAuthError }
