import { test } from "node:test"
import assert from "node:assert/strict"
import { createCipheriv, randomBytes } from "node:crypto"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  APP_ID,
  CLOUD,
  LLM,
  PLACEHOLDER_KEY,
  PROVIDER,
  VERSION_CODE,
  appDataDir,
  chatHeaders,
  cloudHeaders,
  cloudQuery,
  configModels,
  decryptToken,
  jwtPayload,
  modelOf,
  num,
  parseModels,
  parseWallet,
  pathsFor,
  readCachedModels,
  readSession,
  signInOf,
} from "../hilo.mjs"
import { MiniMaxDesignAuthPlugin } from "../index.mjs"

const KEY = randomBytes(32)

// the app's own envelope: v2enc: + base64(iv16):base64(tag16):base64(ciphertext)
function encrypt(plain, key = KEY) {
  const iv = randomBytes(16)
  const c = createCipheriv("aes-256-gcm", key, iv)
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()])
  return "v2enc:" + [iv, c.getAuthTag(), data].map((b) => b.toString("base64")).join(":")
}

const jwt = (claims) => {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
  return `${b({ alg: "HS256", typ: "JWT" })}.${b(claims)}.sig`
}

const dirs = []
function fixture(files) {
  const root = mkdirSync(join(tmpdir(), "hilo-" + randomBytes(6).toString("hex")), { recursive: true })
  dirs.push(root)
  const appData = join(root, "AppData", "Roaming")
  const dir = join(appData, "@hilo", "desktop")
  mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  return { root, appData, dir }
}

test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

test("paths: where the sign-in lives on each platform", () => {
  assert.equal(appDataDir("/home/u", "win32"), join("/home/u", "AppData", "Roaming"))
  assert.equal(appDataDir("/home/u", "darwin"), join("/home/u", "Library", "Application Support"))
  assert.equal(appDataDir("/home/u", "linux"), join("/home/u", ".config"))
  const p = pathsFor("/home/u", "/ad")
  assert.equal(p.dir, join("/ad", "@hilo", "desktop"))
  assert.ok(p.config.endsWith(join("@hilo", "desktop", "hub-config.json")))
  assert.ok(p.key.endsWith(join("@hilo", "desktop", ".token-key")))
})

test("decryptToken: the v2enc envelope, and every way it can be wrong", () => {
  assert.equal(decryptToken(KEY, encrypt("hello")), "hello")
  assert.throws(() => decryptToken(KEY, encrypt("hello").slice(0, -6) + "AAAA"), /v2enc|auth|Unsupported|unable/i)
  assert.throws(() => decryptToken(KEY, "plain-text"), /v2enc: 格式/)
  assert.throws(() => decryptToken(KEY, "v2enc:aaa:bbb"), /三段/)
  assert.throws(() => decryptToken(randomBytes(8), encrypt("x")), /32 字节/)
})

test("readSession: decrypts the app's token and says which file was missing", () => {
  const token = jwt({ exp: 1795543971, user: { id: "440000000000000001", name: "示例", deviceID: "" } })
  const { appData } = fixture({
    "hub-config.json": JSON.stringify({ tokens: { accessToken: encrypt(token), adAttribution: null }, user: { userID: "440000000000000002", userName: "示例用户" }, lkgProviderConfig: "" }),
    ".token-key": KEY,
  })
  const s = readSession("/unused", appData)
  assert.equal(s.token, token)
  // the file's own record wins over the JWT for the id, and they differ on this account
  assert.equal(s.userId, "440000000000000002")
  assert.equal(s.userName, "示例用户")
  assert.equal(s.deviceId, "")
  assert.equal(s.expires, 1795543971 * 1000)

  const noToken = fixture({ "hub-config.json": JSON.stringify({ tokens: { accessToken: "" } }), ".token-key": KEY })
  assert.throws(() => readSession("/unused", noToken.appData), /还没登录/)

  const noKey = fixture({ "hub-config.json": JSON.stringify({ tokens: { accessToken: encrypt("a.b.c") } }) })
  assert.throws(() => readSession("/unused", noKey.appData), /\.token-key/)

  const noFile = pathsFor("/nope", "/nope-appdata")
  assert.throws(() => readSession("/nope", "/nope-appdata"), (e) => String(e).includes(noFile.config))
})

