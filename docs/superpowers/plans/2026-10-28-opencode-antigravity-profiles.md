# opencode / antigravity 内置档案 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 ua-switcher 中新增 `opencode` 与 `antigravity` 两个内置身份档案，并使 antigravity 版本可从本机 Antigravity 安装自动探测。

**Architecture:** 全部改动集中在 `index.mjs` 的档案表与版本解析层；复用既有 `builtinProfiles()` / `versionsOf()` / `versionState()` 机制，网页与钩子逻辑不动（`source` 标签加一个分支）。测试追加到 `selftest.mjs` 末尾，用 magpie 自带 Bun 运行。

**Tech Stack:** Node ESM（Bun 运行时）、无第三方依赖、node:fs / node:os / node:path / node:crypto。

**Spec:** `docs/superpowers/specs/2026-10-28-opencode-antigravity-profiles-design.md`

## Global Constraints

- 档案 id 只能是 `[A-Za-z0-9._-]{1,40}`（既有 `ID_RE`）。
- 版本值必须通过 `VERSION_RE = /^\d+\.\d+\.\d+/`。
- `chat.headers` 只能新增/覆盖头，不能删除。
- 不改 `chatHeaders()`、`providersApply()`、`/config` 校验逻辑。
- 测试命令：`"C:\Users\Lenovo\.cache\magpie\bun\1.4.4\magpie-bun.exe" selftest.mjs`（工作目录为仓库根）。

---

### Task 1: `opencode` 档案

**Files:**
- Modify: `index.mjs`（`DEFAULT_VERSIONS` 约 28-34 行；`builtinProfiles()` 约 56-134 行；顶部 import 约 14-16 行）
- Test: `selftest.mjs`（末尾，第 188 行 `config deletes custom profiles` 断言之后、总结之前）

**Interfaces:**
- Consumes: 既有 `VERSION_RE`、`builtinProfiles(V)`
- Produces: 内置档案 id `opencode`；版本键 `bun`（`DEFAULT_VERSIONS.bun`）；模块级常量 `OPENCODE_SESSION_ID`（形如 `ses_<64 hex>`）

- [ ] **Step 1: 写失败测试**（追加到 `selftest.mjs` 第 188 行之后）

```js
// opencode profile: Bun runtime UA + opencode identity/session headers
await fetch(base + "/set/opencode", { method: "POST" })
h = await apply("any", "@ai-sdk/anthropic")
eq("opencode ua", h["User-Agent"], "Bun/1.4.4")
eq("opencode referer", h["HTTP-Referer"], "https://opencode.ai/")
eq("opencode x-title", h["X-Title"], "opencode")
eq("opencode x-source", h["X-Source"], "opencode")
const sid = h["x-opencode-session-id"]
eq("opencode session id shape", /^ses_[0-9a-f]{64}$/.test(sid ?? ""), true)
eq("opencode session id shared", [h["X-Session-Id"], h["x-session-affinity"]], [sid, sid])
h = await apply("any", "@ai-sdk/openai")
eq("opencode session id stable across requests", h["x-opencode-session-id"], sid)
rc = await postCfg({ versions: { bun: "9.9.9" } })
eq("opencode bun pin accepted", rc.j.ok, true)
h = await apply("any", "@ai-sdk/anthropic")
eq("opencode pinned bun ua", h["User-Agent"], "Bun/9.9.9")
rc = await postCfg({ versions: { bun: "" } })
eq("opencode bun pin cleared", rc.j.ok, true)
```

- [ ] **Step 2: 运行确认失败**

Run: `"C:\Users\Lenovo\.cache\magpie\bun\1.4.4\magpie-bun.exe" selftest.mjs`
Expected: FAIL（`unknown profile` / 400，首批 opencode 断言失败）

- [ ] **Step 3: 实现**

`index.mjs` 顶部 import 区（`import path from "node:path"` 之后）加：

```js
import { randomBytes } from "node:crypto"
```

`DEFAULT_VERSIONS` 加一个键（放在 `aiSdk` 之后）：

```js
  bun: "1.4.4", // the Bun runtime version opencode's binary reports as its UA
```

`DEFAULT_VERSIONS` 之后新增（模块级，进程生命周期内固定）：

