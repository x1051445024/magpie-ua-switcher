# magpie-ua-switcher

切换 **[magpie](https://github.com/yetone/magpie) 发往上游的 User-Agent**（及伴随身份头）：想伪装成 Codex 选 Codex，想伪装成 Claude Code 选 Claude Code，想伪装成 pi 选 pi。一键切换，即时生效，无需重启 magpie。

English docs: [README.md](README.md)。

## 工作原理（双机制）

magpie 有两条上游请求路径，本插件各覆盖一条：

1. **原生 provider**（providers.json 里的 API-key 条目，如中转站，由 magpie 的 Go 侧直接发请求）：切换档案时，插件把解析出的头写进 providers.json 对应条目的 `headers` 字段——该字段在 magpie 里**永远优先**于默认 UA，且 providers.json 热加载。只动插件自己写入的键（记录在配置文件 `applied` 字段），你手工设置的其他 headers 不受影响；切回 `off` 时恰好移除这些键。
2. **插件宿主路径的 provider**（如 zcode-auth 声明的 zcode）：通过 `chat.headers` 钩子注入，优先级最高，逐请求生效。

协议自适应：按 provider/模型的 SDK 包或 providers.json 的 wire 字段识别 anthropic / openai(responses) 协议，anthropic 专属头（anthropic-beta、X-Stainless-* 等）只发给 anthropic 协议请求，OpenAI-Beta 等只发给 responses 请求。

版本自动更新：codex（@openai/codex）与 claude-code（@anthropic-ai/claude-code）两个版本号在插件加载时后台查 npm（npmjs 优先、npmmirror 兜底，可配 `registry` 再加一个），有变化就写缓存并立即重写 providers.json 里的 UA；缓存 24 小时内不重复查（`updateEveryHours` 调）。aiSdk、pi、zcode 不自动更新——aiSdk 是 ZCode 内部捆绑的依赖，npm 最新值反而会拼出真实客户端不存在的组合；pi 和 zcode 没有公开 npm 包。手动钉版本永远优先：`"versions": {"codex": "0.170.0"}`。网页上有「检查更新」按钮，也可以 `curl -X POST http://127.0.0.1:3426/versions/refresh`，`curl http://127.0.0.1:3426/versions` 查看当前各版本来源（builtin / fetched / pinned）。

## 安装

```bash
magpie plugin add github:你的用户名/magpie-ua-switcher   # git 直装
magpie plugin add ./magpie-ua-switcher                  # 或本地路径
```

`plugin add` 会通知运行中的 magpie 重载插件宿主，无需重启应用。端口处理自愈：冲突时若已有健康的本插件实例在服务则让位给它，否则重试绑定 30 秒；此后请求钩子每分钟自检重绑，直到端口有人接管。

**开发调试**：本目录就是 git 仓库。改代码 → push → `magpie plugin update github:x1051445024/magpie-ua-switcher`，magpie 的托管安装即更新。

## 切换方式（网页可编辑一切）

**网页开关** <http://127.0.0.1:3426>：点卡片切换档案之外，还能直接编辑以下内容（保存即热生效，写入同一个配置文件）：

- **版本钉死**：每个客户端版本一个输入框，留空跟随自动更新，填入版本号即钉死
- **排除列表**：chip 式增删不改写的 provider
- **按 provider 覆盖**：每个 provider 一个下拉（跟随全局 / 关闭 / 任一档案）
- **自定义档案**：新增 / 编辑 / 删除（UA + 通用、anthropic、openai 三组头，每行「键: 值」）；双形态（`forms`）档案为防编辑降级，网页只读、仍走配置文件

也可以 curl 或直接改配置文件（热生效）：

```bash
curl http://127.0.0.1:3426/set/codex        # 切到 Codex CLI
curl http://127.0.0.1:3426/set/claude-code  # 切到 Claude Code
curl http://127.0.0.1:3426/set/pi           # 切到 pi（按协议自动双形态）
curl http://127.0.0.1:3426/set/zcode        # 切到 ZCode 客户端
curl http://127.0.0.1:3426/set/off          # 关闭，恢复 magpie 默认
curl http://127.0.0.1:3426/state            # 查看当前状态
curl -X POST http://127.0.0.1:3426/config -H "content-type: application/json" \
  -d '{"excludeProviders":["zcode"],"versions":{"codex":"0.170.0"}}'  # 编程式改配置
```

3. **直接改配置文件** `~/.config/magpie/ua-switcher.json`（下一次请求经过网关时生效）。

## 内置档案

codex/pi 的 UA 系统段按当前机器动态生成（与真实客户端行为一致）；版本号见上方「版本自动更新」，下表数字为示例（当前内置值）。

| id | User-Agent | 伴随头 |
|---|---|---|
| `codex` | `codex_cli_rs/0.164.0 (Windows 10.0.19045; x86_64) WindowsTerminal` | `originator: codex_cli_rs`；responses 协议另带 `OpenAI-Beta: responses=experimental` |
| `claude-code` | `claude-cli/2.1.310 (external, cli)` | `X-App: cli`；anthropic 协议另带 `anthropic-version`、`anthropic-beta: claude-code-20250219,…`、`X-Stainless-*` 全套 |
| `pi` | anthropic 端点 `claude-cli/2.1.75`；responses 端点 `pi (win32 10.0.19045; x64)` | 与真实 pi 客户端行为一致，按请求的 SDK 包自动选形态 |
| `zcode` | `ZCode/3.16.3 ai-sdk/anthropic/3.0.81` | `HTTP-Referer`、`X-ZCode-*`、`X-Device-Mid`（读本机真实设备 id）等 |
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
- `profiles`：自定义档案，合并覆盖同名内置。单形态 `{ "label", "ua", "headers": {"any","anthropic","openai"} }`；双形态 `forms: { anthropic, openai, default }`。
- `applied`：插件内部记账，勿手工编辑。

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

单元测试：`magpie-bun.exe selftest.mjs`（69 项断言）。

## 已知局限

- `chat.headers` 只能新增/覆盖头，不能删除（原生 provider 路径无此限制）。
- zcode 的 Start Plan（`-Trial`/gift 模型）路径会整体重建请求头，本插件对其 UA 不生效（也不应生效）。
- 只影响 magpie → 上游的请求头；不改变下游 agent → magpie 的请求。
- 网页开关只绑 `127.0.0.1`。
- 在 magpie 界面里编辑 provider 后，以界面保存的内容为准（插件下次切换时重写自己的键）。

## License

MIT — 见 [LICENSE](LICENSE)。
