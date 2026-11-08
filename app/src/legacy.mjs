// Compatibility identifiers are kept here so released installs can upgrade in place.
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// The name the app had before it was renamed. It names the folders an earlier install
// left behind, so those are still found.
export const PRODUCT_NAME = 'DS Bot'
// The name the interface shows the user: windows, dialogs, copy. It stays a display
// constant on purpose — the internal product name decides the userData folder, and
// changing it would move every existing install's data to a fresh empty directory.
export const DISPLAY_NAME = 'LinkBot'
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
  const legacy = explicit || env.DS_BOT_HOME ? undefined : join(app.getPath('appData'), LEGACY_PRODUCT_NAME)
  const reuse = legacy !== undefined && exists(legacy) && !exists(join(current, 'locations.json'))
  const userData = explicit || (reuse ? legacy : current)
  mkdir(userData, { recursive: true })
  app.setPath('userData', userData)
  app.setPath('sessionData', userData)
  if (platform === 'win32') app.setAppUserModelId(APP_ID)
  // Electron 44 captures this name for OSCrypt before ready. Restore the visible name
  // before creating menus or windows; the captured keychain identity stays unchanged.
  if (reuse && platform !== 'win32') {
    app.setName(LEGACY_PRODUCT_NAME)
    app.once('ready', () => { app.setName(PRODUCT_NAME) })
  }
  return { userData, legacy: reuse }
}