```js
// opencode sends no User-Agent of its own (the Bun runtime's default rides
// along); its identity is the session header trio below. One id per plugin
// process ≈ one long-lived session — generating per request would look wrong.
function newOpencodeSessionId() {
  try {
    return `ses_${randomBytes(32).toString("hex")}`
  } catch {
    let s = ""
    while (s.length < 64) s += Math.floor(Math.random() * 16).toString(16)
    return `ses_${s}`
  }
}
const OPENCODE_SESSION_ID = newOpencodeSessionId()
```

`builtinProfiles()` 的 `profiles` 对象里（`zcode` 条目之后）加：

```js
    opencode: {
      label: "opencode",
      ua: `Bun/${V.bun}`,
      headers: {
        // The real client only injects X-Title/HTTP-Referer/X-Source on a
        // handful of official providers; on custom baseURLs just the session
        // headers ride along. We send all of them so relays can recognize us.
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
```

- [ ] **Step 4: 运行确认通过**

Run: `"C:\Users\Lenovo\.cache\magpie\bun\1.4.4\magpie-bun.exe" selftest.mjs`
Expected: 全部 `ok`，末行 `all tests passed`

- [ ] **Step 5: 提交**

```bash
git add index.mjs selftest.mjs
git commit -m "add opencode profile: Bun runtime UA + opencode identity/session headers"
```

---

### Task 2: `antigravity` 档案与 CL 表

**Files:**
- Modify: `index.mjs`（`DEFAULT_VERSIONS`；`builtinProfiles()` 的 `opencode` 条目之后）
- Test: `selftest.mjs`（Task 1 的断言之后）

**Interfaces:**
- Consumes: `VERSION_RE`、`DEFAULT_VERSIONS.antigravity`
- Produces: 内置档案 id `antigravity`；常量 `ANTIGRAVITY_CL`（`{版本: 构建号}`）与 `ANTIGRAVITY_PLATFORM`（`` `os_type=…; arch=…` ``）

- [ ] **Step 1: 写失败测试**（追加）

```js
// antigravity profile: Hub UA only, cl= only for known builds
await fetch(base + "/set/antigravity", { method: "POST" })
h = await apply("any", "@ai-sdk/anthropic")
eq("antigravity ua shape", /^antigravity\/hub\/2\.26\.0 \(aidev_client; os_type=\w+; arch=\w+\)$/.test(h["User-Agent"] ?? ""), true)
eq("antigravity sends no extra headers", Object.keys(h), ["User-Agent"])
rc = await postCfg({ versions: { antigravity: "2.24.0" } })
eq("antigravity pin accepted", rc.j.ok, true)
h = await apply("any", "@ai-sdk/openai")
eq("antigravity known cl", String(h["User-Agent"]).includes("; cl=1000335682)"), true)
rc = await postCfg({ versions: { antigravity: "" } })
eq("antigravity pin cleared", rc.j.ok, true)
```

- [ ] **Step 2: 运行确认失败**

Run: `"C:\Users\Lenovo\.cache\magpie\bun\1.4.4\magpie-bun.exe" selftest.mjs`
Expected: FAIL（antigravity 档案不存在，`/set/antigravity` 返回 400）

- [ ] **Step 3: 实现**

`DEFAULT_VERSIONS` 加：

```js
  antigravity: "2.26.0", // Antigravity Hub release; also probed from the local install
```

`OPENCODE_SESSION_ID` 附近新增：

```js
// Antigravity Hub build changelists, as published with each release. A version
// missing here omits cl= entirely — claiming another build's CL would be a lie
// the real manifests never tell.
const ANTIGRAVITY_CL = {
  "2.23.0": "998057262",
  "2.23.1": "998881661",
  "2.24.0": "1000335682",
}
// The Hub names its runtime platform the Go way (runtime.GOOS/GOARCH).
const ANTI_OS = { win32: "windows", darwin: "darwin", linux: "linux" }[os.platform()] ?? os.platform()
const ANTI_ARCH = { x64: "amd64", arm64: "arm64", ia32: "386" }[os.arch()] ?? os.arch()
const ANTIGRAVITY_PLATFORM = `os_type=${ANTI_OS}; arch=${ANTI_ARCH}`
```

`builtinProfiles()` 里 `opencode` 条目之后加：

```js
    antigravity: {
      label: "Antigravity Hub",
      ua: (() => {
        const cl = ANTIGRAVITY_CL[V.antigravity]
        return `antigravity/hub/${V.antigravity} (aidev_client; ${ANTIGRAVITY_PLATFORM}${cl ? `; cl=${cl}` : ""})`
      })(),
      // The Hub sends no companion headers — its User-Agent alone is the identity.
    },
```