test("cloudQuery and the header sets are the app's own", () => {
  const q = cloudQuery(1760000000000)
  assert.match(q, /device_platform=desktop/)
  assert.match(q, new RegExp(`app_id=${APP_ID}`))
  assert.match(q, new RegExp(`version_code=${VERSION_CODE}`))
  assert.match(q, /unix=1760000000000/)
  assert.equal(cloudQuery(1, { group_id: "" }).includes("group_id"), false, "an empty param is dropped, not sent blank")
  assert.deepEqual(cloudHeaders("T"), { token: "T", accept: "application/json", "content-type": "application/json" })
  assert.deepEqual(chatHeaders({ token: "T" }), { token: "T", version_code: VERSION_CODE })
  assert.equal(chatHeaders({ token: "T", deviceId: "d1" }).device_id, "d1")
  assert.equal(chatHeaders({ token: "T", versionCode: "9.9.9" }).version_code, "9.9.9")
})

// field names verbatim from the live /api/v1 answer, 2026-10-17
const CONFIG = {
  model: "minimaxHub/MiniMax-M3",
  enabled_providers: ["minimaxHub", "alpha", "gamma"],
  provider: {
    minimaxHub: {
      npm: "@ai-sdk/anthropic",
      options: { baseURL: "https://hub.minimaxi.com/api/v1" },
      models: {
        "MiniMax-M2.7": { name: "MiniMax-M2.7", attachment: true, reasoning: true, tool_call: true, temperature: true, modalities: { input: ["text", "image"], output: ["text"] }, limit: { context: 196608, input: 180000, output: 128000 } },
        "MiniMax-M3": { name: "MiniMax-M3", attachment: true, reasoning: true, tool_call: true, temperature: true, modalities: { input: ["text", "image"], output: ["text"] }, limit: { context: 196608, output: 128000 } },
      },
    },
    alpha: {
      npm: "@ai-sdk/anthropic",
      options: { baseURL: "https://hub.minimaxi.com/api/v1" },
      models: {
        alpha: { name: "Gamma-Op 5.5", reasoning: true, tool_call: true, options: { thinking: { type: "adaptive" }, effort: "medium" }, modalities: { input: ["text", "image", "pdf"], output: ["text"] }, limit: { context: 400000, output: 128000 } },
        // a row that names no limits: every live model here carries a limit, so
        // this shape is the vendor's absence of an answer, not an observed row
        alpha_nolimit: { name: "No limits", reasoning: true },
        "MiniMax-M3": { name: "shadowed by the first provider", limit: { context: 1, output: 1 } },
      },
    },
    gamma: {
      npm: "@ai-sdk/openai",
      options: { baseURL: "https://hub.minimaxi.com/api/v1" },
      models: { gamma: { name: "Gamma", tool_call: true, temperature: true, attachment: true, reasoning: true, modalities: { input: ["text", "image"], output: ["text"] }, limit: { context: 262000, input: 270000, output: 128000 }, options: { store: false, reasoningEffort: "low" } } },
    },
    disabledOne: { npm: "@ai-sdk/anthropic", models: { nope: { name: "not enabled" } } },
  },
  agent_model_access: { "alpha/alpha": { order: 20, requirement: "membership" } },
}

test("parseModels: enabled providers only, first id wins, the vendor's own default", () => {
  const ms = parseModels(CONFIG)
  assert.deepEqual(ms.map((m) => m.id), ["MiniMax-M2.7", "MiniMax-M3", "alpha", "alpha_nolimit", "gamma"])
  assert.equal(ms.find((m) => m.id === "MiniMax-M3").group, "minimaxHub", "a duplicate id is kept from the earlier provider, not shadowed")
  assert.equal(ms.find((m) => m.id === "MiniMax-M3").name, "MiniMax-M3")
  assert.equal(ms.find((m) => m.id === "MiniMax-M3").default, true)
  assert.equal(ms.find((m) => m.id === "alpha").requirement, "membership")
  assert.equal(ms.find((m) => m.id === "alpha").npm, "@ai-sdk/anthropic")
  assert.equal(ms.find((m) => m.id === "gamma").npm, "@ai-sdk/openai")
  assert.equal(ms.some((m) => m.id === "nope"), false, "a provider outside enabled_providers is not served")
  assert.equal(ms.find((m) => m.id === "MiniMax-M2.7").context, 196608)
  assert.equal(ms.find((m) => m.id === "alpha_nolimit").context, 0, "no limit row means no limit, not a borrowed one")
  assert.equal(modelOf(ms.find((m) => m.id === "alpha_nolimit")).limit.context, 0)
  assert.deepEqual(parseModels(null), [])
})

