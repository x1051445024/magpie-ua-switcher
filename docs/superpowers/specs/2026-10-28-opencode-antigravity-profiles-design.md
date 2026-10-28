# opencode / antigravity 内置档案 — 设计

日期：2026-10-28
状态：已批准，待实现
目标版本：1.4.0

## 背景

插件现有内置档案 codex / claude-code / pi / zcode，覆盖 2026 年上半年的主流客户端。
2026 年下半年起，opencode（sst/opencode）与 Google Antigravity（内部代号 Jetski / Antigravity Hub）
成为中转站按客户端分流时的常见识别目标：两者都有专门的客户端身份头，但插件目前无法伪装。

用户需求（原话）：「增加新的主流请求头，比如 opencode，antigravity」。
用途：**两者都要** —— 既作为通用防降级伪装，也能对上按客户端分流的渠道；
网页上支持按 provider 覆盖。

## 事实依据（本机与开源交叉验证）

### opencode（npm `opencode-ai` 1.19.4，Windows 二进制实测）

- **不设自定义 User-Agent**。请求由 Bun 运行时发出，UA 即 Bun 默认值：`Bun/1.4.4`。
- 身份头（二进制内 `provider.update(... request.headers ...)`）：
  - `HTTP-Referer: https://opencode.ai/`
  - `X-Title: opencode`
  - `X-Source: opencode`
  - `X-BILLING-INVOKE-ORIGIN: OpenCode`（仅 nvidia 等个别 provider）
- 会话头（对所有 provider 生效，`http.headers` 传入）：
  `x-opencode-session-id`、`X-Session-Id`、`x-session-affinity` — 同一会话同值，
  格式 `ses_<64 hex>`（二进制内校验正则 `/^ses_[0-9a-f]{64}$/`）。
- 偏差说明：`X-Title` / `HTTP-Referer` / `X-Source` 在真实客户端中只对官方 provider
  （OpenRouter、llmgateway、nvidia、vercel、mistral、zenmux、kilo 等）注入；连自定义
  baseURL 的中转站时只带会话头。本设计为「让中转站识别」全量带上，属有意偏差。

### antigravity（本机 Hub 2.26.0 实测 + 开源抓包规范）

- 发请求的进程是 `resources/bin/language_server.exe`（Go，v2.26.0），直连
  `daily-cloudcode-pa.googleapis.com`。
- 运行命令行实证：
  `--override_ide_name antigravity --override_ide_version 2.26.0 --override_user_agent_name antigravity --subclient_type hub`
- UA 格式（`NoeFabris/opencode-antigravity-auth` 的 `docs/ANTIGRAVITY_API_SPEC.md`，
  基于真实抓包）：
  `antigravity/hub/<version> (aidev_client; os_type=<os>; arch=<arch>; cl=<changelist>)`
  例：`antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=arm64; cl=1000335682)`
- Hub 的 content/project/quota 请求**只发 User-Agent**，不带 `X-Goog-Api-Client` /
  `Client-Metadata`（规范原文）。
- `os_type` / `arch` 取自运行时（Go 惯例：windows/amd64、darwin/arm64、linux/amd64）。
- 已知构建号（CL）：`{"2.23.0":"998057262","2.23.1":"998881661","2.24.0":"1000335682"}`；
  2.26.0 无公开 CL —— 未知时**省略 `cl=` 段，不冒充别的构建**。
- 本机版本探测：`resources/app.asar` 内根 `package.json` 的 `version` = `2.26.0`，
  与进程 `--override_ide_version` 一致（已用 Python 验证解析路径可用）。

## 目标

1. 新增两个内置档案 `opencode`、`antigravity`，零配置可用。
2. 复用现有全部机制：协议自适应、provider 覆盖、排除列表、网页切换、applied 记账、版本钉死。
3. 版本号可维护：内置默认 + 本机探测（antigravity）+ 手动钉。

## 非目标

- 不改 `chat.headers` 钩子逻辑、`providersApply`、网页渲染代码。
- 不做模板引擎（否决方案 B，YAGNI）。
- 不自动探测 opencode 的 Bun 版本（npm 不暴露；只有二进制里才有）。
- 不改动 TLS 指纹（插件层无法改，Go 进程发起）。

## 设计

### 档案定义（`builtinProfiles()` 内新增）

```js
opencode: {
  label: "opencode",
  ua: `Bun/${V.bun}`,
  headers: {
    any: {
      "HTTP-Referer": "https://opencode.ai/",
      "X-Title": "opencode",
      "X-Source": "opencode",
      "x-opencode-session-id": OPENCODE_SESSION_ID,
      "X-Session-Id": OPENCODE_SESSION_ID,
      "x-session-affinity": OPENCODE_SESSION_ID,
    },
  },
},
antigravity: {
  label: "Antigravity Hub",
  ua: `antigravity/hub/${V.antigravity} (aidev_client; os_type=${ANTI_OS}; arch=${ANTI_ARCH}${clPart})`,
  headers: {},
},
```