- [ ] **Step 4: 运行确认通过**

Run: `"C:\Users\Lenovo\.cache\magpie\bun\1.4.4\magpie-bun.exe" selftest.mjs`
Expected: `all tests passed`

- [ ] **Step 5: 提交**

```bash
git add index.mjs selftest.mjs
git commit -m "add antigravity profile: Hub User-Agent with runtime platform and known CL"
```

---

### Task 3: 本机 Antigravity 版本探测

**Files:**
- Modify: `index.mjs`（版本层：`loadFetchedVersions` 之后、`versionsOf` 之前；`versionsOf`；`versionState`）
- Test: `selftest.mjs`（Task 2 的断言之后）

**Interfaces:**
- Consumes: `VERSION_RE`
- Produces: `readAsarPackageVersion(asarPath): string|null`、`detectAntigravityVersion(): string|null`；`versionsOf()` 新优先级 钉 > 本机探测 > npm > 内置；`versionState().values[k].source` 新增取值 `"detected"`

- [ ] **Step 1: 写失败测试**（追加；构造最小 asar 验证解析器）

```js
// asar package.json reader (used by antigravity version detection)
import { writeFileSync as _wf } from "node:fs" // already imported fs; this keeps the block self-contained
const asarPath = path.join(os.tmpdir(), `ua-switcher-selftest-${process.pid}.asar`)
{
  const pkg = Buffer.from(JSON.stringify({ name: "antigravity", version: "2.26.0" }))
  const header = Buffer.from(JSON.stringify({ files: { "package.json": { size: pkg.length, offset: "0" } } }))
  const headerSize = 4 + header.length + ((4 - ((4 + header.length) % 4)) % 4)
  const pre = Buffer.alloc(8)
  pre.writeUInt32LE(4, 0)
  pre.writeUInt32LE(headerSize, 4)
  const lenBuf = Buffer.from([header.length & 0xff, (header.length >> 8) & 0xff, (header.length >> 16) & 0xff, (header.length >> 24) & 0xff])
  const pad = Buffer.alloc(headerSize - 4 - header.length)
  _wf(asarPath, Buffer.concat([pre, lenBuf, header, pad, pkg]))
}
const { readAsarPackageVersion } = await import("./index.mjs")
eq("asar reader parses package.json", readAsarPackageVersion(asarPath), "2.26.0")
eq("asar reader rejects garbage", readAsarPackageVersion(path.join(os.tmpdir(), "nope-does-not-exist.asar")), null)
```

- [ ] **Step 2: 运行确认失败**

Run: `"C:\Users\Lenovo\.cache\magpie\bun\1.4.4\magpie-bun.exe" selftest.mjs`
Expected: FAIL（`readAsarPackageVersion` is not a function）

- [ ] **Step 3: 实现**

在 `loadFetchedVersions()` 之后新增：

```js
// ---- local Antigravity install ------------------------------------------------

// Antigravity's Hub release lives in the app.asar root package.json
// ("version", e.g. 2.26.0 — the same value the running language server gets as
// --override_ide_version). Reading it keeps the profile's UA in step with a
// client upgrade without any network call. Any failure means "unknown" and the
// built-in / pinned version wins.
function readAsarPackageVersion(asarPath) {
  let fd
  try {
    fd = fs.openSync(asarPath, "r")
    const hdr = Buffer.alloc(16)
    fs.readSync(fd, hdr, 0, 16, 0)
    const headerSize = hdr.readUInt32LE(4)
    let jsonLen = hdr.readUInt32LE(12)
    let jsonOff = 16
    const sane = (n) => n > 1 && n < 64 * 1024 * 1024
    if (!sane(jsonLen)) {
      // older asar layout: length sits at offset 8, JSON starts at 12
      jsonLen = hdr.readUInt32LE(8)
      jsonOff = 12
      if (!sane(jsonLen)) return null
    }
    const raw = Buffer.alloc(jsonLen)
    fs.readSync(fd, raw, 0, jsonLen, jsonOff)
    const header = JSON.parse(raw.toString("utf8"))
    const entry = header?.files?.["package.json"]
    if (!entry || typeof entry.offset !== "string" || !Number.isFinite(Number(entry.size))) return null
    let base = 8 + headerSize
    if (base % 4) base += 4 - (base % 4)
    const data = Buffer.alloc(Number(entry.size))
    fs.readSync(fd, data, 0, data.length, base + Number(entry.offset))
    const pkg = JSON.parse(data.toString("utf8"))
    if (typeof pkg?.version === "string" && VERSION_RE.test(pkg.version)) return pkg.version
    return null
  } catch {
    return null
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd) } catch {}
  }
}

const ANTIGRAVITY_ASARS = [
  path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Antigravity", "resources", "app.asar"),
  "/Applications/Antigravity.app/Contents/Resources/app.asar",
  "/usr/share/antigravity/resources/app.asar",
  "/opt/antigravity/resources/app.asar",
  path.join(os.homedir(), ".local", "share", "antigravity", "resources", "app.asar"),
]
let detectedCache = { path: null, mtime: -1, version: null }

function detectAntigravityVersion() {
  for (const p of ANTIGRAVITY_ASARS) {
    if (!p) continue
    try {
      const st = fs.statSync(p)
      if (detectedCache.path === p && detectedCache.mtime === st.mtimeMs) return detectedCache.version
      const v = readAsarPackageVersion(p)
      detectedCache = { path: p, mtime: st.mtimeMs, version: v }
      return v
    } catch {}
  }
  return null
}
```

