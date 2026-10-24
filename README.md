# magpie-ua-switcher

Switch the **User-Agent (and companion identity headers) that [magpie](https://github.com/yetone/magpie) sends upstream**: present yourself as Codex CLI, Claude Code, pi, ZCode, or your own custom client — one click, effective immediately, no magpie restart.

中文文档见 [README.zh-CN.md](README.zh-CN.md)。

## Why two mechanisms

magpie has two upstream paths, and this plugin covers both:

1. **Native providers** (API-key entries in `providers.json`, e.g. relay stations — fetched by magpie's Go side): on every switch the plugin writes the resolved headers into each provider's `headers` field, which magpie always honors and hot-reloads. Only keys the plugin itself wrote are ever touched (tracked in the config's `applied` field), so headers you set by hand survive; switching to `off` removes exactly those keys.
2. **Plugin-host providers** (declared by plugins such as `opencode-zcode-auth`): rewritten per request through the `chat.headers` hook, which wins over every other header source.

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

## Switch profiles

1. **Web page**: open <http://127.0.0.1:3426> and click a button; the active profile is highlighted.
2. **curl**:
   ```bash
   curl http://127.0.0.1:3426/set/codex        # Codex CLI
   curl http://127.0.0.1:3426/set/claude-code  # Claude Code
   curl http://127.0.0.1:3426/set/pi           # pi (dual identity, auto by protocol)
   curl http://127.0.0.1:3426/set/zcode        # ZCode client
   curl http://127.0.0.1:3426/set/off          # off — magpie's default UA
   curl http://127.0.0.1:3426/state            # current state
   ```
3. **Config file**: edit `profile` in `~/.config/magpie/ua-switcher.json`; the next request through the gateway picks it up.

## Built-in profiles

The OS segment of codex/pi UAs is generated from the machine the plugin runs on, matching what the real clients do. Versions live in one `VERSIONS` table at the top of `index.mjs`; any profile can also be overridden per machine through the config's `profiles` field.

| id | User-Agent | companion headers |
|---|---|---|
| `codex` | `codex_cli_rs/0.153.4 (Windows 10.0.19045; x86_64) WindowsTerminal` | `originator: codex_cli_rs`; on the responses wire also `OpenAI-Beta: responses=experimental` |
| `claude-code` | `claude-cli/2.1.280 (external, cli)` | `X-App: cli`; on anthropic also `anthropic-version`, `anthropic-beta: claude-code-20250219,…`, full `X-Stainless-*` set |
| `pi` | anthropic endpoints: `claude-cli/2.1.75`; responses endpoints: `pi (win32 10.0.19045; x64)` | exactly what the real pi client sends, picked per protocol |
| `zcode` | `ZCode/3.16.3 ai-sdk/anthropic/3.0.81` | `HTTP-Referer`, `X-ZCode-*`, `X-Device-Mid` (read from the local device id when present) |
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
  "profiles": {}
}
```

- `profile` — the global profile (what the web page and curl change).
- `excludeProviders` — providers never rewritten. `zcode` is excluded by default: Z.ai requires the ZCode client identity (its free Start Plan answers 405 otherwise).
- `providerOverrides` — per-provider overrides, e.g. `{"newapi": "codex"}`.
- `port` — web switcher port (reload the plugin after changing).
- `log` — `change` (default, one line when the effective profile changes) | `always` | `off`.
- `selfcheck` — self-test mode, see below.
- `profiles` — custom profiles, merged over the built-ins. Single form: `{ "label", "ua", "headers": { "any": {}, "anthropic": {}, "openai": {} } }`; per-protocol forms: `forms: { anthropic, openai, default }`.
- `applied` — internal bookkeeping of keys the plugin wrote into `providers.json`; don't edit by hand.

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

Unit tests: `magpie-bun.exe selftest.mjs` (43 assertions: every profile × protocol, exclusions, overrides, providers.json write and rollback).

## Known limits

- The `chat.headers` hook can add and override headers but not remove them (the native-provider path has no such limit).
- The zcode provider's Start Plan (`-Trial`/gift) models rebuild their headers entirely; the switcher cannot (and should not) change their identity.
- Only magpie → upstream headers change; what your agent sends to magpie is untouched.
- The web page binds `127.0.0.1` only.
- If you edit a provider in magpie's UI, what the UI saves wins until the plugin's next switch rewrites its keys.

## License

MIT — see [LICENSE](LICENSE).
