# Changelog

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