`versionsOf()` 改为：

```js
// precedence: a hand pin in the config > the local Antigravity install (only for
// the antigravity key) > the last value fetched from npm > built-in
function versionsOf(cfg) {
  const out = { ...DEFAULT_VERSIONS }
  const fetched = loadFetchedVersions().versions
  const detected = { antigravity: detectAntigravityVersion() }
  for (const k of Object.keys(DEFAULT_VERSIONS)) {
    if (typeof cfg?.versions?.[k] === "string" && VERSION_RE.test(cfg.versions[k])) out[k] = cfg.versions[k]
    else if (typeof detected[k] === "string") out[k] = detected[k]
    else if (typeof fetched[k] === "string") out[k] = fetched[k]
  }
  return out
}
```

`versionState()` 的 `source` 行改为：

```js
      source: typeof pins[k] === "string" ? "pinned" : detected[k] ? "detected" : fetched.versions[k] ? "fetched" : "builtin",
```

并在 `versionState()` 顶部（`const pins = ...` 之后）加：

```js
  const detected = { antigravity: detectAntigravityVersion() }
```

- [ ] **Step 4: 运行确认通过**

Run: `"C:\Users\Lenovo\.cache\magpie\bun\1.4.4\magpie-bun.exe" selftest.mjs`
Expected: `all tests passed`（本机存在 Antigravity 2.26.0 → `detected` 路径生效，UA 仍为 2.26.0）

- [ ] **Step 5: 提交**

```bash
git add index.mjs selftest.mjs
git commit -m "detect antigravity version from the local install (app.asar package.json)"
```

---

### Task 4: 网页 source 标签 + 文档 + 版本号

**Files:**
- Modify: `index.mjs`（`page()` 内版本行模板，约 770 行）
- Modify: `README.zh-CN.md`（内置档案表约 58-64 行、已知局限约 113-119 行）
- Modify: `README.md`（对应英文段落）
- Modify: `CHANGELOG.md`（顶部新增 1.4.0）
- Modify: `package.json`（version → 1.4.0）

**Interfaces:**
- Consumes: `versionState().values[k].source` 的新取值 `"detected"`
- Produces: 无（展示与文档）

- [ ] **Step 1: 网页标签**

`page()` 中这一行：

```js
var tag=v.source==="pinned"?'<span class="tag pin">钉死</span>':v.source==="fetched"?'<span class="tag get">npm</span>':'<span class="tag">内置</span>'
```

改为：

```js
var tag=v.source==="pinned"?'<span class="tag pin">钉死</span>':v.source==="detected"?'<span class="tag get">本机</span>':v.source==="fetched"?'<span class="tag get">npm</span>':'<span class="tag">内置</span>'
```

- [ ] **Step 2: README.zh-CN.md**

内置档案表格 `zcode` 行之后加：

