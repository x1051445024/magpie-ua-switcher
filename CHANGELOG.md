# Changelog

## 1.7.0 — 2026-11-02

**安全加固、并发韧性、Schema 属性合并与协议拟真全面优化 / Security, Concurrency & Protocol Hardening**

- **接口安全与 CSRF 防御（F-01, F-02, F-05）**：
  - 本地端口 `127.0.0.1:3426` 引入 `Host`、`Origin` 与 `Sec-Fetch-Site` 严格同源校验，杜绝恶意网页在后台执行 Drive-by CSRF 与 DNS Rebinding 篡改。
  - `POST /config` 严格校验 `Content-Type: application/json`，拒绝无需预检的 Simple Request。
  - 修复 `HEADER_KEY_RE` 正则字符组未转义 `-` 导致包含冒号 `:` 的漏洞，新增保留头黑名单（`host`, `authorization`, `x-api-key` 等）与控制字符检测；`VERSION_RE` 补充尾部 `$` 锚点。
  - Web UI 前端模板增加 `esc()` HTML 实体转义，防御 DOM 型 XSS。
  - 页面响应头补充 `Content-Security-Policy` 与 `X-Frame-Options: DENY`。
- **工具 Schema 兼容层健壮性（F-03, F-10, F-11）**：
  - 修复顶层存在 `properties` 时直接跳过 `oneOf`/`allOf`/`anyOf` 属性合并的高危 Bug，确保公共基类属性与分支专有属性均被完整保留。
  - 分支同名字段类型/枚举冲突时，自动合并为属性级 `{ anyOf: [...] }`（Anthropic 官方原生支持内部 anyOf），避免 First-Win 策略导致模型无法使用后续分支定义的参数。
  - 正确合并 `allOf` 分支的 `required` 并集，修剪悬空必填字段。
  - `schema.middleware.mjs` 全局包裹 `try/catch` 保证在 `moejs` 沙箱中绝对 Fail-Safe。
- **并发安全与文件原子操作（F-04, F-09, F-15, F-16）**：
  - 引入 `safeWriteJsonSync`（带进程 PID 隔离的临时文件 + Windows `renameSync` 的 `EPERM`/`EBUSY` 退避重试与拷贝回退机制）。
  - 同时监听 `providers.json` 外部修改，解决与 Magpie 主进程双写冲突导致伪装 Header 丢失的问题，实现自动检测并自愈。
  - `hooks.mjs` 诊断文件 `diagnose()` 采用原子写入并限制 `0o600` 权限。
  - 对 `zcode-device-mid` 增加 10 秒内存缓存，避免高并发热路径重复触发同步 I/O。
  - 全局 `noted` 与 `seen` 增加容量上限截断，杜绝长周期运行内存泄漏。
- **协议拟真度与会话生命周期（F-06, F-07, F-08, F-13, F-14）**：
  - `hooks.mjs` 区分持久化设备身份 `base_id`（`user_<64hex>_account_<uuid>`）与按生命周期轮转的 `session_id`（每 4 小时或重启后轮转），兼容平滑迁移旧版 `user_id`。
  - `claude-code` 动态自适应当前平台的 `X-Stainless-OS` 与 `X-Stainless-Arch`，Runtime 版本调整为主流 LTS `v22.14.0`。
  - 修复 `pi` 档案 Anthropic 形态硬编码版本 Bug，动态引用 `V.pi` 并补齐 `anthropic-version: "2023-06-01"`。
  - `zcode` 平台与系统标识改为动态探测；`codex` 终端名称读取真实 `TERM_PROGRAM` / `WT_SESSION` 环境变量。
  - `readAsarPackageVersion` 增加 entry 大小（上限 1MB）与偏移范围防御校验。