- `OPENCODE_SESSION_ID`：模块级常量，`"ses_" + randomBytes(32).toString("hex")`，
  插件进程生命周期内固定（等价于一条长会话）。不可放进 `builtinProfiles()` 内部逐次生成，
  否则每次请求 ID 都变（`effectiveProfiles` 每请求重建）。
- `ANTI_OS` / `ANTI_ARCH`：按 `os.platform()` / `os.arch()` 映射：
  win32→windows、darwin→darwin、linux→linux；x64→amd64、arm64→arm64。
- `clPart`：查 `ANTIGRAVITY_CL` 表，命中则 `` `; cl=${n}` ``，否则空串。
- 两个档案都是单形态（`ua` + `headers`），不区分 anthropic/openai —— 与真实客户端一致。

### 版本

- `DEFAULT_VERSIONS` 新增：`bun: "1.4.4"`、`antigravity: "2.26.0"`。
- `NPM_PACKAGES` 不新增（opencode 的 Bun 版本不在 npm；antigravity 无 npm 包）。
- antigravity 本机探测 `detectAntigravityVersion()`：
  1. 候选路径：`%LOCALAPPDATA%\Programs\Antigravity\resources\app.asar`、
     `/Applications/Antigravity.app/Contents/Resources/app.asar`、
     `/usr/share/antigravity/resources/app.asar`、`/opt/antigravity/resources/app.asar`。
  2. 解析 asar 头（pickle：offset 4 = headerSize，offset 12 = jsonLen，JSON 从 16 起，
     数据区起点 = 8 + headerSize，4 字节对齐），取根 `files["package.json"]` 的
     `offset`/`size`，读数据区并 `JSON.parse`，取 `version`。
  3. 校验 `VERSION_RE`，失败返回 null（静默回退内置值）。
  4. 结果按 asar mtime 缓存，避免每请求重读。
- 优先级（`versionsOf`）：手动钉 > 本机探测 > 内置。
  `versionState()` 的 `source` 枚举增加 `"detected"`（本机探测值），网页显示为「本机」。
- 手动钉：`cleanPins` 的白名单来自 `DEFAULT_VERSIONS` 键，新键自动可钉。

### 错误处理

- asar 不存在/解析失败/版本非法：返回 null，不抛错、不刷日志（`note` 一次）。
- `randomBytes` 不可用：回退到 `Math.random()` 拼接（仍满足 `ses_` 格式），并 note 一次。
- 配置里出现未知版本键：`cleanPins` 已抛错，行为不变。

### 网页 / API

- 无需改 UI：档案网格与版本行由 `state()` 动态生成，新档案/版本键自动出现。
- `/set/opencode`、`/set/antigravity` 自动可用（`effectiveProfiles` 校验）。

## 测试（selftest.mjs 新增断言）

1. 两档案存在且 label 正确。
2. opencode UA === `Bun/<pin>`；钉版本后 UA 随之改变。
3. opencode 三会话头同值且匹配 `/^ses_[0-9a-f]{64}$/`；两次 `effectiveProfiles` 调用 ID 相同。
4. opencode 头包含 `HTTP-Referer`/`X-Title`/`X-Source` 期望值。
5. antigravity UA 匹配
   `/^antigravity\/hub\/\d+\.\d+\.\d+ \(aidev_client; os_type=\w+; arch=\w+(; cl=\d+)?\)$/`。
6. 钉 `antigravity: "2.24.0"` 时 UA 含 `cl=1000335682`；2.26.0 时无 `cl=`。
7. 未知版本键仍被拒绝（回归）。
8. 排除列表 / provider 覆盖对新档案生效（沿用现有断言的模式）。

## 文档

- `README.zh-CN.md` / `README.md`：内置档案表加两行；新增「已知偏差」说明
  （opencode 全量身份头 vs 真实自定义 provider 行为；antigravity 的 CL 省略规则）。
- `CHANGELOG.md`：1.4.0 条目。
- `package.json`：version → 1.4.0。

## 风险

- 中转站若校验 antigravity 的 `cl=` 构建号，2.26.0 省略 CL 可能被识破为伪造；
  缓解：手动钉 + 扩展 CL 表，或以后加「伪造 CL」开关（本设计不做）。
- opencode 的 `Bun/1.4.4` 是通用运行时 UA，单靠 UA 无区分度；识别依赖会话头，
  若上游只解析 UA，则 opencode 档案效果有限（文档注明）。