test("modelOf: per-model protocol and url, capabilities from the vendor's fields, no invented price", () => {
  const m = modelOf(parseModels(CONFIG).find((x) => x.id === "gamma"))
  assert.equal(m.providerID, PROVIDER)
  assert.equal(m.api.url, "https://hub.minimaxi.com/api/v1")
  assert.equal(m.api.npm, "@ai-sdk/openai")
  assert.equal(m.api.id, "gamma")
  assert.deepEqual(m.limit, { context: 262000, output: 128000 })
  assert.equal(m.capabilities.toolcall, true)
  assert.equal(m.capabilities.input.image, true)
  assert.equal(m.capabilities.input.pdf, false)
  // the vendor names no multiplier anywhere here, so the picker must not either
  assert.equal("free" in m, false)
  assert.equal("rate" in m, false)
  const alpha = modelOf(parseModels(CONFIG).find((x) => x.id === "alpha"))
  assert.equal(alpha.capabilities.input.pdf, true)
  assert.equal(alpha.capabilities.reasoning, true)
  assert.deepEqual(configModels(parseModels(CONFIG)).gamma, { name: "Gamma", limit: { context: 262000, output: 128000 }, tool_call: true })
  assert.equal(configModels(parseModels(CONFIG))["MiniMax-M3"].options.isDefault, true)
})

test("readCachedModels: the app's last-known-good config, encrypted in the same file", () => {
  const cfg = JSON.stringify(CONFIG)
  const good = fixture({ "hub-config.json": JSON.stringify({ tokens: { accessToken: "x" }, lkgProviderConfig: encrypt(cfg) }), ".token-key": KEY })
  assert.equal(readCachedModels("/unused", good.appData).length, 5)
  const plain = fixture({ "hub-config.json": JSON.stringify({ lkgProviderConfig: cfg }), ".token-key": KEY })
  assert.deepEqual(readCachedModels("/unused", plain.appData), [], "not v2enc means this plugin has not seen it")
  const nothing = fixture({ "hub-config.json": "{}", ".token-key": KEY })
  assert.deepEqual(readCachedModels("/unused", nothing.appData), [])
})

// field names verbatim from the live credit/wallet and credit/balance, 2026-10-17;
// times are offsets so the story they tell does not rot
const NOW = Date.parse("2026-10-17T06:00:00Z")
const DAY = 86400000
const WALLET = {
  can_migrate: false,
  wallets: [
    {
      source: 1,
      plan_name: "",
      total_credit: "3000",
      debit_credit: "0",
      privilege_type: 0,
      end_time: String(NOW + 90 * DAY),
      next_credit_refresh_time: String(NOW + 90 * DAY),
      subscription_state_known: true,
      sub_credits: [
        { credit_type: 2, credit: "100", end_time: String(NOW + DAY), records: [{ credit: "100", end_time: String(NOW + DAY) }] },
        { credit_type: 1, credit: "2900", end_time: String(NOW + 90 * DAY), records: [{ credit: "2900", end_time: String(NOW + 90 * DAY) }] },
        { credit_type: 3, credit: "0", end_time: String(NOW + DAY), records: [] },
        { credit_type: 2, credit: "500", end_time: String(NOW - DAY), records: [{ credit: "500", end_time: String(NOW - DAY) }] },
      ],
    },
  ],
}