```markdown
| `opencode` | `Bun/1.4.4`（真实客户端不设自定义 UA，运行时即 Bun） | `HTTP-Referer: https://opencode.ai/`、`X-Title/X-Source: opencode`、会话三件套 `x-opencode-session-id`/`X-Session-Id`/`x-session-affinity`（`ses_<64hex>`，进程内固定） |
| `antigravity` | `antigravity/hub/2.26.0 (aidev_client; os_type=windows; arch=amd64)` | 无（真实 Antigravity Hub 只发 UA）；已知构建号才带 `; cl=…` |
```

「已知局限」追加两条：

```markdown
- opencode：真实客户端只在 OpenRouter 等官方 provider 上发 `X-Title`/`HTTP-Referer`/`X-Source`，连自定义 baseURL 时只带会话头；本插件为便于中转站识别而全量发送，属有意偏差。
- antigravity：`cl=` 只在已知构建号（2.23.0/2.23.1/2.24.0）出现，未知版本省略而非冒充；中转站若校验构建号，可手动钉版本并扩展 CL 表。
```

- [ ] **Step 3: README.md（英文）**

对应表格加：

```markdown
| `opencode` | `Bun/1.4.4` (the real client sends no custom UA — the Bun runtime default rides along) | `HTTP-Referer: https://opencode.ai/`, `X-Title/X-Source: opencode`, session trio `x-opencode-session-id`/`X-Session-Id`/`x-session-affinity` (`ses_<64hex>`, fixed per plugin process) |
| `antigravity` | `antigravity/hub/2.26.0 (aidev_client; os_type=windows; arch=amd64)` | none (the real Hub sends only its UA); `; cl=…` only for known builds |
```

Known limits 追加：

```markdown
- opencode: the real client only sends `X-Title`/`HTTP-Referer`/`X-Source` on a few official providers; custom baseURLs get just the session headers. Sending all of them is deliberate, so relays can recognize the profile.
- antigravity: `cl=` appears only for known build changelists (2.23.0/2.23.1/2.24.0); unknown versions omit it rather than claim another build's CL.
```

- [ ] **Step 4: CHANGELOG.md 顶部加**

```markdown
## 1.4.0 — 2026-10-28

**opencode 与 Antigravity 档案 / opencode and Antigravity profiles**

- 新增内置档案 `opencode`：UA 为 `Bun/<版本>`（真实客户端不设自定义 UA），伴随 opencode 身份头与会话三件套（`ses_<64hex>`，进程内固定）。
  New built-in `opencode`: `Bun/<version>` UA (the real client sets none) plus opencode identity headers and the session trio.
- 新增内置档案 `antigravity`：`antigravity/hub/<版本> (aidev_client; os_type=…; arch=…[; cl=…])`，平台按本机生成，已知构建号才带 CL。
  New built-in `antigravity`: Hub-format UA with runtime platform; `cl=` only for known builds.
- antigravity 版本优先读本机安装（app.asar 内 package.json），读不到回退内置值；两个新版本键 `bun`/`antigravity` 均可用 `versions` 手动钉死。版本来源新增「本机」标签。
  Antigravity version is probed from the local install (app.asar), falling back to the built-in; both new keys are pinnable, and `/versions` gains a `detected` source.
```

- [ ] **Step 5: package.json 版本**

`"version": "1.3.1"` → `"version": "1.4.0"`；`description` / `keywords` 增加 `antigravity`：

```json
  "description": "Switch the User-Agent magpie sends upstream (Codex CLI / Claude Code / pi / ZCode / opencode / Antigravity / custom) from a tiny local web page",
```

keywords 数组加 `"antigravity"`。

- [ ] **Step 6: 全量测试 + 提交**

Run: `"C:\Users\Lenovo\.cache\magpie\bun\1.4.4\magpie-bun.exe" selftest.mjs`
Expected: `all tests passed`

```bash
git add index.mjs README.md README.zh-CN.md CHANGELOG.md package.json
git commit -m "docs and version 1.4.0: opencode / antigravity profiles"
```

---

## Self-Review

- Spec coverage：档案定义（Task 1/2）、CL 规则（Task 2）、本机探测与优先级（Task 3）、网页 source 标签（Task 4）、文档与偏差说明（Task 4）、测试断言（Task 1-3）——全覆盖。
- Placeholder scan：无 TBD/TODO；每个代码步骤给出完整代码。
- Type consistency：`readAsarPackageVersion` / `detectAntigravityVersion` / `OPENCODE_SESSION_ID` / `ANTIGRAVITY_CL` / `ANTIGRAVITY_PLATFORM` 命名在任务间一致；`versionState` 的 `detected` 值在 Task 3 产出、Task 4 消费。
