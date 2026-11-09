# magpie-ua-switcher

切换 **[magpie](https://github.com/yetone/magpie) 发往上游的 User-Agent**（及伴随身份头）：想伪装成 Codex 选 Codex，想伪装成 Claude Code 选 Claude Code，想伪装成 pi 选 pi。一键切换，即时生效，无需重启 magpie。

English docs: [README.md](README.md)。

## 工作原理（双机制）

magpie 有两条上游请求路径，本插件各覆盖一条：

1. **原生 provider**（providers.json 里的 API-key 条目，如中转站，由 magpie 的 Go 侧直接发请求）：切换档案时，插件把解析出的头写进 providers.json 对应条目的 `headers` 字段——该字段在 magpie 里**永远优先**于默认 UA，且 providers.json 热加载。只动插件自己写入的键（记录在配置文件 `applied` 字段），你手工设置的其他 headers 不受影响；切回 `off` 时恰好移除这些键。
2. **插件宿主路径的 provider**（如 zcode-auth 声明的 zcode）：通过 `chat.headers` 钩子注入，优先级最高，逐请求生效。

第三个字段：当生效档案是 `claude-code`（或 pi 的 anthropic 形态）时，插件把真实 Claude Code 的 `metadata.user_id` 写进 **Messages 线路 provider 的 `extraBody`**，由 magpie 自己在请求发出前合进请求体。严格校验 Claude Code 身份的中转站要求「原始 UA + metadata.user_id 齐全」，只改头不改体会被拒或断流（上游常记为 499）；补上后即可通过。该 id 首次生成后持久化在配置同目录，跨请求稳定；请求体已带 `metadata` 时不覆盖，所以客户端自带的 `user_id` 不会被改，您手工设的 `extraBody` 也不会被插件认领。可在网页「Provider 设置」里关闭（配置项 `injectMetadata`）。

1.8.0 之前这个字段来自 **gateway 钩子**（`hooks.mjs`，由 `package.json` 的 `magpie.hooks` 声明），钩子已删除。在小内存机器上装旧版本会撑爆内存：只要声明了这个钩子，magpie 就会把**每一个** agent 请求体——完整历史、系统提示词、工具定义——通过 RPC 复制进 Bun 插件宿主，在宿主里再深拷贝一份，并为防篡改校验重新序列化，哪怕钩子最后对这个请求什么都没改。换到 `extraBody` 后这条路径完全消失。详见 [CHANGELOG](CHANGELOG.md) 1.8.0。

换到这条便宜路径有三个边界，其中第一条相对 1.7.0 是**真实损失**：

- **由 auth 插件承载的 provider 不在覆盖范围内。** magpie 只在"该 provider 是从 `providers.json` 构造、且没有登录账号"（以及 ChatGPT 登录账号）时读取 `extraBody`；由 `opencode-*-auth` 之类插件承载的 provider 带着登录账号，magpie 会直接忽略这个字段——插件也写不进去，因为那条条目本身没有端点。旧钩子能覆盖它们，因为它判的是客户端协议和模型名前缀，而不是 provider 条目。所以如果您的 Claude Code 专用中转站是通过 auth 插件添加的，1.8.0 会给它换头、但不会带 `user_id`。
- **`baseAPI` 为 Gemini 的 provider 不写**，因为 `generateContent` 会拒绝它没有对应字段的顶层名。
- **混线 provider 会在所有线路上带上这个字段。** 它的 Claude 模型不经转换直接打到 anthropic 端点，而 magpie 的 `extraBody` 是扁平的，所以该 provider 的 Chat/Responses 请求也会带 `metadata`；插件在日志里提示一次。完全没有 Messages 通路的 provider 不会被写入。

**已实测**：对一个不带该字段就回 `403 claude_code_required` 的中转站，经 magpie 走真实服务路径、档案已应用时返回 `200`；把 `injectMetadata` 关掉（请求头保持不变）后，站点重新索要 `metadata.user_id`。自查方法：`curl http://127.0.0.1:3426/state` 看 `metadata.providers`（插件到底给哪几个 provider 写了），再到 magpie 的 Routing 里确认那次请求确实由这个 provider 服务——**模型名要带 `providerID/modelID` 前缀**，裸模型名会被路由到 magpie 挑的任意一家，测不出目标站的行为。

协议自适应：按 provider/模型的 SDK 包或 providers.json 的 wire 字段识别 anthropic / openai(responses) 协议，anthropic 专属头（anthropic-beta、X-Stainless-* 等）只发给 anthropic 协议请求，OpenAI-Beta 等只发给 responses 请求。

版本解析优先级：**内置默认 < 本机 Antigravity 安装（仅 antigravity 键）< npm 抓取 < 手动钉死**。`antigravity` 从本机安装的 `app.asar` 根 `package.json` 读取（与运行中 language server 的 `--override_ide_version` 同值）；`bun`（opencode 的运行时 UA 版本）与 `antigravity` 不从 npm 抓取——Bun 版本只存在于 opencode 的编译产物里，Antigravity 也没有 npm 包。

版本自动更新：codex（@openai/codex）与 claude-code（@anthropic-ai/claude-code）两个版本号在插件加载时后台查 npm（npmjs 优先、npmmirror 兜底，可配 `registry` 再加一个），有变化就写缓存并立即重写 providers.json 里的 UA；缓存 24 小时内不重复查（`updateEveryHours` 调）。aiSdk、pi、zcode 不自动更新——aiSdk 是 ZCode 内部捆绑的依赖，npm 最新值反而会拼出真实客户端不存在的组合；pi 和 zcode 没有公开 npm 包。手动钉版本永远优先：`"versions": {"codex": "0.170.0"}`。网页上有「检查更新」按钮，也可以 `curl -X POST http://127.0.0.1:3426/versions/refresh`，`curl http://127.0.0.1:3426/versions` 查看当前各版本来源（builtin / fetched / pinned）。

## 安装

```bash
magpie plugin add github:你的用户名/magpie-ua-switcher   # git 直装
magpie plugin add ./magpie-ua-switcher                  # 或本地路径
```

`plugin add` 会通知运行中的 magpie 重载插件宿主，无需重启应用。端口处理自愈：冲突时若已有健康的本插件实例在服务则让位给它，否则重试绑定 30 秒；此后请求钩子每分钟自检重绑，直到端口有人接管。

**开发调试**：本目录就是 git 仓库。改代码 → push → `magpie plugin update`，magpie 的托管安装即更新。注意它没有单插件形式：spec 参数会被忽略，所有插件一起更新（`internal/cli/plugins_cli.go` 的 `case "update", "upgrade":` 直接调 `plugin.Update(ctx)`）；该命令结尾会 `Restart()` 插件宿主（`internal/plugin/store.go`），所以不必重启 magpie。

## 切换方式（网页可编辑一切）

**网页开关** <http://127.0.0.1:3426>：点卡片切换档案之外，还能直接编辑以下内容（保存即热生效，写入同一个配置文件）：

- **版本钉死**：每个客户端版本一个输入框，留空跟随自动更新，填入版本号即钉死
- **排除列表**：chip 式增删不改写的 provider
- **按 provider 覆盖**：每个 provider 一个下拉（跟随全局 / 关闭 / 任一档案）
- **自定义档案**：新增 / 编辑 / 删除（UA + 通用、anthropic、openai 三组头，每行「键: 值」）；双形态（`forms`）档案为防编辑降级，网页只读、仍走配置文件
- **页面字号**：滑块或数值（12–24px）固定字号，重置则恢复随窗口自适应；偏好存在浏览器本地（localStorage），不动配置文件
- **改动何时生效**：档案卡片、排除列表、按 provider 覆盖都是**一改即存**；版本钉死与自定义档案仍要点各自的保存按钮，但你写的内容会先记成草稿——区块标题旁标「有未保存草稿」，页面每 3 秒的自动刷新不会抹掉它，带着草稿关标签页会先拦一次

也可以 curl 或直接改配置文件（热生效）：

```bash
curl http://127.0.0.1:3426/set/codex        # 切到 Codex CLI
curl http://127.0.0.1:3426/set/claude-code  # 切到 Claude Code
curl http://127.0.0.1:3426/set/pi           # 切到 pi（按协议自动双形态）
curl http://127.0.0.1:3426/set/zcode        # 切到 ZCode 客户端
curl http://127.0.0.1:3426/set/opencode     # 切到 opencode（Bun 运行时 UA + 会话头）
curl http://127.0.0.1:3426/set/antigravity  # 切到 Antigravity Hub
curl http://127.0.0.1:3426/set/off          # 关闭，恢复 magpie 默认
curl http://127.0.0.1:3426/state            # 查看当前状态
curl -X POST http://127.0.0.1:3426/config -H "content-type: application/json" \
  -d '{"excludeProviders":["zcode"],"versions":{"codex":"0.170.0"}}'  # 编程式改配置
```

3. **直接改配置文件** `~/.config/magpie/ua-switcher.json`（magpie Docker 镜像里是 `/config/magpie/ua-switcher.json`，见[文件位置](#文件位置)；下一次请求经过网关时生效）。

## 内置档案

codex/pi 的 UA 系统段按当前机器动态生成（与真实客户端行为一致）；版本号见上方「版本自动更新」，下表数字为示例（当前内置值）。

| id | User-Agent | 伴随头 |
|---|---|---|
| `codex` | `codex_cli_rs/0.164.0 (Windows 10.0.19045; x86_64) WindowsTerminal` | `originator: codex_cli_rs`、会话指纹 `x-codex-window-id`/`session-id`（UUID，满足 Sub2API `codex_cli_only` 引擎指纹硬门）；responses 协议另带 `OpenAI-Beta: responses=experimental` |
| `claude-code` | `claude-cli/2.1.310 (external, cli)` | `X-App: cli`；anthropic 协议另带 `anthropic-version`、`anthropic-beta: claude-code-20250219,…`、`X-Stainless-*` 全套 |
| `pi` | anthropic 端点 `claude-cli/2.1.75`；responses 端点 `pi (win32 10.0.19045; x64)` | 与真实 pi 客户端行为一致，按请求的 SDK 包自动选形态 |
| `zcode` | `ZCode/3.16.3 ai-sdk/anthropic/3.0.81` | `HTTP-Referer`、`X-ZCode-*`、`X-Device-Mid`（读本机真实设备 id）等 |
| `opencode` | `Bun/1.4.4`（真实客户端不设自定义 UA，运行时即 Bun） | `HTTP-Referer: https://opencode.ai/`、`X-Title/X-Source: opencode`、会话三件套 `x-opencode-session-id`/`X-Session-Id`/`x-session-affinity`（`ses_<64hex>`，进程内固定） |
| `antigravity` | `antigravity/hub/2.26.0 (aidev_client; os_type=windows; arch=amd64)` | 无（真实 Antigravity Hub 只发 UA）；已知构建号才带 `; cl=…` |
| `off` | 不改写 | 恢复 magpie 默认行为 |

## 配置文件 `~/.config/magpie/ua-switcher.json`

```json
{
  "profile": "off",
  "excludeProviders": ["zcode"],
  "providerOverrides": {},
  "port": 3426,
  "log": "change",
  "selfcheck": false,
  "autoVersions": true,
  "updateEveryHours": 24,
  "registry": null,
  "versions": {},
  "profiles": {}
}
```

- `profile`：全局当前档案（网页/curl 改的就是它）。
- `excludeProviders`：不改写的 provider 列表。默认排除 `zcode`——Z.ai 上游要求 ZCode 客户端身份（免费 Start Plan 非此身份返回 405）。
- `providerOverrides`：按 provider 覆盖，如 `{"newapi": "codex"}`。
- `port`：网页开关监听端口（改后需重载插件）。
- `log`：`change` | `always` | `off`。
- `selfcheck`：自检模式，见下。
- `autoVersions` / `updateEveryHours` / `registry`：npm 版本自动更新的开关、查询间隔（小时）、额外的首选 registry。
- `versions`：手动钉版本，如 `{"codex": "0.170.0"}`，优先级最高。
- `injectMetadata`：默认 true。为 Claude Code 身份档案的 Messages provider 写 `metadata.user_id`（providers.json 的 `extraBody`）；关掉即把插件写过的那份撤掉，不碰其它。
- `profiles`：自定义档案，合并覆盖同名内置。单形态 `{ "label", "ua", "headers": {"any","anthropic","openai"} }`；双形态 `forms: { anthropic, openai, default }`。
- `applied` / `appliedMeta`：插件内部记账（分别在 providers.json 里写过的 header 键与 extraBody 字段），勿手工编辑。

### 文件位置

插件读取的 `providers.json`、自己的 `ua-switcher.json`（以及 `-versions` / `-userid` 两个附属文件）都放在 magpie 自己使用的目录：优先用 magpie 传给插件的目录（含便携版），否则在 `$XDG_CONFIG_HOME` 为绝对路径时用 `$XDG_CONFIG_HOME/magpie`，再否则用 `~/.config/magpie`。magpie 官方 Docker 镜像里是 `/config/magpie`（镜像设置了 `XDG_CONFIG_HOME=/config`、`HOME=/config/home`）。旧版本留在 `~/.config/magpie` 的文件会自动复制过来一次。网页和 `/state`（`providersPath`、`providersError`）会显示实际读取的 `providers.json` 及读不到的原因。

如需指定别的位置，在 magpie 的运行环境里设置（容器用 `docker run -e …`）：

- `UA_SWITCHER_PROVIDERS`：要读取并改写的 `providers.json`。
- `UA_SWITCHER_CONFIG`：插件自己的 `ua-switcher.json`。

## 自检（验证改写真的到达上游）

```bash
# 1. 配置 "selfcheck": true 后重载：
magpie plugin add /path/to/magpie-ua-switcher
# 2. 起回显服务器（用 magpie 自带 Bun）：
magpie-bun.exe /path/to/magpie-ua-switcher/echoserver.mjs
# 3. 切到任一档案，向网关发测试请求：
curl -X POST http://127.0.0.1:3425/v1/messages -H "Authorization: Bearer magpie" \
  -H "Content-Type: application/json" \
  -d '{"model":"ua-echo/test","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'
#    （预期 502 "unexpected reply"——响应格式故意不匹配；关键是请求已到达回显服务器）
# 4. 查看回显到的请求头：cat /path/to/magpie-ua-switcher/ua-echo-last.json
# 5. 验证完把 "selfcheck" 改回 false 并重载
```

单元测试：`magpie-bun.exe selftest.mjs`（189 项断言：各档案 × 各协议、排除列表、按 provider 覆盖、版本钉、asar 版本读取、`/config` 校验、providers.json 写入与回滚、user_id 所寄的 extraBody 写入与撤回，以及「不得声明任何 gateway 钩子」的守卫）。

## 已知局限

- `chat.headers` 只能新增/覆盖头，不能删除（原生 provider 路径无此限制）。
- zcode 的 Start Plan（`-Trial`/gift 模型）路径会整体重建请求头，本插件对其 UA 不生效（也不应生效）。
- opencode：真实客户端只在 OpenRouter 等少数官方 provider 上发 `X-Title`/`HTTP-Referer`/`X-Source`，连自定义 baseURL 时只带会话头；本插件为便于中转站识别而全量发送，属有意偏差。
- antigravity：`cl=` 只在已知构建号（2.23.0/2.23.1/2.24.0）出现，未知版本省略而非冒充；中转站若校验构建号，可手动钉版本并扩展 CL 表。
- 只影响 magpie → 上游的请求头；不改变下游 agent → magpie 的请求。
- 网页开关只绑 `127.0.0.1`。
- 在 magpie 界面里编辑 provider 后，以界面保存的内容为准（插件下次切换时重写自己的键）。
- 1.8.0 起，显式声明 `baseAPI: "anthropic"` 的 provider 即使同时存了 `responses` URL，也仍按 anthropic 头组发送——**只改了这一种情形**，其余 provider 的头分组与之前完全一致。`metadata.user_id` 的判据比头的判据宽：有 anthropic 端点的 provider 会写，即使它的头仍走另一组。
- 您自己写的、或改过的 `extraBody.metadata` 不会被覆盖也不会被删除：插件只认领仍带本机 base id（`ua-switcher-userid.json` 里那个）的字段，从别的机器抄来的真实 `user_id` 即使账本里记着这个 provider 也不会被动。
- `metadata.user_id` 需要 **magpie v0.1.1191 及以上**：那是第一个读取 provider `extraBody` 的版本（commit `863af7a`，#1604）。低于它，字段写得进去但被静默忽略。magpie 桌面版会在配置目录留一个 `last-version`，插件读到且确认过旧时会在日志里警告；无头的 `magpie web` 没有这个文件，此时插件不作任何猜测，本行文档就是唯一提示。

## License

MIT — 见 [LICENSE](LICENSE)。

## 工具 schema 诊断（可选）

1.8.0 起诊断挪进了中间件——原先是网关钩子把这些项写进 `ua-switcher-tools.json`，而那个钩子本身就是内存放大的来源，已删除。开启方式是设置插件 options（不是 `ua-switcher.json`，因为 moejs 沙箱读不了文件）：

```bash
magpie plugin options ua-switcher '{"diagnose":true}'
```

或在 magpie 的 Plugins › Installed 里点这个插件的 Options 按钮。开启后，带工具的请求会检查一次工具定义，把 Anthropic 会拒绝的项（顶层 `oneOf`/`allOf`/`anyOf`，或缺少顶层 `type`）按工具名与形状写进 magpie 的日志，同一形状只记一次。只读，不改请求。关掉：`magpie plugin options ua-switcher off`。

Anthropic 的 Messages API 不接受工具 `input_schema` 顶层的 `oneOf`/`allOf`/`anyOf`；有些 MCP 工具用 zod 的 `.refine()` 表达互斥参数，转成 JSON Schema 后正好落在顶层，于是只有真 Anthropic 端会报 `input_schema does not support oneOf, allOf, or anyOf at the top level`，而 GLM 等兼容层不校验。用这个诊断能直接定位是哪个工具。

## 工具 schema 兼容层（gateway middleware）

`schema.middleware.mjs` 经 `package.json` 的 `magpie.middleware` 由 magpie 主进程加载（moejs，非插件宿主），对 **anthropic 协议**的请求清洗每个工具 `input_schema` 的**顶层**：

- 删除顶层 `oneOf` / `allOf` / `anyOf`（真 Anthropic 端点会拒绝；GLM 等兼容层不校验，所以此前只在 Claude 线路暴露）
- 顶层缺 `type` 补 `"object"`，缺 `properties` 补 `{}`
- `required` 里引用了不存在属性的名字会被剔除

嵌套的 `oneOf` 是合法的，保持原样；不需要清洗的请求原样转发（字节不变）。若某个工具 schema 本身就只有一个 union，会把各分支的 `properties` 合并成对象。

**关闭**：moejs 沙箱读不到配置文件，因此没有网页开关，用选项关闭：

```bash
magpie plugin options github:x1051445024/magpie-ua-switcher '{"disable":true}'
```

关闭后需 `plugin off` / `plugin on`（或重启 magpie）才进已加载的 middleware。

## 致谢与贡献者 / Acknowledgements

感谢以下社区贡献者的杰出工作与代码贡献：
- [@bearchild233](https://github.com/bearchild233) (Yu Xiaoxiang)：提交 [PR #1](https://github.com/x1051445024/magpie-ua-switcher/pull/1)，系统定位并修复了 Docker、XDG 与便携版环境下的配置路径决议机制、文件权限与软链接保持，以及端口看门狗自愈支持。
- 再次感谢 [@bearchild233](https://github.com/bearchild233)：报告了 `magpie-bun` 在内存受限的 Docker 容器里被 OOM 强杀，并附上了内核日志与根因分析。1.8.0 移除网关钩子、把 `metadata.user_id` 改寄 magpie 原生 `extraBody`，正是基于这份报告。