test("parseWallet: a window per wallet and per source, soonest loss first", () => {
  const u = parseWallet(WALLET, { total_credit: "3000" }, NOW)
  assert.equal(u.balance, "3000 积分")
  assert.equal(u.windows[0].limit, 3000)
  assert.equal(u.windows[0].amount, 0, "3000 of 3000 still usable, once the expired grant is dropped")
  assert.equal(u.windows[0].display, "3000 / 3000")
  assert.equal(u.windows[0].resetsAt, new Date(NOW + 90 * DAY).toISOString())
  assert.equal(u.windows[0].renewsAt, new Date(NOW + 90 * DAY).toISOString())
  const aside = u.windows.filter((w) => w.aside)
  assert.equal(aside.length, 2, "a source with nothing left, or with its time past, is not shown")
  assert.deepEqual(aside.map((w) => w.display), ["100 剩", "2900 剩"])
  assert.equal(aside[0].name, "赠送")
  assert.equal(aside[1].name, "包月")
  assert.equal(aside[0].resetsAt, new Date(NOW + DAY).toISOString())
  assert.equal(u.runsOut, 100)
  assert.equal(u.runsOutAt, new Date(NOW + DAY).toISOString())
  assert.equal(u.signIn, "kept")
  // the numbers arrive as strings; a missing one says so rather than reading as 0
  assert.equal(num("3000"), 3000)
  assert.equal(num(null), undefined)
  assert.equal(num("abc"), undefined)
  const empty = parseWallet({ wallets: [] }, {}, NOW)
  assert.match(empty.error, /没回答积分钱包/)
  assert.deepEqual(parseWallet(null, null, NOW).windows, [])
})

test("signInOf: only the hub's own words about the account rest it", () => {
  assert.equal(signInOf(401, '{"type":"error","error":{"type":"authentication_error","message":"token is malformed"}}'), "expired")
  assert.equal(signInOf(200, '{"error":{"message":"token 为空"},"user_message":"用户未登录，请登录后重试"}'), "expired")
  assert.equal(signInOf(429, "Rate Limited"), "kept")
  assert.equal(signInOf(400, '{"error":{"type":"invalid_request_error","message":"messages: at least one is required"}}'), "kept")
  assert.equal(signInOf(500, ""), "kept")
})

test("the plugin declares the provider from the app's cache and not from thin air", async () => {
  const f = fixture({ "hub-config.json": JSON.stringify({ tokens: { accessToken: "" }, lkgProviderConfig: encrypt(JSON.stringify(CONFIG)) }), ".token-key": KEY })
  const hooks = await MiniMaxDesignAuthPlugin({}, { home: "/unused", userData: f.appData, token: jwt({ exp: 1795543971, user: { id: "u1" } }) })
  const cfg = {}
  await hooks.config(cfg)
  const pr = cfg.provider[PROVIDER]
  assert.equal(pr.name, "MiniMax Design")
  assert.equal(pr.api, LLM)
  assert.deepEqual(Object.keys(pr.models).sort(), ["MiniMax-M2.7", "MiniMax-M3", "alpha", "alpha_nolimit", "gamma"])

  const bare = fixture({ "hub-config.json": "{}", ".token-key": KEY })
  const h2 = await MiniMaxDesignAuthPlugin({}, { home: "/unused", userData: bare.appData, token: "T" })
  const c2 = {}
  await h2.config(c2)
  assert.equal("models" in c2.provider[PROVIDER], false, "with nothing cached it declares the provider but invents no list")
})

test("provider.models: live answer, else the cache, else magpie's own", async () => {
  const f = fixture({ "hub-config.json": JSON.stringify({ lkgProviderConfig: encrypt(JSON.stringify(CONFIG)) }), ".token-key": KEY })
  const hooks = await MiniMaxDesignAuthPlugin({}, { home: "/unused", userData: f.appData, token: jwt({ exp: 1, user: {} }) })
  const real = globalThis.fetch
  try {
    let seen = ""
    globalThis.fetch = async (url) => {
      seen = String(url)
      return new Response(JSON.stringify(CONFIG), { status: 200, headers: { "content-type": "application/json" } })
    }
    const ms = await hooks.provider.models({ models: { keep: 1 } }, { auth: { type: "oauth" } })
    assert.match(seen, new RegExp(`^${CLOUD}/api\\?v1/config|${CLOUD}/api/v1/config`))
    assert.equal(Object.keys(ms).length, 5)
    assert.equal(ms["gamma"].api.npm, "@ai-sdk/openai")
    globalThis.fetch = async () => {
      throw new Error("unreachable")
    }
    const cached = await hooks.provider.models({ models: { keep: 1 } }, { auth: { type: "oauth" } })
    assert.equal(Object.keys(cached).length, 5, "the app's last-known-good carries it when the endpoint is down")
  } finally {
    globalThis.fetch = real
  }
})

