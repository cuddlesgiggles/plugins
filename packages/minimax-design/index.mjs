// MiniMax Design (internal name Hilo) as a magpie provider: the models its own
// account is offered, billed against its own credit wallet, with magpie's usual
// routing, failover and quota handling on top.
//
// The token is read from the app's files per request and never written into
// magpie's auth file: the app rewrites hub-config.json as it renews its session,
// and a stored copy would be a second, staler holder of it. There is no refresh
// token in that file, so when the JWT's own exp passes the only fix is signing in
// again in the app — which is what the expired mark tells the user to do.
import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import {
  CLOUD,
  LLM,
  PLACEHOLDER_KEY,
  PROVIDER,
  SITE_NAME,
  VERSION_CODE,
  chatHeaders,
  cloudHeaders,
  cloudQuery,
  configModels,
  jwtPayload,
  modelOf,
  parseModels,
  parseWallet,
  pathsFor,
  readCachedModels,
  readSession,
  signInOf,
} from "./hilo.mjs"

const CONFIG_URL = CLOUD + "/api/v1/config"
const WALLET_URL = CLOUD + "/api/v1/credit/wallet"
const BALANCE_URL = CLOUD + "/api/v1/credit/balance"

async function getJSON(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, text, json }
}

export const MiniMaxDesignAuthPlugin = async (_input, options = {}) => {
  const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : "")
  const home = str(options.home) || homedir()
  const appData = str(options.userData) || undefined
  const pinned = str(options.token)
  const versionCode = str(options.versionCode) || VERSION_CODE
  // the app rewrites hub-config.json when its session changes, so the cache keys
  // on what is on disk rather than on time
  let cache = { stamp: "", session: null }

  async function sessionNow() {
    if (pinned) {
      const claims = jwtPayload(pinned)
      return { token: pinned, userId: String(claims?.user?.id ?? ""), deviceId: str(options.deviceId), expires: claims?.exp ? claims.exp * 1000 : 0 }
    }
    const p = pathsFor(home, appData)
    const stamp = [statSync(p.config).mtimeMs, statSync(p.key).mtimeMs].join("|")
    if (cache.stamp !== stamp || !cache.session) cache = { stamp, session: readSession(home, appData) }
    return cache.session
  }

  // which sign-in an account names: a pasted token wins, else the app's own
  async function bearerFor(auth) {
    if (auth?.type === "api" && str(auth.key)) return { token: str(auth.key), deviceId: "", expires: 0 }
    return await sessionNow()
  }

  const cloud = (token) => cloudHeaders(token)

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {}
      const pr = cfg.provider[PROVIDER]
      pr.name ??= SITE_NAME
      pr.npm ??= "@ai-sdk/anthropic"
      pr.api ??= LLM
      const local = readCachedModels(home, appData)
      if (local.length) pr.models = { ...configModels(local), ...(pr.models ?? {}) }
    },

    provider: {
      id: PROVIDER,
      // the account's own directory; a refused or unreachable answer keeps
      // whatever the app last cached, and with neither, magpie's list
      async models(provider, { auth } = {}) {
        let list = []
        try {
          const r = await getJSON(`${CONFIG_URL}?${cloudQuery()}`, cloud((await bearerFor(auth)).token))
          list = r.json ? parseModels(r.json) : []
        } catch {}
        if (!list.length) list = readCachedModels(home, appData)
        return list.length ? Object.fromEntries(list.map((m) => [m.id, modelOf(m)])) : provider.models
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
              instructions: `用 ${SITE_NAME} 自己已登录的账号：解它本地存的访问令牌（同目录 .token-key 的 AES-256-GCM），不复制过来。`,
              method: "auto",
              async callback() {
                try {
                  const s = await sessionNow()
                  return {
                    type: "success",
                    refresh: "",
                    access: "",
                    // the JWT says when it dies; there is nothing here to renew it
                    expires: s.expires || 0,
                    source: "desktop",
                    accountId: s.userId || SITE_NAME,
                  }
                } catch (e) {
                  return { type: "failed", error: e?.message ?? String(e) }
                }
              },
            }
          },
        },
        { type: "api", label: `${SITE_NAME} 访问令牌（token 头）`, placeholder: "eyJ…" },
      ],

      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "oauth" && auth?.type !== "api") return {}
        return {
          baseURL: LLM,
          // what the app hands the SDK: a placeholder, the account goes in `token`
          apiKey: PLACEHOLDER_KEY,
          async fetch(input, init) {
            const s = await bearerFor(await getAuth())
            const headers = new Headers(init?.headers ?? input?.headers)
            for (const [k, v] of Object.entries(chatHeaders({ token: s.token, versionCode, deviceId: s.deviceId }))) headers.set(k, v)
            headers.delete("content-length")
            const res = await fetch(input, { ...init, headers })
            if (res.status < 400) return res
            const text = await res.clone().text().catch(() => "")
            const out = new Headers(res.headers)
            out.delete("content-length")
            out.delete("content-encoding")
            out.set("X-Magpie-Sign-In", signInOf(res.status, text))
            return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
          },
        }
      },

      // credits: one window per wallet, one per source, and when the soonest of
      // what is left is lost (magpie's routing spends that first)
      async usage(getAuth) {
        try {
          const h = cloud((await bearerFor(await getAuth())).token)
          const qs = cloudQuery()
          const wallet = await getJSON(`${WALLET_URL}?${qs}`, h)
          const balance = await getJSON(`${BALANCE_URL}?${qs}`, h)
          if (wallet.status >= 400 || !wallet.json) {
            return {
              error: `${SITE_NAME} 的积分钱包没答上（HTTP ${wallet.status}）`,
              windows: [],
              signIn: signInOf(wallet.status, wallet.text),
            }
          }
          return parseWallet(wallet.json, balance.json)
        } catch (e) {
          return { error: e?.message ?? String(e), windows: [], signIn: "kept" }
        }
      },
    },
  }
}

export const _internal = { getJSON, CONFIG_URL, WALLET_URL, BALANCE_URL }
