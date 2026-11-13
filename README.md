# magpie-ua-switcher

Switch the **User-Agent (and companion identity headers) that [magpie](https://github.com/yetone/magpie) sends upstream**: present yourself as Codex CLI, Claude Code, pi, ZCode, or your own custom client — one click, effective immediately, no magpie restart.

中文文档见 [README.zh-CN.md](README.zh-CN.md)。

## Why two mechanisms

magpie has two upstream paths, and this plugin covers both:

1. **Native providers** (API-key entries in `providers.json`, e.g. relay stations — fetched by magpie's Go side): on every switch the plugin writes the resolved headers into each provider's `headers` field. After an actual file change, it sends the Magpie host's existing cache invalidation event through the host protocol, without modifying sign-ins or restarting the host. The switch response waits for the notification to flush. This also applies to `off`; unchanged headers send no notification. When running outside the recognized Magpie host, it falls back to updating the `plugins.json` timestamp without changing its contents. Model-specific headers and client headers explicitly selected by `passHeaders` can take precedence. Header names are matched case-insensitively. Switching to `off` restores overwritten values while the current value still matches what the plugin wrote; later manual edits are preserved. Older key-only bookkeeping cannot recover values overwritten before this repair.
2. **Plugin-host providers** (declared by plugins such as `opencode-zcode-auth`): rewritten per request through the `chat.headers` hook, which wins over every other header source.

A third field completes the picture: while the effective profile is `claude-code` (or pi's anthropic form), the plugin writes Claude Code's `metadata.user_id` into each **Messages-wire provider's `extraBody`** in `providers.json`, and magpie merges it into the body itself as the request goes out. Since 1.8.8, its encoding follows the effective User-Agent: `claude-cli/2.1.78` and newer use a JSON string containing `device_id`, `account_uuid`, and `session_id`; older versions keep the legacy `user_..._account_..._session_...` string. Version pins and per-provider overrides keep the same identity components when switching formats. The device/account base is persisted beside the config; the session UUID rotates on host restart or after a four-hour window. Client-sent metadata and manually configured identities are preserved. Turn injection off in the web UI's Provider settings (`injectMetadata`).

### Claude Code billing block (1.9.0)

For relays returning `official Anthropic accounts require a Claude Code billing block`, select **Claude Code** in the Web UI's global profile matrix and enable **Claude billing 兼容（本地转发）** (Claude billing compatibility, local forwarding). Keep metadata injection enabled. The new option is off by default (`claudeBilling: false`). It follows the existing global profile, provider overrides and exclusions; eligible native Anthropic endpoints are covered together, including the Messages endpoint of mixed providers. Header switching for other profiles keeps its existing behavior.

This option forwards the final Anthropic wire through the same loopback listener as the Web UI. It covers external `/v1/messages` clients (including Pi), translated Chat requests and Magpie's native model-test button. It prepends an independent attribution block using the final outgoing Claude UA version. Caller system blocks, cache controls and an existing genuine billing block are retained. Count-token and model-list requests pass through without billing injection. It does not invent auxiliary request classifications or require a genuine Claude Code process/environment flag.

Set the provider proxy, or the inherited Magpie global proxy, explicitly to **direct**. Custom proxies, inherited system proxies, account proxies, custom TLS and forced HTTP/1 are currently unsupported; the UI shows the reason and leaves their upstream URLs intact. The listener must remain enabled while forwarding is on. Turn billing off before disabling/removing the plugin to restore its owned original URLs; later manual edits are preserved. The feature adds a loopback hop and body parsing with a 64 MiB request limit. Local 1 MiB measurements varied: some runs added about 4–15 ms, while others fell below the baseline. These are not production latency guarantees.

Strict relays may impose further prompt, session or request requirements. For [issue #3](https://github.com/x1051445024/magpie-ua-switcher/issues/3), isolated real Magpie/Pi tests now cover the reported billing requirement; confirmation against the reporter's relay is still pending.

Until 1.8.0 this same field came from a **gateway hook** (`hooks.mjs`, declared through `package.json`'s `magpie.hooks`). That hook is gone, and installing an older version on a small box is what fills memory: declaring one makes magpie copy *every* agent request body — the whole history, the system prompt, the tool schemas — across an RPC into its Bun plugin host, deep-clone it there, and re-serialize it for the tamper checks, on every request, including the ones the hook then left alone. See [CHANGELOG](CHANGELOG.md) 1.8.0.

The cheaper path has three boundaries, and one of them is a real loss against 1.7.0:

- **A provider an auth plugin serves is not covered.** magpie reads `extraBody` only for a provider it builds from `providers.json` with no sign-in account (and for a ChatGPT account); a provider served by `opencode-*-auth` carries an account, so magpie drops the field — and the plugin cannot write it either, since such an entry has no endpoint URLs of its own. The old hook covered these, because it keyed on the client's protocol and model name instead of on the provider entry. If your Claude-Code-only relay is added through an auth plugin, 1.8.0 will send it the headers but not the `user_id`.
- **Providers whose base API is Gemini are left alone**, since `generateContent` refuses a top-level name it has no field for.
- **A mixed provider gets the field on every wire.** Its Claude models go to the anthropic endpoint untranslated, and magpie's `extraBody` is flat, so that provider's Chat/Responses requests carry `metadata` too. The plugin says so once in its log. A provider with no Messages path at all is never touched.

Verified end to end against a relay that answers `403 claude_code_required` for a request without the field: through magpie with the profile applied, the same request returns `200`; with `injectMetadata: false` — headers unchanged — the relay asks for `metadata.user_id` again. To check your own setup: `curl http://127.0.0.1:3426/state` and read `metadata.providers` (which providers the plugin actually wrote), then confirm in magpie's Routing that the request went out on that provider rather than another one — a bare model name routes wherever magpie chooses, so name the provider in the model to test it specifically.

Protocol-aware: the plugin detects the wire protocol (anthropic / openai-responses) per request and only attaches protocol-appropriate companion headers (`anthropic-beta`, `X-Stainless-*` for anthropic; `OpenAI-Beta: responses=experimental`, `originator` for responses).

## Install

From a git checkout (no npm needed):

```bash
magpie plugin add github:YOUR_GITHUB_HANDLE/magpie-ua-switcher
```

Or from a local folder:

```bash
magpie plugin add ./magpie-ua-switcher
```

`plugin add` tells the running magpie to reload its plugin host — no app restart needed. Port handling is self-healing: on a conflict the plugin defers to another healthy instance of itself if one answers, keeps retrying for 30 seconds, and the request hook re-attempts the bind once a minute for as long as no instance holds the port.

**Development**: this folder is the git repo itself. Edit, commit, push, then run `magpie plugin update` to pull the new version into magpie's managed install. There is no per-plugin form: the spec argument is ignored and every plugin is updated (`internal/cli/plugins_cli.go`, `case "update", "upgrade":` → `plugin.Update(ctx)`). That command ends by restarting the plugin host (`internal/plugin/store.go`: `Update` → `Restart()`), so magpie itself needs no restart.

## Switch profiles

**Web page** — <http://127.0.0.1:3426> switches profiles by clicking a card, and edits everything else inline (saved hot, into the same config file):

- **Version pins**: one input per client version — leave empty to follow the auto-update, type a version to pin it
- **Exclusions**: add/remove providers that are never rewritten
- **Per-provider overrides**: a dropdown per provider (follow global / off / any profile)
- **Custom profiles**: create / edit / delete (UA plus any / anthropic / openai header groups, one `key: value` per line); dual-form (`forms`) profiles stay read-only on the page to protect their shape — edit those in the config file
- **Page font size**: slider or numeric input (12–24px) to pin a size, reset returns to the window-adaptive default; kept in the browser's localStorage, not the config file
- **When an edit takes effect**: the profile cards, the exclusions and the per-provider dropdowns commit the moment you touch them. Version pins and custom profiles still commit through their button, but what you typed is held as a draft — tagged 「有未保存草稿」 next to the section title, kept across the page's 3-second refresh, warned about if you close the tab with it unsaved.

**curl**:

```bash
curl http://127.0.0.1:3426/set/codex        # Codex CLI
curl http://127.0.0.1:3426/set/claude-code  # Claude Code
curl http://127.0.0.1:3426/set/pi           # pi (dual identity, auto by protocol)
curl http://127.0.0.1:3426/set/zcode        # ZCode client
curl http://127.0.0.1:3426/set/opencode     # opencode (Bun runtime UA + session headers)
curl http://127.0.0.1:3426/set/antigravity  # Antigravity Hub
curl http://127.0.0.1:3426/set/off          # off — magpie's default UA
curl http://127.0.0.1:3426/state            # current state
curl -X POST http://127.0.0.1:3426/config -H "content-type: application/json" \
  -d '{"excludeProviders":["zcode"],"versions":{"codex":"0.170.0"}}'  # scripted edits
```

**Config file**: edit `~/.config/magpie/ua-switcher.json` (`/config/magpie/ua-switcher.json` in magpie's Docker image; see [Where the files are](#where-the-files-are)); the next request through the gateway picks it up.

## Built-in profiles

The OS segment of codex/pi/antigravity UAs is generated from the machine the plugin runs on, matching what the real clients do. Versions resolve in layers: **built-in defaults < the local Antigravity install (antigravity only) < values fetched from npm < a hand pin in the config's `versions` field**. `antigravity` is probed from the local install's `app.asar` root `package.json` (the same value the running language server gets as `--override_ide_version`); `bun` (opencode's runtime UA) and `antigravity` are never fetched from npm — the Bun version exists only inside opencode's compiled binary, and Antigravity ships no npm package. The npm layer refreshes itself in the background (on plugin load, then at most every `updateEveryHours`) for the clients whose npm package *is* their version — codex (`@openai/codex`) and claude-code (`@anthropic-ai/claude-code`) — trying npmjs.org first with npmmirror.com as fallback (plus your `registry`, if set). On change the UAs in `providers.json` are rewritten immediately. aiSdk, pi and zcode are never auto-fetched: aiSdk is a dependency ZCode bundles internally (npm's latest would assemble a UA the real client never sent), and pi/zcode ship no package to read — bump the built-in or pin one: `"versions": {"zcode": "3.99.0"}`. The web page has a "check for updates" button; `curl -X POST http://127.0.0.1:3426/versions/refresh` forces a fetch and `curl http://127.0.0.1:3426/versions` shows each version and where it came from (builtin / fetched / pinned). A whole profile can also be overridden per machine through the config's `profiles` field.

| id | User-Agent | companion headers |
|---|---|---|
| `codex` | `codex_cli_rs/0.164.0 (Windows 10.0.19045; x86_64) WindowsTerminal` | `originator: codex_cli_rs`, session fingerprint `x-codex-window-id` and `session-id` (UUID, satisfies Sub2API `codex_cli_only` engine fingerprint gate); on the responses wire also `OpenAI-Beta: responses=experimental` |
| `claude-code` | `claude-cli/2.1.310 (external, cli)` | `X-App: cli`; on anthropic also `anthropic-version`, `anthropic-beta: claude-code-20250219,…`, full `X-Stainless-*` set |
| `pi` | anthropic endpoints: `claude-cli/2.1.75`; responses endpoints: `pi (win32 10.0.19045; x64)` | exactly what the real pi client sends, picked per protocol |
| `zcode` | `ZCode/3.16.3 ai-sdk/anthropic/3.0.81` | `HTTP-Referer`, `X-ZCode-*`, `X-Device-Mid` (read from the local device id when present) |
| `opencode` | `Bun/1.4.4` (the real client sends no custom UA — the Bun runtime default rides along) | `HTTP-Referer: https://opencode.ai/`, `X-Title`/`X-Source: opencode`, session trio `x-opencode-session-id`/`X-Session-Id`/`x-session-affinity` (`ses_<64hex>`, persisted across host reloads) |
| `antigravity` | `antigravity/hub/2.26.0 (aidev_client; os_type=windows; arch=amd64)` | none (the real Hub sends only its UA); `; cl=…` only for known builds |
| `off` | no rewrite | magpie's default behavior |

## Configuration `~/.config/magpie/ua-switcher.json`

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

- `profile` — the global profile (what the web page and curl change).
- `excludeProviders` — providers never rewritten. `zcode` is excluded by default: Z.ai requires the ZCode client identity (its free Start Plan answers 405 otherwise).
- `providerOverrides` — per-provider overrides, e.g. `{"newapi": "codex"}`.
- `port` — web switcher port (reload the plugin after changing).
- `log` — `change` (default, one line when the effective profile changes) | `always` | `off`.
- `selfcheck` — self-test mode, see below.
- `autoVersions` / `updateEveryHours` / `registry` — the npm auto-update: on/off, fetch interval in hours, an extra registry tried first.
- `versions` — hand pins, e.g. `{"codex": "0.170.0"}`; always beats a fetched value.
- `injectMetadata` — default true. Write Claude Code's `metadata.user_id` as `extraBody` on the Messages providers of a Claude Code profile; off removes what the plugin wrote and touches nothing else.
- `claudeBilling` — default false. Enable final-wire loopback forwarding for supported native Claude Messages providers; the Web UI shows affected providers and unsupported network settings.
- `profiles` — custom profiles, merged over the built-ins. Single form: `{ "label", "ua", "headers": { "any": {}, "anthropic": {}, "openai": {} } }`; per-protocol forms: `forms: { anthropic, openai, default }`.
- `applied` / `appliedHeaders` / `appliedMeta` / `appliedBilling` — internal bookkeeping of original/written headers, metadata and forwarding URLs in `providers.json`; don't edit by hand or restore an older ledger while keeping newer provider configuration.
- `sessionIds` — internal Codex and opencode session identifiers, persisted so host reloads do not regenerate headers and trigger repeated reloads.

### Where the files are

The plugin reads `providers.json` and keeps `ua-switcher.json` (and its `-versions` / `-userid` siblings) in magpie's own folder, the one magpie itself uses: the folder magpie hands the plugin (portable magpie included), else `$XDG_CONFIG_HOME/magpie` when that is an absolute path, else `~/.config/magpie`. In magpie's Docker image that is `/config/magpie` (the image sets `XDG_CONFIG_HOME=/config`, `HOME=/config/home`). Files an older version left in `~/.config/magpie` are copied over once. The web page and `/state` (`providersPath`, `providersError`) show which `providers.json` is read and why it couldn't be.

To point elsewhere, set these in magpie's environment (`docker run -e …` for the container):

- `UA_SWITCHER_PROVIDERS` — the `providers.json` to read and rewrite.
- `UA_SWITCHER_CONFIG` — the plugin's own `ua-switcher.json`.

## Self-check

Prove end-to-end that rewritten headers reach the upstream:

```bash
# 1. set "selfcheck": true in the config and reload:
magpie plugin add /path/to/magpie-ua-switcher
#    (magpie gains a ua-echo provider pointing at a local echo server)
# 2. start the echo server with magpie's bundled Bun:
magpie-bun.exe /path/to/magpie-ua-switcher/echoserver.mjs
# 3. switch to any profile and send a test request through the gateway:
curl -X POST http://127.0.0.1:3425/v1/messages -H "Authorization: Bearer magpie" \
  -H "Content-Type: application/json" \
  -d '{"model":"ua-echo/test","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'
#    (a 502 "unexpected reply" is expected — the body format is deliberately
#     mismatched; what matters is that the request reached the echo server)
# 4. read the recorded request headers:
cat /path/to/magpie-ua-switcher/ua-echo-last.json
# 5. set "selfcheck" back to false and reload
```

Unit tests: `magpie-bun.exe selftest.mjs` (330 assertions: every profile × protocol, exclusions, overrides, version pins, the asar version reader, /config validation, native cache notifications and concurrent switches, RPC framing under backpressure, header restoration and key-only ledger upgrades, stable session IDs across host reloads, providers.json writes, legacy/JSON Claude identity encoding and ownership, extraBody injection, and the guard against gateway hooks).

## Known limits

- The `chat.headers` hook can add and override headers but not remove them (the native-provider path has no such limit).
- The zcode provider's Start Plan (`-Trial`/gift) models rebuild their headers entirely; the switcher cannot (and should not) change their identity.
- `opencode`: the real client only sends `X-Title`/`HTTP-Referer`/`X-Source` on a few official providers; custom baseURLs get just the session headers. Sending all of them is deliberate, so relays can recognize the profile.
- `antigravity`: `cl=` appears only for known build changelists (2.23.0 / 2.23.1 / 2.24.0); unknown versions omit it rather than claim another build's CL.
- Only magpie → upstream headers change; what your agent sends to magpie is untouched.
- The web page binds `127.0.0.1` only.
- If you edit a provider in magpie's UI, what the UI saves wins until the plugin's next switch rewrites its keys.
- Since 1.8.0 a provider that declares `baseAPI: "anthropic"` keeps the anthropic headers even when a `responses` URL is saved beside it — that one case is all that changed, and every other provider's header groups are chosen exactly as before. The `metadata.user_id` asks a wider question than the headers do: a provider with an anthropic endpoint gets it even while its headers follow another group.
- An `extraBody.metadata` you wrote or edited by hand is never overwritten or deleted: the plugin only claims the field while it carries the base id this install persists, so an id copied in from another machine's Claude Code is left alone even if the plugin's own ledger still names the provider.
- The user_id needs **magpie v0.1.1191 or newer**: that is the first release that reads a provider's `extraBody` (commit `863af7a`, #1604). Below it the field is written and silently ignored. Where magpie records the version it last ran (`last-version`, written by the desktop app), the plugin warns in its log; on a headless `magpie web` there is no such file, so it says nothing and this line in the README is the only notice you get.

## License

MIT — see [LICENSE](LICENSE).

## Tool-schema diagnostics (optional)

Since 1.8.0 the diagnostics ride the middleware. They used to be in the gateway hook, which wrote them to `ua-switcher-tools.json` beside the config; that hook is what made magpie copy every request body into the Bun host, so it is gone. Turn them on through the plugin's options — not `ua-switcher.json`, because moejs cannot read files:

```bash
magpie plugin options ua-switcher '{"diagnose":true}'
```

or the **Options** button of this plugin in magpie's Plugins › Installed. Each request that carries tools then names, in magpie's log, the tools Anthropic would reject (a top-level `oneOf`/`allOf`/`anyOf`, or no top-level `type`), once per shape. Read-only: the request is never modified. Turn it off with `magpie plugin options ua-switcher off`.

Anthropic's Messages API refuses a tool whose `input_schema` has a union at the top level; an MCP tool that expresses mutual exclusion with zod's `.refine()` lands exactly there, so only a real Anthropic endpoint reports `input_schema does not support oneOf, allOf, or anyOf at the top level` while a GLM-style upstream takes it. The diagnostics name the tool.

## Tool-schema compatibility (gateway middleware)

`schema.middleware.mjs` is loaded by magpie's own process (moejs, not the plugin host) through `package.json`'s `magpie.middleware`. On anthropic requests it cleans the **top level** of every tool's `input_schema`:

- drops top-level `oneOf` / `allOf` / `anyOf` (a real Anthropic endpoint rejects them; GLM-style upstreams tolerate them, which is why this only surfaced on the Claude line)
- adds `type: "object"` / `properties: {}` when missing
- removes `required` names that have no matching property

Nested unions are legal and left alone; requests that need nothing pass through byte-identical. A schema that was nothing but a union gets its branches' `properties` merged.

**Turning it off** — the moejs sandbox cannot read config files, so there is no web toggle:

```bash
magpie plugin options github:x1051445024/magpie-ua-switcher '{"disable":true}'
```

Then `plugin off` / `plugin on` (or restart magpie) so the loaded middleware picks it up.

## Acknowledgements & Contributors

Special thanks to our community contributors for their great work:
- [@bearchild233](https://github.com/bearchild233) (Yu Xiaoxiang): Submitted [PR #1](https://github.com/x1051445024/magpie-ua-switcher/pull/1), identifying and fixing config directory resolution across Docker, XDG, and portable environments, symlink & file permission preservation, and port watchdog self-healing.
- [@bearchild233](https://github.com/bearchild233) again: reported `magpie-bun` being OOM-killed in a memory-limited Docker container, with kernel logs and a root-cause walkthrough. 1.8.0 — dropping the gateway hook and moving `metadata.user_id` onto magpie's own `extraBody` — is built on that report.