test("loader: the token rides the token header, the placeholder stays the key", async () => {
  const token = jwt({ exp: 1, user: { deviceID: "dev-9" } })
  const f = fixture({ "hub-config.json": JSON.stringify({ tokens: { accessToken: encrypt(token) }, user: { userID: "u9" } }), ".token-key": KEY })
  const hooks = await MiniMaxDesignAuthPlugin({}, { home: "/unused", userData: f.appData })
  const loader = await hooks.auth.loader(async () => ({ type: "oauth" }))
  assert.equal(loader.apiKey, PLACEHOLDER_KEY)
  assert.equal(loader.baseURL, LLM)
  const real = globalThis.fetch
  try {
    let sent = null
    globalThis.fetch = async (_u, init) => {
      sent = init.headers
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    }
    await loader.fetch(LLM + "/messages", { method: "POST", headers: { "x-api-key": PLACEHOLDER_KEY, "content-type": "application/json" }, body: "{}" })
    assert.equal(sent.get("token"), token)
    assert.equal(sent.get("version_code"), VERSION_CODE)
    assert.equal(sent.get("device_id"), "dev-9", "the JWT's deviceID goes out when it has one")
    assert.equal(sent.get("x-api-key"), PLACEHOLDER_KEY, "the SDK's placeholder key stays")
    globalThis.fetch = async () => new Response('{"error":{"type":"authentication_error","message":"token is malformed"}}', { status: 401 })
    const bad = await loader.fetch(LLM + "/messages", { method: "POST", body: "{}" })
    assert.equal(bad.headers.get("X-Magpie-Sign-In"), "expired")
    globalThis.fetch = async () => new Response("upstream busy", { status: 503 })
    const busy = await loader.fetch(LLM + "/messages", { method: "POST", body: "{}" })
    assert.equal(busy.headers.get("X-Magpie-Sign-In"), "kept")
  } finally {
    globalThis.fetch = real
  }
})

test("usage: wallet and balance together, a refused one reported as the account", async () => {
  const hooks = await MiniMaxDesignAuthPlugin({}, { home: "/unused", token: jwt({ exp: 1, user: {} }) })
  const real = globalThis.fetch
  try {
    const urls = []
    globalThis.fetch = async (url) => {
      urls.push(String(url))
      const body = String(url).includes("credit/wallet") ? WALLET : { total_credit: "3000" }
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
    }
    const u = await hooks.auth.usage(async () => ({ type: "oauth" }))
    assert.equal(urls.length, 2)
    assert.match(urls[0], /credit\/wallet/)
    assert.match(urls[1], /credit\/balance/)
    assert.equal(u.balance, "3000 积分")
    assert.equal(u.runsOut, 100)
    globalThis.fetch = async () => new Response('{"error":{"message":"token 为空","user_message":"用户未登录"}}', { status: 401 })
    const dead = await hooks.auth.usage(async () => ({ type: "oauth" }))
    assert.equal(dead.signIn, "expired")
    assert.match(dead.error, /HTTP 401/)
  } finally {
    globalThis.fetch = real
  }
})

test("the desktop method reports the token's own end, since nothing renews it", async () => {
  const token = jwt({ exp: 1795543971, user: { id: "440000000000000001" } })
  const f = fixture({ "hub-config.json": JSON.stringify({ tokens: { accessToken: encrypt(token) }, user: { userID: "440000000000000002", userName: "示例用户" } }), ".token-key": KEY })
  const hooks = await MiniMaxDesignAuthPlugin({}, { home: "/unused", userData: f.appData })
  const m = hooks.auth.methods[0]
  const flow = await m.authorize()
  const r = await flow.callback()
  assert.equal(r.type, "success")
  assert.equal(r.source, "desktop")
  assert.equal(r.accountId, "440000000000000002")
  assert.equal(r.expires, 1795543971 * 1000)
  assert.equal(r.refresh, "", "no refresh token in the file, so nothing to renew with")

  const empty = await MiniMaxDesignAuthPlugin({}, { home: "/nope", userData: "/nope-ad" })
  const fr = await empty.auth.methods[0].authorize()
  const failed = await fr.callback()
  assert.equal(failed.type, "failed")
  assert.match(failed.error, /hub-config\.json/)
})
