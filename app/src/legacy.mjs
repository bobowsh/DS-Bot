// Compatibility identifiers are kept here so released installs can upgrade in place.
import { existsSync, mkdirSync } from 'node:fs'
import { join, basename } from 'node:path'

// The product name of this build. The name the interface shows the user — windows,
// dialogs, copy — and the internal one that decides the userData folder are the same
// value, so a rename never leaves the two disagreeing. LEGACY_USER_DATA_NAMES below
// keeps the earlier folder in use so no existing install lands in a fresh empty
// directory.
export const PRODUCT_NAME = 'LinkHarness'
export const DISPLAY_NAME = 'LinkHarness'
// The app id of this build: it names the Windows uninstall entry and the single-instance
// lock, so it is the one electron-builder.yml carries. It is a technical identifier, not a
// name the user sees, so it keeps the shape it had before the product was renamed.
export const APP_ID = 'io.github.fei2411.deepseekbot'
export const LEGACY_PRODUCT_NAME = 'DeepSeek Bot'
// 产品改名后内部 product name 也跟着变了，userData 目录随之从 LinkBot 换成 LinkHarness。
// 这份列表让它按从新到旧的顺序找回已有安装的数据目录，改名不会把用户的设置和 locations
// 丢在一个新空目录里。清单里第一个存在的目录会被复用。
export const LEGACY_USER_DATA_NAMES = ['LinkBot', 'DeepSeek Bot']
export const LEGACY_ENGINE = 'deepseek-bot-engine'
export const LEGACY_ARTIFACT_PREFIX = 'DeepSeek-Bot'

/** Keep the shell data and Chromium encryption identity of an existing installation. */
export function configureIdentity(app, { env = process.env, platform = process.platform, exists = existsSync, mkdir = mkdirSync } = {}) {
  const current = app.getPath('userData')
  const explicit = env.DS_BOT_SHELL_DATA
  // An explicitly isolated run must never discover an installed application.
  // 按 LEGACY_USER_DATA_NAMES 从新到旧找第一个存在的旧目录；current 自己不算。
  const appData = app.getPath('appData')
  const legacy = explicit || env.DS_BOT_HOME ? undefined
    : LEGACY_USER_DATA_NAMES.map(name => join(appData, name)).find(dir => dir !== current && exists(dir))
  const reuse = legacy !== undefined && !exists(join(current, 'locations.json'))
  const userData = explicit || (reuse ? legacy : current)
  mkdir(userData, { recursive: true })
  app.setPath('userData', userData)
  app.setPath('sessionData', userData)
  if (platform === 'win32') app.setAppUserModelId(APP_ID)
  // Electron 44 captures this name for OSCrypt before ready. Restore the visible name
  // before creating menus or windows; the captured keychain identity stays unchanged.
  if (reuse && platform !== 'win32') {
    app.setName(basename(userData))
    app.once('ready', () => { app.setName(DISPLAY_NAME) })
  }
  return { userData, legacy: reuse }
}
