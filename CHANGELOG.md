# Changelog

## 1.8.8 - 2026-11-12

**按 Claude Code 版本选择 metadata 身份编码 / Match metadata identity encoding to the Claude Code version**

### 中文

- 排查 [issue #3](https://github.com/x1051445024/magpie-ua-switcher/issues/3) 时发现：默认 Claude Code UA 已高于 2.1.78，但 `metadata.user_id` 仍固定使用旧格式。现在实际生效的 `claude-cli/2.1.78` 及以上 UA 使用含 `device_id`、`account_uuid`、`session_id` 的 JSON 字符串，旧版继续使用原来的拼接字符串。
- 格式选择遵循版本钉死、按 provider 覆盖及自定义 UA 的最终结果；升降版本保留同一组身份字段。原生 `extraBody` 注入方式保持不变。
- 新旧编码都可识别为本插件写入的身份，关闭时正确清理；保留客户端 metadata、外部身份以及增加手工字段的身份。仅保存新版身份的文件也可继续复用原设备和账号基底。
- 修正文档中补齐 UA 和 metadata 就能通过所有严格中转站的说法。系统提示词和中转站自身的身份校验仍可能导致拒绝；本次没有改写调用方系统提示词。
- 验证：330 项隔离回归断言通过；真实 Magpie 的隔离 Messages 链路验证了默认新版、降级、升级、客户端 metadata 保留和关闭清理，使用合成身份和假密钥，无外部请求，未改动日常配置，辅助进程已退出。该链路测试在宿主外运行插件，并等待时间戳回退及网关缓存刷新，不用于证明首请求的刷新时序。
- issue #3 报告者的具体 `400 Invalid Claude request identity` 尚未复现，保持 issue 开放，等待其客户端和中转站版本及脱敏请求信息复测。

### English

- While investigating [issue #3](https://github.com/x1051445024/magpie-ua-switcher/issues/3), found that the default Claude Code UA was newer than 2.1.78 while `metadata.user_id` still always used the legacy encoding. Effective `claude-cli/2.1.78` and newer UAs now use a JSON string containing `device_id`, `account_uuid`, and `session_id`; older versions keep the original concatenated string.
- Encoding follows the resolved version pin, provider override, and custom UA. Switching versions preserves the same identity components. Injection continues through native `extraBody`.
- Recognize both encodings as plugin-owned identities for cleanup on disable. Preserve client metadata, foreign identities, and identities with extra manual fields. Identity files containing only the modern encoding retain their device/account base on reload.
- Corrected the documentation's claim that UA plus metadata is sufficient for every strict relay. System prompts and relay-specific identity checks can still reject a request; the caller's system prompt is preserved.
- Validation: all 330 isolated regression assertions passed. An isolated real Magpie Messages path verified the default modern encoding, downgrade, upgrade, client metadata preservation, and cleanup on disable, using synthetic identities and a fake key with no external requests or live configuration changes. Helper processes exited. This transport test runs the plugin outside its native host and waits for the timestamp fallback and gateway caches; it does not establish first-request refresh timing.
- The reporter's exact `400 Invalid Claude request identity` in issue #3 has not yet been reproduced. The issue remains open pending retesting with their client/relay versions and sanitized request details.

## 1.8.7 - 2026-11-12

**修复 Pi 原生请求头切换与关闭后的缓存残留 / Fix native header switching for Pi and stale headers after disabling**

### 中文

- 修复原生 API-key provider 的头配置已经写入 `providers.json`，但运行中的 Magpie 仍用旧请求头的问题。实际变更后通过宿主现有事件协议通知缓存失效，开启和关闭覆盖都生效；重复设置相同值不发送多余通知。
- Magpie 会把插件的 `process.stdout.write` 重定向到日志；缓存事件改为通过同一 stdout 流队列写入完整帧，避免背压下穿插正在发送的大 RPC 消息。HTTP 切换响应等待写入完成与事件调度，同一时段的重复切换和无改动配置提交也等待尚未完成的通知。无需 gateway 钩子，也不修改登录信息或重启宿主。
- 请求头名称按大小写不敏感合并，避免重复 UA / originator。记录插件写入值与原始值，关闭时恢复原值，并保留后续手工修改。升级旧版仅记录键名的配置时，先撤回已认领的旧插件头，避免关闭后重新恢复它们；旧版已覆盖且未保存的原值仍无法找回。
- Codex / opencode 会话标识持久化，宿主重载不再生成另一组请求头或触发反复刷新。修复继承属性被当成档案或 provider 覆盖的问题，并拒绝 UA 中的控制字符。
- 更新双语文档：说明 `modelHeaders` / `passHeaders` 的优先级例外、内部恢复记账和非宿主运行时的时间戳通知回退。
- 验证：308 项隔离回归断言通过，包括大 RPC 帧分段发送时的通知完整性；真实 Magpie 上开启后的首条 Pi 请求使用所选头并返回 `200 OK`，关闭后的首条恢复 Pi 原头并得到严格客户端校验的预期 `401`；不加载兼容扩展的完整 Pi CLI 返回 `OK`。测试临时配置均已还原。

### English

- Fixed native API-key providers retaining old request headers in the running Magpie process after `providers.json` had been updated. Actual changes now notify the host's existing cache invalidation protocol, including when disabling an override; unchanged headers send no redundant event.
- Magpie redirects plugin `process.stdout.write` to its log stream, so the event now uses a complete frame through the same stdout stream queue, preserving large RPC messages under backpressure. HTTP switches wait for the write to complete and for event dispatch; repeated switches and unchanged configuration submissions also wait for a pending notification. This requires no gateway hook, sign-in change, or host restart.
- Merge header names case-insensitively to avoid duplicate UA / originator entries. Track written and original values so disabling restores originals while preserving later manual edits. Upgrades from key-only ledgers remove previously claimed plugin headers before capturing originals, preventing those headers from being restored on disable. Original values overwritten and never saved by older versions cannot be recovered.
- Persist Codex / opencode session identifiers across host reloads to avoid header churn and repeated refreshes. Reject inherited properties as profile/provider overrides and reject control characters in User-Agent values.
- Updated both READMEs with `modelHeaders` / `passHeaders` precedence exceptions, restoration bookkeeping, and the timestamp notification fallback outside the native host.
- Validation: all 308 isolated regression assertions passed, including notification framing while large RPC messages are sent in segments. On a running Magpie instance, the first Pi request after enabling used the selected headers and returned `200 OK`; the first request after disabling restored Pi's original headers and received the expected `401` from strict client validation. A complete Pi CLI run returned `OK` without loading the compatibility extension. Temporary test configuration was restored.

## 1.8.6 — 2026-11-09

**补齐 Codex 引擎指纹头，解决 codex_cli_only 上游 403 / Complete Codex engine fingerprint headers to satisfy codex_cli_only upstreams**

- **背景与根因**：用户在使用严格校验 Codex 官方客户端身份的上游（如 Sub2API 开启 `codex_cli_only: true`）时，遭遇 `403 Forbidden: {"error":{"message":"This account only allows Codex official clients","type":"forbidden_error"}}`。
  - Sub2API 判定链第 4 步识别官方 UA / originator，第 5 步识别版本，第 6 步进入**引擎指纹硬门**（`EvaluateEngineFingerprint`）。
  - Sub2API 默认内置规则 `{Type: "header_prefix", Match: ["x-codex-"], Required: true}`（依据官方客户端 98.8% 必带 `x-codex-window-id`）。若无 `x-codex-` 前缀头，统一走通用兜底文案拒绝。
- **改法**：
  - `codex` 预设在 `headers.any` 中补齐 `x-codex-window-id`（UUIDv4，进程生命周期稳定）与 `session-id`（同 UUID）。
  - 自动穿透原生 `providers.json` 重写与 `chatHeaders` 运行时中间件。
- **实测验证**：
  - 对照测试：缺失指纹时返回 403 Forbidden；补齐 `x-codex-window-id` 后 200 OK 且 GPT-6.1 推理流顺畅返回。
  - selftest 扩充至 220 项，全数通过。

## 1.8.5 — 2026-11-06

**草稿按行原样保存，不再只数空行 / Drafts keep every row verbatim, not a count of blanks**

- **1.8.4 的修法漏了一半**：它"数出空行、渲染时补回"，但只填了名字、值还没打的行——`!k && !v` 不成立、又过不了 `!v` 校验——于是**既没进 headers 也没被计入 blank**，下一次 `load(true)` 照样消失。这条是在**已安装的线上副本**上跑到一半实测到的（`rows: 0`），而半填正是打字过程中最常停留的状态。
- **改成按行原样存**：`readCpCard` 把每一行（空行、半填行、非法行都算）记进 `rows`，快照写进 `cpDraft[id].rows`，渲染时 `Array.isArray(p.rows) ? p.rows : flattenCustomHeaders(...)`；提交仍只发 `obj`，`rows` 是纯前端字段，实测落盘那份 profile 的键只有 `label,ua,headers`。blank 计数整套删除。
- **顺带的收益**：非法字段名的行现在留在原位、保存时才报错并指名道姓，不再静默消失。
- **实测**（开发副本实例，显式 `load(true)` tick）：空行经 2 tick 仍在；半填行 `X-Half=` 经 2 tick 文本保住且 `payloadHeaders: null`；补完值 → headers 出现；保存后 `draftKeys: []` 且磁盘无 `rows` 字段；再加一行 `Bad Name:` → 经 2 tick 留在原位，点保存得到「预设 rows-test 含非法或受保护的 Header 字段名: Bad Name:」。
- **selftest 240 → 242 项**：把 1.8.4 的 5 项计数断言换成 6 项按行断言，其中 5 项用一个假 card 真跑 `readCpCard`（行序与半填内容、payload 不含非法/未完成行、strict 抛错 vs 快照静默）。
- **方法上记一句**：1.8.4 和 1.8.5 两个 bug 都是"在线上副本再跑一遍"抓出来的，开发实例跑不出第二个——同一份代码值得两条车道各跑一次。

## 1.8.4 — 2026-11-06

**没填的 header 行不再在轮询下消失 / An unfilled header row survives the poll**

- **怎么漏的**：1.8.3 的草稿救回了"有数据的行"，但空行没有——`readCpCard` 里 `if (!k && !v) return;` 直接跳过，于是点完「+ 添加 Header」、字还没打的那一行，会被下一次 `load(true)` 重建掉。这条不是推演：是在**已安装的线上副本**上做接线检查时实测到的（`hdrRows: 0`）。教训顺带记一笔：线上与开发副本代码一致，不代表可以省掉在线上那一次。
- **改法**：`readCpCard` 数出空行并返回 `blank`，快照存进 `cpDraft[id].blank`，渲染时 `hdrRows.concat(blanks)` 补回（上限 20 行，防脏值）；提交仍只发 `obj`，`blank` 进不了 payload。行的 markup 抽成 `hdrRowHtml()`，渲染与「+ 添加 Header」共用一份，避免两处漂移。
- **实测**（开发副本实例，显式 `load(true)` tick，不用墙钟）：空行经 2 个 tick 仍在（`rows: 1`、`blank: 1`）；填上值后 `blank` 归 0、值保住；再加一个空行并 blur → 2 行、顺序 `X-Blank,(blank)`；保存后服务端那份只有真头、草稿清空、卡片回到 1 行。
- **selftest 230 → 240 项**：5 项盯接线，5 项用一个假 card 真跑 `readCpCard`（空行计数、混合行、payload 不含 blank、strict 抛错 vs 快照跳过）。

## 1.8.3 — 2026-11-06

**轮询不再吃掉未保存的编辑；`/state` 不再每次重读 providers.json / The poll stops eating unsaved edits; /state stops re-reading providers.json**

- **背景**：1.8.2 只摆正了路由表。版本钉死与自定义预设工坊是同一个形状——改动只由按钮提交，而页面每 3 秒 `load(true)` → `render()` 整块重建，实测后果是：`.ver-pin` 里的输入被换节点清空（`sameNode: false`，焦点掉到 BODY）；自定义预设的新卡片随 `S` 被 `/state` 整体覆盖而整张消失；「+ 添加 Header」加出来的行只活在 DOM 里，同样消失。
- **改法**（三条，都是让轮询给用户让路，而不是让用户迁就轮询）：
  - `providersForUi()` 按 mtime 缓存，与配置文件、npm 缓存、ASAR 探测同一套做法。此前每次 `/state` 都整读并 `JSON.parse` 一遍 providers.json（本机 15,509 字节 / 16 个 provider，实测 0.16 ms；`/state` 整体中位 1.61 ms，页面一次 `render()` 中位 10.2 ms）。
  - 焦点落在 `#ver-tbody` 或 `#cp-list` 内时这两块不重建（与 1.8.2 的路由表同一手法）；用户自己触发的重绘走 `force`，不会被守卫挡住。
  - 未保存的编辑记进独立草稿：`pinDraft`（含 ✕ 清除）、`cpDraft`（编辑与新建，删除用 `null` 墓碑）。`load()` 只换 `S`，动不到草稿；提交成功后草稿清空，回到服务端真相。卡片的"读来快照"与"发去提交"共用 `readCpCard`，避免看到的不等于发出去的。
- **顺带**：两个区块标题旁出现「有未保存草稿」标记；带草稿时版本行的来源徽章显示「草稿（未保存）」，不再一边是空的输入框一边声称「手动锁定」；带着草稿关标签页会先拦一次。
- **实测方法本身被纠正了一次**：in-app 浏览器处于 `visibilityState: hidden`，Chrome 把 3 秒定时器节流——实测 10 秒内 `/state` 命中 **0 次**。所以本轮验证全部改用显式 `await load(true)`（正是轮询要调的那一句）跑 2–3 个 tick，而不是等墙钟四秒；1.8.2 那轮靠墙钟等待得出的几处结论，这次按 tick 重跑过，结论不变。逐条结果：路由 3 个 tick 后 `relay-b=pi` 与服务端两条覆盖都在；pin 2 个 tick 后同键重建、`7.7.7` 保住、徽章为「草稿（未保存）」，✕ 清除后 2 个 tick 仍为空；草稿卡片连同新加 header 行经 3 个 tick 全在，保存后 `draftKeys: []` 且服务端有该档案，删除墓碑经 3 个 tick 卡片不再出现，再保存后服务端清空。
- **selftest 204 → 230 项**：16 项盯 ui.html 的守卫与草稿接线，6 项把 `applyDraft` 抠出来真跑（含"绝不改动服务端那份 map"），4 项靠临时替换 `fs.readFileSync` 数出 providers.json 的读次数（不变时 0 次、外部改动后恰好 1 次、读完重新武装）。
- **更正两处自家文档**：① `magpie plugin update <spec>` 的 spec 参数被忽略——`internal/cli/plugins_cli.go:88` 的 `case "update", "upgrade":` 直接 `plugin.Update(ctx)`，README 里"只更新本插件"那句不成立；② `plugin.Update` 结尾会 `Restart()` 插件宿主（`internal/plugin/store.go:590`；`internal/plugin/host.go:683` 的注释明写 "a plugin updating never cuts a reply"），所以 1.8.0 条目里"升级后重启 magpie"并不必要。

## 1.8.2 — 2026-11-06

**路由下拉框改为即时保存 / The routing dropdowns commit on change**

- **现象**：「Provider 路由与排除矩阵」里给某个 provider 选了档案或「排除」，几秒后自己跳回 🔗 跟随全局，配置里从未出现过这条覆盖。
- **根因（纯前端，与 1.8.0 的改动无关）**：`.prov-route-sel` 没有 change 处理器，它的值只在点「保存路由设置」时被读一次；页面每 3 秒 `load(true)` 拉 `/state` 并整表重建，`renderProviderTable()` 按 `S.providerOverrides` 回写——没提交过的选择在下一轮渲染里被抹掉。后端是清白的：直接向 `/config` POST `{"providerOverrides":{"agent":"codex"}}`，文件与 `/state` 6 秒以上保持该值；1.8.0 新增的 `appliedMeta` 落账也不会覆盖 `providerOverrides`。同一页面里 `#sw-metadata` 开关是即存的，两处行为本来就不一致。
- **改法**：
  - 用**事件委托**绑在 `#prov-tbody` 上（行会被重渲染，逐个绑定会随重建一起丢失），选完即提交 `excludeProviders + providerOverrides`；「保存路由设置」保留，作为对当前列表的整批提交。
  - 提交以 `S` 为底本、只折这一行的改动，所以搜索框过滤掉的行不会被顺手清空。
  - 两处让路：POST 在飞时轮询不覆盖 `S`；某个下拉框还持焦时不重建这张表——原生弹层会随 `<select>` 被移除而关闭，正在做的选择一起丢。
  - 顶部新增 `#route-hint` 提示条，区分「正在保存」与「正在操作」；保存被服务端拒绝时用真相重建那一行（`routeRenderForced`），不留一个没人认账的下拉框。
- **实测**（开发副本单实例：端口 3499、临时配置与临时 providers，不碰本机安装）：锁定 `claude-code` 后 8 秒（≥2 个轮询周期）DOM、`/state`、配置文件三处一致，且该 provider 确实拿到了 claude-code 的全套头与 `metadata.user_id`（全局档案仍是 `off`）；排除、改回跟随全局、批量保存、以及构造一次被 400 拒绝的选择后回滚——四条路径逐条走查；切换全局档案不影响已锁定的行；深浅两套主题下提示条配色都过了一遍。selftest 从 189 项增至 **204 项**，新增 15 项：8 项盯 ui.html 的委托绑定与两处让路，6 项把 `deriveRouting` 抠出来真跑各种取值组合，1 项盯提交体的字段集合。
- **装机生效**：`ui.html` 由插件按 mtime 每次请求重读（`index.mjs:1089` 的 `page()`），浏览器刷新页面即可拿到新交互，**不需要重启 magpie**；但 `/state` 的 `version` 是模块加载时的常量，要等插件宿主重载才显示 1.8.2——这条遗留仍记在 1.8.1 条目里。
- **顺带更正 1.8.1 的一条说法**（见下方条目）：`github:` 安装并不按 `package.json` 的 `files` 筛选，为「让文档到达用户机器」而单独切一版并非必需。

## 1.8.1 — 2026-11-04

**文档版：把 extraBody 的覆盖边界送达安装副本 / Docs only: the extraBody boundaries reach the installed package**

- 代码零改动，189 项 selftest 断言与 1.8.0 完全一致。
- 存在的理由（**此句由 1.8.2 复核更正**）：当时以为 `README` 与 `CHANGELOG` 靠 `package.json` 的 `files` 到达用户机器，而 1.8.0 之后补进 `main` 的边界说明在 1.8.0 那份里看不到。复核不成立：`CHANGELOG.md` 本来就不在 `files` 列表里，而本插件走 `github:` 安装，bun 取的是仓库归档、`files` 不参与筛选（本机 `install-cache/@GH@x1051445024-magpie-ua-switcher-ecc0c88@@@1/` 里 `CHANGELOG.md`、`selftest.mjs`、`docs/` 都在）。那批文档随下次更新本就会到达，为它单独切一版不是必需——本版已发布，实际作用只剩把 `version` 推到 1.8.1。
- 补上的内容（见 1.8.0 条目之后的 `main` 提交 `6193af6`）：
  - **由 auth 插件承载的 provider 不被覆盖**，这是相对 1.7.0 的真实损失（原措辞"已登录账号"写窄了）。magpie 只在 provider 由 `providers.json` 构造且无登录账号时读取 `extraBody`；插件承载的 provider 带 `Account`，字段既写不进也会被丢弃。
  - Gemini 基座与混线 provider 两个边界各自的后果与日志提示。
  - **已实测通过严格中转站**的记录，以及一条自查陷阱：模型名必须带 `providerID/modelID` 前缀，裸模型名会被路由到 magpie 挑的任意一家，据此得出的"通过"不成立。
- 已知遗留（未在本版处理）：`/state` 的 `version` 字段是硬编码的，与 `package.json` 各写一份，升版要同时改两处。

## 1.8.0 — 2026-11-04

**移除 gateway 钩子：`metadata.user_id` 改走 magpie 原生 extraBody / Drop the gateway hook; the user_id rides magpie's own extraBody**

- **为什么改**：`package.json` 只要声明 `magpie.hooks`，magpie 就会把**每一个** agent 请求体（完整历史、系统提示词、工具定义）通过 RPC 复制进 Bun 插件宿主（`internal/plugin/gateway.go:206`），在宿主里为每个钩子 `structuredClone` 一次（`internal/plugin/host.js:1414`），返回新体时再 `JSON.parse(JSON.stringify())` 一次（`:1419`），最后为防篡改把 `tools` 等 7 个键各序列化两遍（`:1426-1429`）——**即使钩子对这个请求什么都没改也照做**。JavaScriptCore 把 JSON 解析成对象树后再放大 5~10 倍，且不会及时把物理页交还内核。反馈的容器（magpie 官方镜像，`ghcr.io/yetone/magpie`）因此涨到 626MB 触发 OOM。
- **怎么改**：插件在切换档案时把 `metadata.user_id` 写进 Messages 线路 provider 的 `extraBody`（providers.json），由 magpie 在 Go 侧、请求发出前的最后一步合并（`internal/provider/extrabody.go:144`）。JavaScript 不再看到这个请求体，`HasGateway()` 变 false，整条 RPC 路径消失。
- **语义保持**：magpie 的 extraBody 不覆盖请求体里已有的字段，所以客户端自带的 `user_id` 依旧优先；用户自己写过的 `extraBody.metadata` 插件不认领、不覆盖，只在日志提示一次；`appliedMeta` 记账，切到别的档案或 `injectMetadata: false` 时精确撤回自己写过的那一份。
- **已知边界（其中第一条相对 1.7.0 是真实损失）**：
  - **由 auth 插件承载的 provider 不被覆盖**：magpie 只在 provider 由 `providers.json` 构造且没有登录账号时读取 `extraBody`（`extrabody.go:77-85`），插件承载的 provider 带着 `Account`（`plugins.go:440`），字段被忽略；而且这类条目没有端点字段，插件也写不进去。旧钩子按客户端协议与模型名前缀判断，**能**覆盖它们。若您的 Claude Code 专用中转站是通过 auth 插件添加的，1.8.0 会换头但不带 `user_id`。
  - `baseAPI` 为 Gemini 的 provider 不写（`generateContent` 拒绝它没有对应字段的顶层名）。
  - 字段只写给会走 Messages 线路的 provider（`baseAPI=anthropic`、`baseURL` 含 anthropic，或配了 `anthropic` 端点）；混线 provider 也会写，此时它另一条线路同样带上 `metadata`，日志提示一次。
  - **登录账号本身不构成回退**：源码复核过，Claude 订阅路径（`internal/gateway/claude_subscription.go`）把请求转成 `stream-json` 喂本机 `claude -p`，全程不读 `metadata`，旧钩子注入的值在那条路径上本来就被丢弃，且该文件内既无 `WithExtraBody` 也无 `forwardOnce` 调用。
- **已实测通过严格中转站**：对一个不带该字段就回 `403 claude_code_required`（错误消息明写「本次请求缺少：metadata.user_id」）的站点，经 magpie 真实服务路径（`forwardOnce` → `WithExtraBody`）在档案应用后返回 `200`；负对照——`injectMetadata: false`、请求头不变——站点重新索要 `metadata.user_id`。验证时**模型名必须带 `providerID/modelID` 前缀**：裸模型名会被路由到 magpie 挑的任意一家，实测中曾因此把别家返回的 200 误读成目标站通过。
- **诊断随迁**：`diagnose` 从 `ua-switcher.json` 移到插件 options（`magpie plugin options ua-switcher '{"diagnose":true}'`），结果写进 magpie 日志而不是 `ua-switcher-tools.json`，同一形状只记一次，单行最多列 6 个工具名。旧键不会静默失效：配置里仍留着 `"diagnose": true` 时，插件在加载与 `/state` 时各提示一次（去重，不刷屏）指引到新开关。
- **作用面变化（相对旧钩子，升级前请读）**：
  - **变宽**：旧钩子看的是**客户端协议**（只有 Claude Code 这类 anthropic 客户端会补 user_id），新机制看的是**provider 能否走 Messages**。于是 Codex 等 responses 客户端经 magpie 翻译后打到 Anthropic 中转站的请求，现在也会带上 `metadata.user_id`。
  - **变严**：路由组不再绕过排除列表。旧钩子对 `group/zcode` 这类模型名解析不出 provider，因此不受 `excludeProviders` 约束；新机制由实际落地的 provider 决定，被排除就没有。
  - **session 语义**：旧钩子在进程内每 4 小时换一次 session 段；新机制在切档案/重载插件时定格，直到下次 apply。对做会话亲和与 prompt cache 的中转站而言这更稳，但不再自动轮换。
- **顺带修掉一个既有缺陷**：`wireOf(p)` 原先先看「有没有 `responses` URL」，会遮蔽用户显式声明的 `baseAPI: "anthropic"`——magpie 的编辑器把 `chat`/`responses`/`anthropic`/`gemini` 与 `baseAPI` 分开保存（`internal/gui/providers.go:80`、`:91`），所以一个 Anthropic 中转站完全可能带着 responses URL。此前它会被判成 openai 线路，丢掉 `anthropic-version` / `anthropic-beta` / `X-Stainless-*` 而换上 responses 头。复审时指出更宽的重排会连带改变 `baseAPI` 缺省、`baseAPI: "chat"` 那批 provider 的头分组，因此最终版**只把显式 `baseAPI === "anthropic"` 提到最前**，其余分支与 1.7.0 逐字节等价（已加断言覆盖 `baseAPI: "chat"` + responses、缺省 + responses 两种旧行为）。「能否走 Messages」交给独立的 `messagesWire(p)` 判：比头的判据宽（有 `anthropic` 端点即算），并排除 `baseAPI: "gemini"`。
- **extraBody 归属改为「本机 base id 认领」**：不再只信 `appliedMeta` 账本，也不只看形状。写入与撤回都以「该 `user_id` 是否带本机 `ua-switcher-userid.json` 里的 base 前缀」为准，账本仅在 base 读不到时兜底。于是：①用户在 magpie GUI 里改过的值不会被删；②从别的机器 `~/.claude.json` 抄来的真实 id 即使形状完全合法也不被认领、不被覆盖、切 `off` 也不删；③账本（`ua-switcher.json`）被重置而值仍是本机写的，切 `off` 仍能清干净，不留孤儿。`native_endpoints` 那条判据未采纳——providers.json 里没有这个字段，magpie 是按模型现算的（`internal/provider/native_endpoints.go:11`）。
- **magpie 版本下限**：`internal/provider/extrabody.go` 在 v0.1.1190 尚不存在、v0.1.1191 首次出现（commit `863af7a`，2026-10-11，#1604）。低于 v0.1.1191 的 magpie 会忽略 `extraBody`，即**不报错也不注入**。运行期采取「只在有实证时提示」：读 magpie 桌面版写的 `last-version`（`internal/gui/whatsnew.go:127`），确认过旧才 warn 一次；无头 `magpie web` 没有这个文件，此时不猜测、不告警，仅由 README 声明下限。`/state.metadata` 新增 `minMagpieVersion` 与 `magpieVersion`（读不到为 null）。
- **升级**：`magpie plugin update`（或重新 `magpie plugin add`）即可——两者结尾都会 `Restart()` 插件宿主（`internal/plugin/store.go`），旧钩子随之消失，**不必重启 magpie**（此句由 1.8.3 复核更正，原文写的是"升级后重启 magpie"）。`/state` 新增 `metadata: {via, profiles, wires, providers}`，可据此确认注入已生效；`ua-switcher-userid.json` 沿用旧文件，身份不变。
- **文件移除**：`hooks.mjs` 已从仓库删除（`package.json` 的 `magpie.hooks` 与 `files` 同步去掉）。它自 1.8.0 起不再被任何代码加载，保留只会让人误以为钩子路径还在；需要恢复可从 v1.7.0 的 tag 取回（sha256 `cd0fd493…93f41a2`，7849 字节）。selftest 增加两条守卫：`package.json` 不再声明钩子、磁盘上也不存在该文件。
- 测试：189 项断言（原 150），新增钩子缺席守卫、extraBody 写入/撤回/不覆盖/记账、`wireOf` 与 `messagesWire` 分离后的头分组零回归（`baseAPI: "chat"`、缺省、纯 Gemini、单 anthropic 端点四种形态）、base id 认领（外来真实 id 不覆盖不删除、账本丢失仍可回收）、版本下限提示等用例。
- **致谢**：本版的起因是 [@bearchild233](https://github.com/bearchild233) (Yu Xiaoxiang) 的 OOM 报告——内存受限的 Docker 容器里 `magpie-bun` 被内核 `CONSTRAINT_MEMCG` 连续强杀，附了内核日志与根因分析。他在 [PR #1](https://github.com/x1051445024/magpie-ua-switcher/pull/1) 里对配置目录、软链接与权限的处理本版继续沿用。

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
