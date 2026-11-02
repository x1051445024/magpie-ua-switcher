// ua-switcher's paths: the folder magpie keeps its own files in, as magpie
// decides it, and the plugin's files beside them.
//
// magpie's appdir.Config() is the data folder of a portable magpie, else
// $XDG_CONFIG_HOME/magpie when that is absolute, else ~/.config/magpie. Its
// official Docker image sets HOME=/config/home and XDG_CONFIG_HOME=/config,
// so there the folder is /config/magpie, not ~/.config/magpie. magpie hands
// that folder to a plugin as the input's `directory` (plugin host init); the
// gateway hook (hooks.mjs) is imported before the plugin function runs, so
// every path here is computed when it is used, not when it is imported.
//
// Not the package's main entry on purpose: magpie's plugin host calls every
// function main exports as a plugin function.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

let given = "" // the folder magpie handed in, once it has

// useMagpieDir takes the plugin input's directory as magpie's folder. Only an
// absolute folder that already holds one of magpie's files is taken: OpenCode
// passes a project folder there, and this plugin's selftest the home folder.
export function useMagpieDir(dir) {
  if (typeof dir !== "string" || !path.isAbsolute(dir)) return false
  if (!["providers.json", "settings.json", "logins.json"].some((f) => isFile(path.join(dir, f)))) return false
  given = dir
  return true
}

// magpieDir is the folder magpie keeps its own files in: the one magpie
// handed in, else appdir.Config()'s rule for an installed magpie. Node's
// path.isAbsolute on Windows also takes \x and /x (rooted on the current
// drive), as magpie's rooted() does.
export function magpieDir(env = process.env, home = os.homedir) {
  if (given) return given
  const x = env.XDG_CONFIG_HOME
  if (typeof x === "string" && path.isAbsolute(x)) return path.join(x, "magpie")
  return path.join(home(), ".config", "magpie")
}

export function configPath() {
  return process.env.UA_SWITCHER_CONFIG || path.join(magpieDir(), "ua-switcher.json")
}

export function providersPath() {
  return process.env.UA_SWITCHER_PROVIDERS || path.join(magpieDir(), "providers.json")
}

// a file beside the config: ua-switcher-versions.json, -userid.json, -tools.json
export function besideConfig(suffix) {
  return configPath().replace(/\.json$/, "") + suffix
}

// legacyDir is where 1.6.0 and before kept the plugin's files whatever
// folder magpie used: ~/.config/magpie.
export function legacyDir(home = os.homedir) {
  return path.join(home(), ".config", "magpie")
}

// adoptLegacy copies file's namesake from legacyDir when file isn't there
// yet, so a profile chosen before this fix (and the user_id relays have
// seen) survive the move. Returns the folder copied from, or "".
export function adoptLegacy(file, home = os.homedir) {
  const old = path.join(legacyDir(home), path.basename(file))
  if (path.resolve(old) === path.resolve(file) || fs.existsSync(file) || !isFile(old)) return ""
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.copyFileSync(old, file, fs.constants.COPYFILE_EXCL)
  return path.dirname(old)
}

// for tests: forget the folder magpie handed in
export function resetMagpieDir() {
  given = ""
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}
