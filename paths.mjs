// paths.mjs - Resolve magpie's active config folder across native, XDG,
// Docker (HOME=/config/home, XDG_CONFIG_HOME=/config), and portable installs.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const MAGPIE_MARKERS = ["providers.json", "settings.json", "logins.json"]
const LEGACY_ALLOWLIST = new Set([
  "ua-switcher.json",
  "ua-switcher-versions.json",
  "ua-switcher-userid.json",
])

let given = ""

function isFile(p) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function isSafeLegacyFile(p) {
  try {
    const st = fs.lstatSync(p)
    return st.isFile() && !st.isSymbolicLink() && st.size > 0 && st.size <= 1024 * 1024
  } catch {
    return false
  }
}

export function looksLikeMagpieDir(dir) {
  if (typeof dir !== "string" || !dir || !path.isAbsolute(dir)) return false
  return MAGPIE_MARKERS.some((name) => isFile(path.join(dir, name)))
}

export function useMagpieDir(dir) {
  if (!looksLikeMagpieDir(dir)) return false
  given = dir
  process.env.UA_SWITCHER_MAGPIE_DIR = dir
  return true
}

export function resetMagpieDir() {
  given = ""
  delete process.env.UA_SWITCHER_MAGPIE_DIR
}

export function magpieDir(env = process.env, home = os.homedir) {
  if (given) return given
  if (env === process.env && env.UA_SWITCHER_MAGPIE_DIR && path.isAbsolute(env.UA_SWITCHER_MAGPIE_DIR)) {
    return env.UA_SWITCHER_MAGPIE_DIR
  }
  const xdg = env?.XDG_CONFIG_HOME
  if (typeof xdg === "string" && xdg && path.isAbsolute(xdg)) {
    return path.join(xdg, "magpie")
  }
  const h = typeof home === "function" ? home() : home
  return path.join(h, ".config", "magpie")
}

export function configPath(env = process.env, home = os.homedir) {
  return env?.UA_SWITCHER_CONFIG || path.join(magpieDir(env, home), "ua-switcher.json")
}

export function providersPath(env = process.env, home = os.homedir) {
  return env?.UA_SWITCHER_PROVIDERS || path.join(magpieDir(env, home), "providers.json")
}

export function besideConfig(suffix, env = process.env, home = os.homedir) {
  return configPath(env, home).replace(/\.json$/, "") + suffix
}

export function versionsPath(env = process.env, home = os.homedir) {
  return besideConfig("-versions.json", env, home)
}

export function useridPath(env = process.env, home = os.homedir) {
  return besideConfig("-userid.json", env, home)
}

export function toolsLogPath(env = process.env, home = os.homedir) {
  return besideConfig("-tools.json", env, home)
}

export function zcodeMidPath(env = process.env, home = os.homedir) {
  return path.join(magpieDir(env, home), "zcode-device-mid")
}

function legacyDir(home = os.homedir) {
  const h = typeof home === "function" ? home() : home
  return path.join(h, ".config", "magpie")
}

// Copy a whitelisted config file from ~/.config/magpie to the active magpieDir
// if the active dir does not have it yet. Never overwrites existing files.
export function adoptLegacy(file, home = os.homedir) {
  try {
    if (typeof file !== "string" || !file) return ""
    const base = path.basename(file)
    if (!LEGACY_ALLOWLIST.has(base)) return ""
    const old = path.join(legacyDir(home), base)
    if (path.resolve(old) === path.resolve(file)) return ""
    if (isFile(file) || !isSafeLegacyFile(old)) return ""
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.copyFileSync(old, file, fs.constants.COPYFILE_EXCL)
    try {
      fs.chmodSync(file, 0o600)
    } catch {}
    return path.dirname(old)
  } catch {
    return ""
  }
}
