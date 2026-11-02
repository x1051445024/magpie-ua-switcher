# Changelog

## 1.5.0 — 2026-11-02

**补齐 Claude Code 请求特征：metadata.user_id / Completing the Claude Code identity**

- 新增 gateway 钩子 `hooks.mjs`（经 `package.json` 的 `magpie.hooks` 由 magpie 自动加载）：在 `claude-code`（及 pi 的 anthropic 形态）档案生效、且请求走 anthropic 协议时，为请求体补上 `metadata.user_id`（格式 `user_<64hex>_account_<uuid>_session_<uuid>`，与真实 Claude Code 一致）。
  New gateway hook `hooks.mjs` (discovered via `package.json`'s `magpie.hooks`): while the `claude-code` profile (or pi's anthropic form) is in effect and the wire is anthropic, it fills the request body's `metadata.user_id` with the real Claude Code shape.
- 严格校验 Claude Code 身份的中转站（要求原始 UA + `metadata.user_id`）此前会拒绝或断流（上游记 499）；补上该字段后校验通过。
  Relays that demand the complete Claude Code identity (original UA + `metadata.user_id`) previously refused or cut the stream (upstream saw 499); with the field present they pass.
- user_id 首次生成后持久化到 `ua-switcher-userid.json`，跨请求、跨重启稳定；客户端自带 metadata.user_id 时原样保留。
  The id is generated once and persisted to `ua-switcher-userid.json`, stable across requests and restarts; a client-sent `user_id` is left untouched.
- 新增配置 `injectMetadata`（默认 true），网页「Provider 设置」新增开关；排除的 provider 不会被注入；codex / off 等非 Claude Code 档案不触碰请求体。
  New `injectMetadata` config (default true) with a switch in the web UI's Provider settings; excluded providers are skipped; codex/off and other profiles never touch the body.
- 恢复 `zcode` 到默认排除列表（此前为空，Z.ai 线路被误改写）。
  `zcode` is excluded again by default (it had been cleared, so Z.ai's line was being rewritten).
- selftest 新增 20 项 gateway 钩子断言。
  Selftest gains 20 gateway-hook assertions.

## 1.4.0 — 2026-10-28

**opencode 与 Antigravity 档案 / opencode and Antigravity profiles**

- 新增内置档案 `opencode`：UA 为 `Bun/<版本>`（真实客户端不设自定义 UA），伴随 opencode 身份头与会话三件套（`ses_<64hex>`，进程内固定）。
  New built-in `opencode`: `Bun/<version>` UA (the real client sets none) plus opencode identity headers and the session trio.
- 新增内置档案 `antigravity`：`antigravity/hub/<版本> (aidev_client; os_type=…; arch=…[; cl=…])`，平台按本机生成，已知构建号才带 CL。
  New built-in `antigravity`: Hub-format UA with runtime platform; `cl=` only for known builds.
- antigravity 版本优先读本机安装（app.asar 内 package.json），读不到回退内置值；两个新版本键 `bun`/`antigravity` 均可用 `versions` 手动钉死。版本来源新增「本机」标签。
  Antigravity version is probed from the local install (app.asar), falling back to the built-in; both new keys are pinnable, and `/versions` gains a `detected` source.
- selftest 断言 69 → 81 项（opencode/antigravity 档案、会话头、CL 规则、asar 读取器）。
  Selftest assertions 69 → 81.

## 1.2.0 — 2026-10-25

**版本自动更新与手动钉版本 / Auto-updating and pinnable client versions**

- 版本号三层解析：内置默认 < npm 自动抓取 < 配置 `versions` 手动钉死（优先级最高）。
  Versions resolve in three layers: built-in defaults < fetched from npm < a hand pin in `versions`.
- `codex`（`@openai/codex`）与 `claude-code`（`@anthropic-ai/claude-code`）在插件加载时后台查 npm 最新版（npmjs.org 优先、npmmirror.com 兜底，可用 `registry` 追加首选源）；版本变化即写入缓存并立即重写 providers.json 里的 UA。默认 24 小时内不重复查。
  `codex` and `claude-code` fetch their npm latest in the background on load (npmjs.org first, npmmirror.com fallback, extra `registry` supported); a change rewrites the UAs in providers.json right away. Re-checked at most every `updateEveryHours`.
- `aiSdk` / `pi` / `zcode` 不自动更新：aiSdk 是 ZCode 内部捆绑的依赖，npm 最新值会拼出真实客户端从未发送过的 UA；pi 与 zcode 没有公开 npm 包。
  `aiSdk` / `pi` / `zcode` are never auto-fetched: aiSdk is bundled inside the closed ZCode client (npm's latest would assemble a UA the real client never sent), and pi/zcode ship no package.
- 新增配置字段：`autoVersions`（默认 true）、`updateEveryHours`（默认 24）、`registry`（可选）、`versions`（手动钉版本）。
  New config fields: `autoVersions` (default true), `updateEveryHours` (default 24), `registry` (optional), `versions` (hand pins).
- 新增端点：`GET /versions`（各版本当前值与来源 builtin/fetched/pinned）、`POST /versions/refresh`（强制刷新）；网页开关新增「客户端版本」一行与「检查更新」按钮。
  New endpoints `GET /versions` and `POST /versions/refresh`; the web switcher gains a versions row and a check-for-updates button.
- 内置版本刷新：codex 0.153.4 → 0.164.0，claude-code 2.1.280 → 2.1.310。
  Built-in bumps: codex 0.153.4 → 0.164.0, claude-code 2.1.280 → 2.1.310.
- selftest 断言 43 → 54 项（新增：钉版本优先级、/versions 端点、回退行为）。
  Selftest assertions 43 → 54 (pin precedence, /versions endpoint, fallback behavior).

## 1.1.0

- 双机制改写：providers.json 原生路径 + `chat.headers` 插件宿主路径；协议自适应（anthropic / openai responses）；自检回显模式；网页开关。

## 1.0.0

- 首版：codex / claude-code / pi / zcode / 自定义档案，curl 与网页切换，applied 记账。
