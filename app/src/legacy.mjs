// Compatibility identifiers are kept here so released installs can upgrade in place.
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// The name the app carries now. It names the folder a fresh install uses for its shell data.
export const PRODUCT_NAME = 'LinkBot'
// The names the app had before: the first is older than the second. An install that ran
// under either keeps its shell data and Chromium encryption identity, because configureIdentity
// finds the newest folder that exists. It names the folders an earlier install
// left behind, so those are still found.
export const PAST_PRODUCT_NAMES = ['DeepSeek Bot', 'DS Bot']
// The app id of this build: it names the Windows uninstall entry and the single-instance
// lock, so it is the one electron-builder.yml carries. It is a technical identifier, not a
// name the user sees, so it keeps the shape it had before the product was renamed.
export const APP_ID = 'io.github.fei2411.deepseekbot'
export const LEGACY_PRODUCT_NAME = 'DeepSeek Bot'
export const LEGACY_ENGINE = 'deepseek-bot-engine'
export const LEGACY_ARTIFACT_PREFIX = 'DeepSeek-Bot'

/** Keep the shell data and Chromium encryption identity of an existing installation. */
export function configureIdentity(app, { env = process.env, platform = process.platform, exists = existsSync, mkdir = mkdirSync } = {}) {
  const current = app.getPath('userData')
  const explicit = env.DS_BOT_SHELL_DATA
  // An explicitly isolated run must never discover an installed application.
  // The newest past name that exists wins: an install upgraded through every rename keeps
  // the one folder it has been using, and a fresh install under the new name starts clean.
  const legacy = explicit || env.DS_BOT_HOME
    ? undefined
    : [...PAST_PRODUCT_NAMES].reverse().map(name => join(app.getPath('appData'), name)).find(dir => exists(dir))
  const reuse = legacy !== undefined && exists(legacy) && !exists(join(current, 'locations.json'))
  const userData = explicit || (reuse ? legacy : current)
  mkdir(userData, { recursive: true })
  app.setPath('userData', userData)
  app.setPath('sessionData', userData)
  if (platform === 'win32') app.setAppUserModelId(APP_ID)
  // Electron 44 captures this name for OSCrypt before ready. Restore the visible name
  // before creating menus or windows; the captured keychain identity stays unchanged.
  if (reuse && platform !== 'win32') {
    const previous = legacy && basenameLegacy(legacy)
    app.setName(previous ?? LEGACY_PRODUCT_NAME)
    app.once('ready', () => { app.setName(PRODUCT_NAME) })
  }
  return { userData, legacy: reuse }
}

/** The past product name a reused data folder was found under, or undefined. */
function basenameLegacy(dir) {
  return [...PAST_PRODUCT_NAMES].reverse().find(name => dir.endsWith(name))
}
