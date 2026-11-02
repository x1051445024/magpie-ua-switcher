# Changelog

## 1.6.1 — 2026-11-02

**读写 magpie 实际使用的目录 / Using magpie's own folder**

- 插件此前固定读 `~/.config/magpie`，而 magpie 按 portable → `$XDG_CONFIG_HOME/magpie` → `~/.config/magpie` 的顺序决定目录。magpie 官方 Docker 镜像设置了 `XDG_CONFIG_HOME=/config`、`HOME=/config/home`，providers.json 在 `/config/magpie`，插件却去 `/config/home/.config/magpie` 找：网页只列出 zcode，原生 provider 也从未被改写。
  The plugin always read `~/.config/magpie`, while magpie picks portable → `$XDG_CONFIG_HOME/magpie` → `~/.config/magpie`. In magpie's Docker image providers.json is `/config/magpie`, so the page listed only zcode and native providers were never rewritten.
- 新增 `paths.mjs`：优先用 magpie 传给插件的目录（插件入参 `directory`，即 magpie 的 `appdir.Config()`，含便携版），否则按 XDG 规则，再否则 `~/.config/magpie`；`UA_SWITCHER_CONFIG` / `UA_SWITCHER_PROVIDERS` 仍可覆盖。`index.mjs` 与网关钩子 `hooks.mjs` 共用它，两边读同一份配置。
  New `paths.mjs`: the folder magpie hands the plugin (its `appdir.Config()`, portable included), else the XDG rule, else `~/.config/magpie`; the env overrides still win. The page and the gateway hook share it.
- 旧目录里的 `ua-switcher.json`、`-versions.json`、`-userid.json` 会复制到新目录一次，已选档案和中转站见过的 user_id 不变。
  Those files left in the old folder are copied over once, keeping the chosen profile and the user_id relays have seen.
- `/state` 新增 `providersPath`、`providersError`（`providers` 仍是数组）；网页显示 providers.json 路径，读不到时给出警告；读失败不再静默。
  `/state` adds `providersPath` and `providersError` (`providers` stays an array); the page shows the path and warns when it can't be read.
- 改写 providers.json 时保留文件权限（magpie 为 0600）、写入符号链接的目标、失败时删除临时文件。
  Rewriting providers.json keeps its mode (magpie's 0600), writes a symlink's target, and removes the temp file on failure.
- selftest 新增路径解析、旧文件迁移、`/state` 与写入相关断言。
  Selftest gains assertions for path resolution, migration, `/state` and the rewrite.

## 1.6.0 — 2026-11-02

**工具 schema 兼容层 / Tool-schema compatibility**

- 新增 gateway middleware `schema.middleware.mjs`（`package.json` 的 `magpie.middleware`）：对 Anthropic 协议的请求，清洗每个工具 `input_schema` 的**顶层**——删除顶层 `oneOf`/`allOf`/`anyOf`、补齐 `type: "object"` 与 `properties`、剔除 `required` 里不存在的属性名。
  New gateway middleware: cleans the **top level** of each tool's `input_schema` on anthropic requests — drops top-level `oneOf`/`allOf`/`anyOf`, fills `type: "object"` and `properties`, and removes `required` names with no property.
- 背景：有些 MCP 工具用 zod 的 `.refine()` 表达互斥参数，转成 JSON Schema 后落在顶层，真 Anthropic 端点会回 `input_schema does not support oneOf, allOf, or anyOf at the top level`（GLM 等兼容层不校验，所以此前只在 Claude 线路暴露）。middleware 只在 magpie 层处理，对任何客户端生效，也不受第三方插件升级影响。
  MCP tools that express mutual exclusion with zod's `.refine()` land that union at the schema's top level, which a real Anthropic endpoint rejects. Fixing it in magpie covers every client and survives plugin upgrades.
- 只动顶层：嵌套的 `oneOf` 是合法的，保持原样；未改动的工具与无 tools 的请求原样转发（返回 undefined，字节不变）。
  Top level only — nested unions are legal and untouched; clean requests pass through byte-identical.
- 逃生阀：`magpie plugin options <spec> '{"disable":true}'` 可关闭（moejs 沙箱读不到配置文件，所以没有网页开关）。
  Escape hatch: `magpie plugin options <spec> '{"disable":true}'` (the moejs sandbox cannot read the config file, so there is no web toggle).
- selftest 断言 111 项；同时把两项依赖本机 Antigravity 安装版本号的断言改为形状断言。
  Selftest now 111 assertions; two environment-coupled antigravity assertions became shape checks.

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
