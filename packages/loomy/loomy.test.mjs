import "./nonet.mjs"
import { test } from "bun:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  appVersion,
  authSessionPath,
  baseUrl,
  chatHeaders,
  DEFAULT_BASE,
  LoomyAuthError,
  parseBalance,
  parseModels,
  pointsBalanceUrl,
  readAuthSession,
  userHash,
} from "./loomy.mjs"
import { LoomyAuthPlugin } from "./index.mjs"

function tempDir() {
  return mkdtempSync(join(tmpdir(), "loomy-test-"))
}

function sessionFile(dir, data) {
  const file = join(dir, "auth-session.json")
  writeFileSync(file, JSON.stringify(data), "utf8")
  return file
}

test("userHash is the first 12 hex of sha256(username)", () => {
  assert.equal(userHash("cuddl"), "a3778170a790")
})

test("authSessionPath follows Loomy's Windows layout", () => {
  const opts = { platform: "win32", env: { USERNAME: "cuddl", PUBLIC: "C:/Users/Public" } }
  assert.equal(
    authSessionPath(opts),
    join("C:/Users/Public", "Loomy", "a3778170a790", "userData", "auth-session.json"),
  )
})

test("readAuthSession returns the session and refuses empty files", () => {
  const dir = tempDir()
  try {
    const file = sessionFile(dir, { session: "abc", userid: "u1", phone: "132", updatedAt: 1 })
    const found = readAuthSession({ file })
    assert.equal(found.session, "abc")
    assert.equal(found.userid, "u1")
    sessionFile(dir, { session: "", userid: "u1" })
    assert.throws(() => readAuthSession({ file }), (e) => e instanceof LoomyAuthError && e.code === "empty-session")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("baseUrl prefers LOOMY_BASE_URL, then the runtime config, then the default", () => {
  const dir = tempDir()
  try {
    const env = { LOOMY_HOME: dir }
    assert.equal(baseUrl({ env }), DEFAULT_BASE)
    mkdirSync(join(dir, "opencode"), { recursive: true })
    writeFileSync(join(dir, "opencode", "opencode.json"), JSON.stringify({ provider: { imodel: { options: { baseURL: "https://example.test/api/v1/" } } } }))
    assert.equal(baseUrl({ env }), "https://example.test/api/v1")
    assert.equal(baseUrl({ env: { LOOMY_HOME: dir, LOOMY_BASE_URL: "https://override.test/v1/" } }), "https://override.test/v1")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("appVersion reads the last version from update-trace.log", () => {
  const dir = tempDir()
  try {
    mkdirSync(join(dir, "userData"), { recursive: true })
    writeFileSync(join(dir, "userData", "update-trace.log"), '{"version":"0.9.0"}\n{"version":"0.9.39"}\n')
    assert.equal(appVersion({ env: { LOOMY_HOME: dir }, platform: "win32" }), "0.9.39")
    assert.equal(appVersion({ env: { LOOMY_HOME: dir, LOOMY_APP_VERSION: "1.2.3" }, platform: "win32" }), "1.2.3")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("chatHeaders carries both credentials and a valid traceparent", () => {
  const h = chatHeaders({ session: "s", version: "9.9.9", ids: { chatId: "c", msgId: "m" } })
  assert.equal(h.token, "s")
  assert.equal(h.Authorization, "Bearer s")
  assert.equal(h["loomy-version"], "9.9.9")
  assert.equal(h.ChatId, "c")
  assert.equal(h.MsgId, "m")
  assert.equal(h.TurnId, "m")
  assert.equal(h.InvokeOrigin, "user")
  assert.match(h.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
})

test("parseModels keeps chat models and drops image-only models", () => {
  const models = parseModels({
    data: [
      {
        id: "chat-a",
        name: "Chat A (x2.0)",
        type: "chat",
        context_length: 1000,
        max_output_tokens: 100,
        capabilities: { reasoning: true, vision: true, function_calling: true, input_modalities: ["text", "image"], output_modalities: ["text"] },
      },
      {
        id: "image-a",
        name: "Image A",
        type: "chat",
        capabilities: { output_modalities: ["image"] },
      },
      {
        id: "auto",
        name: "Auto",
        type: "chat",
      },
    ],
  })
  assert.deepEqual(models.map((m) => m.id), ["chat-a", "auto"])
  assert.equal(models[0].context, 1000)
  assert.equal(models[0].output, 100)
  assert.equal(models[0].rate, 2)
  assert.equal(models[0].tools, true)
  assert.equal(models[0].vision, true)
  assert.equal(models[1].tools, true)
})

test("the loader sends Loomy's chat headers and keeps a normal response", async () => {
  const dir = tempDir()
  const originalFetch = globalThis.fetch
  try {
    const file = sessionFile(dir, { session: "sess", userid: "u1" })
    const plugin = await LoomyAuthPlugin({}, { authSession: file, baseUrl: "https://loomy.test/api/v1", appVersion: "9.9.9" })
    let captured = null
    globalThis.fetch = async (input, init) => {
      captured = { url: String(input), init }
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } })
    }
    const loader = await plugin.auth.loader(async () => ({ type: "oauth" }))
    const res = await loader.fetch("https://loomy.test/api/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    assert.equal(res.status, 200)
    assert.equal(captured.init.headers.get("token"), "sess")
    assert.equal(captured.init.headers.get("Authorization"), "Bearer sess")
    assert.equal(captured.init.headers.get("loomy-version"), "9.9.9")
    assert.match(captured.init.headers.get("traceparent"), /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    assert.ok(captured.init.headers.get("ChatId"))
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the loader turns a 100002 envelope into a 401 with sign-in expired", async () => {
  const dir = tempDir()
  const originalFetch = globalThis.fetch
  try {
    const file = sessionFile(dir, { session: "sess", userid: "u1" })
    const plugin = await LoomyAuthPlugin({}, { authSession: file, baseUrl: "https://loomy.test/api/v1" })
    globalThis.fetch = async () => new Response(JSON.stringify({ code: "100002", desc: "登录已失效，请重新登录" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
    const loader = await plugin.auth.loader(async () => ({ type: "oauth" }))
    const res = await loader.fetch("https://loomy.test/api/v1/chat/completions", { method: "POST", body: "{}" })
    assert.equal(res.status, 401)
    assert.equal(res.headers.get("X-Magpie-Sign-In"), "expired")
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

test("parseBalance reads the account's three balances", () => {
  assert.deepEqual(
    parseBalance({ data: { balance: 5000, dailyBalance: 5000, availableBalance: 10000 } }),
    { balance: 5000, dailyBalance: 5000, availableBalance: 10000 },
  )
  assert.equal(parseBalance({ data: {} })?.availableBalance, 0)
  assert.equal(parseBalance({}), null)
})

test("pointsBalanceUrl follows the gateway's shape", () => {
  assert.equal(pointsBalanceUrl("https://loomyad.xunfei.cn/api/v1"), "https://loomyad.xunfei.cn/api/v1/points/balance")
  assert.equal(pointsBalanceUrl("https://ossptest.voicecloud.cn/loomy/integration"), "https://ossptest.voicecloud.cn/loomy/integration/api/v1/points/balance")
})

test("usage reports the available balance and its two sources", async () => {
  const dir = tempDir()
  const originalFetch = globalThis.fetch
  try {
    const file = sessionFile(dir, { session: "sess", userid: "u1" })
    const plugin = await LoomyAuthPlugin({}, { authSession: file, baseUrl: "https://loomy.test/api/v1" })
    globalThis.fetch = async () => new Response(JSON.stringify({
      code: "000000",
      data: { balance: 5000, dailyBalance: 5000, availableBalance: 10000 },
    }), { status: 200, headers: { "content-type": "application/json" } })
    const usage = await plugin.auth.usage(async () => ({ type: "oauth" }))
    assert.equal(usage.plan, "Loomy")
    assert.equal(usage.balance, "10000 积分")
    assert.equal(usage.windows.length, 2)
    assert.equal(usage.windows[0].name, "基础积分")
    assert.equal(usage.windows[1].name, "每日积分")
    assert.equal(usage.signIn, "kept")
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

test("usage marks a 100002 answer as an expired sign-in", async () => {
  const dir = tempDir()
  const originalFetch = globalThis.fetch
  try {
    const file = sessionFile(dir, { session: "sess", userid: "u1" })
    const plugin = await LoomyAuthPlugin({}, { authSession: file, baseUrl: "https://loomy.test/api/v1" })
    globalThis.fetch = async () => new Response(JSON.stringify({ code: "100002", desc: "登录已失效，请重新登录" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
    const usage = await plugin.auth.usage(async () => ({ type: "oauth" }))
    assert.equal(usage.signIn, "expired")
    assert.match(usage.error, /登录已失效/)
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})

test("provider.models reads /models and maps only chat models", async () => {
  const dir = tempDir()
  const originalFetch = globalThis.fetch
  try {
    const file = sessionFile(dir, { session: "sess", userid: "u1" })
    const plugin = await LoomyAuthPlugin({}, { authSession: file, baseUrl: "https://loomy.test/api/v1" })
    globalThis.fetch = async () => new Response(JSON.stringify({
      data: [
        { id: "chat-a", name: "Chat A", type: "chat", context_length: 10, max_output_tokens: 5, capabilities: { output_modalities: ["text"], function_calling: true } },
        { id: "image-a", name: "Image A", type: "chat", capabilities: { output_modalities: ["image"] } },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } })
    const models = await plugin.provider.models({ models: {} }, { auth: { type: "api", key: "sess" } })
    assert.ok(models["chat-a"])
    assert.equal(models["image-a"], undefined)
    assert.equal(models["chat-a"].limit.context, 10)
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
})