- **控制台与前端体验全新重构（Web UI Modernization）**：
  - 架构解耦：将单文件内联模板拆分为同目录独立静态文件 `ui.html`，由 `index.mjs` 基于 `fs.statSync` mtime 缓存机制零构建读取，前后端职责解耦，彻底消除模板字面量双重转义隐患。
  - 视觉革新：采用 Linear / Vercel 极客暗黑风设计规范（Zinc 950、微高光边框、顶部径向氛围光），支持 Dark/Light 主题切换与 11px-17px 字号无级缩放。
  - Bento Grid 身份矩阵：每张卡片展示协议归属（Anthropic CLI / OpenAI Rust / Dual Adaptive 等）、防降智特征、实时真实 User-Agent 字符串预览及一键复制。
  - 统一 Provider 路由矩阵：将「排除」与「覆盖」合一，支持单行 Provider 三态切换（跟随全局 / 保持原生 / 锁定档案）与实时搜索过滤。
  - 客户端版本控制台：完整展示手动锁定、本机 ASAR 探测、npm 同步与官方内置四种来源状态，支持一键从 npm 镜像热更新。
  - 自定义预设工坊：支持可视化添加分协议 Header（`any`/`anthropic`/`openai`），内置保留头与合法性前端即时校验。
  - 实时审计流抽屉：底部常驻终端风格折叠抽屉，实时记录网关 `chat.headers` 注入流水与自愈事件，支持 3 秒自动轮询与过滤。
- **5 项残余细节修正**：
  - CSP 响应头放行 `img-src 'self' data:`，支持内联 SVG 图标渲染。
  - `providersApply` 统一维护 `lastAppliedMtime` 与 `lastProvidersMtime`，消除 Web 请求触发的冗余重刷。
  - `POST /config` 补齐 `injectMetadata` 与 `autoVersions` 布尔配置写入。
  - `GET /state` 扩展 `resolvedProfiles` 预览与 `events` 环形审计日志（保留所有旧字段）。
- **环境自适应与 Docker / XDG / 便携版路径决议（合入 PR #1 强化版，致谢社区贡献者 @bearchild233）**：
  - 新增 `paths.mjs`：自适应决议 magpie 目录（优先使用插件 `input.directory` 即 `appdir.Config()`，支持 Windows 便携版 `data/` 目录；其次判断 `$XDG_CONFIG_HOME/magpie`，全面支持官方 Docker 镜像 `HOME=/config/home` 与 `XDG_CONFIG_HOME=/config`；最后回退 `~/.config/magpie`）。环境变量 `UA_SWITCHER_CONFIG` 与 `UA_SWITCHER_PROVIDERS` 依然拥有最高优先级。
  - 自动旧配置无损迁移（`adoptLegacy`）：将旧目录的 `ua-switcher.json`、`-versions.json`、`-userid.json` 自动导入新目录；增加严格安全白名单与 `fs.lstatSync` 软链接越权阻断，且目标已有时永不覆盖。
  - 跨平台文件权限与符号链接终极融合：`safeWriteJsonSync` 解引用符号链接目标，自动继承原始文件权限（`st.mode & 0o777`）并在非 Windows 环境下通过 `fs.chmodSync` 精确保持 `0o600`，同时具备多进程 PID 隔离与 Windows 文件锁 3 轮重试。
  - 修复多实例与重启时 3426 端口 `"external"` 看门狗永久饿死缺陷：新增启动期阶梯退避重试（300ms, 800ms, 2000ms, 5000ms），并在网关钩子看门狗中同时覆盖 `server === null || server === "external"`。
  - `/state` 暴露 `providersPath` 与 `providersError` 状态字段；Web UI 与控制台新增路径探测与读取失败告警横幅。
- **官方矢量品牌图标全量集成**：
  - 左上角主品牌图标替换为 yetone/magpie 官方喜鹊剪影矢量 SVG（渐变容器内嵌）。
  - 卡片全面换装官方品牌原生矢量图标（Claude Code 像素机器人、OpenAI Codex 渐变结、Inflection Pi 几何标、智谱 GLM 棱镜、OpenCode 终端符号、Google Antigravity 四色闪耀光芒及 Off 电源矢量），零外部网络请求，100% 符合 CSP 安全规范。
- **测试覆盖**：
  - `selftest.mjs` 测试套件扩展至 **150 项断言**（100% 通过），全量覆盖路径决议、Docker/XDG 优先级、便携版标记探测、旧目录安全迁移、符号链接与 0600 权限保持、CSRF 拦截、外部文件自愈、Schema 冲突合并及品牌图标支持。

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
