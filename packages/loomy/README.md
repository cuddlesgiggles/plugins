# @magpie-community/opencode-loomy-auth

Loomy (iFlytek's desktop agent, `loomy.xunfei.cn`) as a magpie provider: its
OpenAI-compatible chat models and points appear as `loomy/<model>` for every
agent magpie drives. Provider id: `loomy`.

> **Unofficial.** This package is not affiliated with, authorized or endorsed by
> iFlytek or Loomy. It reads Loomy's local session and talks to the non-public
> gateway the Loomy desktop client uses. That may violate Loomy's terms of
> service (including its prohibition on reverse engineering and on using points
> outside its platform), and your account may be restricted or banned. Use it at
> your own risk.

**Status:** tested on Windows with Loomy 0.9.39 on 2026-10-23. `/models` returned
13 models, 10 of them chat models; `spark-x2.6` answered both streamed and
non-streamed requests; the points card read 10000 (5000 base + 5000 daily).
14 offline tests pass.

## Install

```sh
magpie plugin add @magpie-community/opencode-loomy-auth
magpie plugin login loomy
```

## Sign-in

The desktop sign-in reads the session Loomy itself stores; nothing is copied
into magpie:

- Windows: `C:\Users\Public\Loomy\<sha256(username)[:12]>\userData\auth-session.json`
- macOS: `~/Library/Application Support/Loomy/auth-session.json`
- Linux: `~/.config/Loomy/auth-session.json`

`LOOMY_AUTH_SESSION` can point at another file. A missing or empty `session`
fails with a message asking you to sign in to Loomy first.

A machine without Loomy can use the second method and paste the `session`
string from that file; it is then stored in magpie's plugin sign-in only.

## Base URL and requests

The plugin reads Loomy's runtime `opencode/opencode.json` and uses
`provider.imodel.options.baseURL`; the fallback is the production gateway:

```
https://loomyad.xunfei.cn/api/v1
```

Order: `LOOMY_BASE_URL` > plugin option `baseUrl` > Loomy runtime config >
the default above.

`/models` needs only `token`. `/chat/completions` sends all of:

- `token: <session>`
- `Authorization: Bearer <session>`
- `traceparent` (W3C format; without it the chat endpoint holds the request
  until the client times out)
- `loomy-version` (read from Loomy's `update-trace.log`, fallback `0.9.39`)
- `ChatId` / `MsgId` / `TurnId` / `InvokeOrigin: user`

The session is re-read when its file changes. `traceparent` and message ids are
generated per request.

## Models

`type: chat` models whose output modalities include text are exposed as
`loomy/<id>`. The three image models in the current list
(`Hy-Image-3.5-preview`, `doubao-seedream-5-lite`, `qwen-image-3.0-pro`) are
left out. The `(x2.0)` in a model name is its points multiplier.

The current chat models are `spark-x2.6`, `spark-x`, `DeepSeek-V4.1-Flash`,
`MiniMax-M3`, `Kimi-k2.6`, `qwen-3.8-max`, `GLM-5.3-Flash`, `qwen3.8-flash`,
`mimo-v2.5` and `auto`.

`spark-x2.6` first emits `reasoning_content`; a small `max_tokens` can leave the
final content empty (64 was empty, 256 and 1024 returned `pong` in testing).
Give agents enough output budget, or send `reasoning_effort: "none"`.

## Points

`GET <base>/points/balance` (only `token`) returns `balance`, `dailyBalance`
and `availableBalance`. magpie's Usage card shows the available total and two
source rows (base and daily). `100002` marks the sign-in as expired. The API
does not expose when the daily part resets; per-request consumption is the
`points_consumed` field in the chat response.

## Tests

```sh
bun test packages/loomy
```

14 tests: session path/hash, empty session, base URL precedence, version
reading, chat headers, model mapping (image models filtered), balances and
`100002`, loader success/expired, and `provider.models`. The tests use a
network guard and do not contact Loomy.

## Scope and risks

- Non-public interface: Loomy can change fields or shut it down at any time;
  this package only claims the behaviour of 0.9.39.
- It may violate Loomy's terms and lead to account restrictions or a ban; do
  not use it on an important account.
- One signed-in account, no account pooling. Sign in to Loomy again when the
  session expires.
- Chat models and the points card are implemented; image generation models are
  not exposed.
- Windows is tested. The macOS/Linux session paths come from Loomy's own
  avatar-gen skill and are not tested.
- Never commit the session or paste it into a public issue.

## 中文

Loomy（讯飞桌面 Agent）的 magpie 供应商插件，provider id 为 `loomy`，提供聊天
模型与积分余额。登录读取 Loomy 本机的 `auth-session.json`，不复制账号；对话
请求带 `token`、`Authorization`、`traceparent`、`loomy-version` 等头。图片模型
会被过滤。

这是非官方接入，调用 Loomy 客户端的非公开接口，可能违反其用户协议并导致账号
受限或封禁；重要账号不要使用。Windows 已实测，macOS/Linux 路径未实测。

## License

MIT
