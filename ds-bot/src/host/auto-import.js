// Auto-import of the user's own DSH sessions on the app's first start.
// The app points DS_BOT_AUTO_IMPORT at the user's DSH home when the app starts for the first
// time. This module then asks the import plugin (dsh-chat-import) to bring those sessions into
// the app's own home, and tells the app that it is done so the app can remove the DSH_HOME
// variable that points at the old home.
//
// The import plugin's service lives in this process (the Host), so the plugin reads it from the
// DSH context rather than the app calling across the process boundary. Nothing here may stop
// the start: a failure is logged and the app goes on.
import { join } from 'node:path'
import { HOST_SESSION_VERSION, loadFormatRunner } from './import-format.js'

// The formats the import plugin reads the user's DSH sessions in: the current log revision and
// the older ones. Both are scanned, so a home written by an earlier DSH is read as well.
const FORMATS = ['dsh', 'dsh4']

/**
 * The user's DSH home, as the app named it for this start.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | undefined} the home, when the app asked for an import
 */
export function requestedHome(env = process.env) {
  if (env.DS_BOT_AUTO_IMPORT !== '1') return undefined
  const home = env.DS_BOT_USER_DSH_HOME?.trim()
  return home ? home : undefined
}

/**
 * Scan the user's DSH home and import what it holds.
 *
 * The scan is asked for one format at a time: the plugin's default roots follow the DSH_HOME of
 * this process, which is the app's own home, not the user's. The path is therefore always given
 * explicitly, so the scan reads the user's home and nothing else.
 * @param {object} ctx - the DSH context
 * @param {object} [options]
 * @param {string} [options.home] - the user's DSH home
 * @param {(message: string) => void} [options.onProgress] - called with the progress of the import
 * @param {((ctx: unknown, version: number, fn: () => Promise<unknown>) => Promise<unknown>) | undefined} [options.runWithVersion]
 *   the plugin's helper that runs an import with a stated target format version
 * @returns {Promise<{ imported: number, failed: number, skipped: number, formats: string[] }>}
 */
export async function importUserSessions(ctx, { home = requestedHome(), service = ctx.get?.('chatImport'), onProgress, runWithVersion } = {}) {
  const result = { imported: 0, failed: 0, skipped: 0, formats: [] }
  if (!home) return result
  if (!service) return result
  const root = join(home, 'sessions')
  for (const format of FORMATS) {
    let scan
    try {
      scan = await service.scanDiscover({ format, path: root })
    } catch (error) {
      // One format that cannot be read must not stop the others.
      onProgress?.(`ds-bot: the ${format} sessions could not be scanned: ${error?.message ?? error}`)
      result.failed += 1
      continue
    }
    const sessions = Array.isArray(scan?.sessions) ? scan.sessions : []
    if (sessions.length === 0) continue
    result.formats.push(format)
    onProgress?.(`ds-bot: importing ${sessions.length} ${format} sessions…`)
    let summary
    try {
      const run = () => service.importAll({ format, path: root })
      // The import states the host's session format version, so a session that carries a tool
      // message is written the way the host reads it (see src/host/import-format.js).
      summary = runWithVersion === undefined
        ? await run()
        : await runWithVersion(ctx, HOST_SESSION_VERSION, run)
    } catch (error) {
      onProgress?.(`ds-bot: the ${format} sessions could not be imported: ${error?.message ?? error}`)
      result.failed += sessions.length
      continue
    }
    result.imported += Number(summary?.imported ?? 0)
    result.skipped += Number(summary?.skipped ?? 0)
    result.failed += Number(summary?.failed ?? 0)
    // The plugin reports why a session failed in the result of that session; without this the
    // log says only how many failed, and the reason is nowhere to be found.
    for (const failure of failuresOf(summary)) {
      onProgress?.(`ds-bot: a ${format} session could not be imported: ${failure}`)
    }
  }
  return result
}

/** The reasons the plugin gave for the sessions it could not import. */
function failuresOf(summary) {
  const reasons = []
  for (const error of summary?.errors ?? []) {
    if (typeof error?.error === 'string') reasons.push(error.error)
    else if (error?.error !== undefined) reasons.push(JSON.stringify(error.error))
  }
  for (const item of summary?.results ?? []) {
    if (item?.status !== 'failed') continue
    if (typeof item?.error === 'string') reasons.push(item.error)
    else if (item?.error !== undefined) reasons.push(JSON.stringify(item.error))
  }
  return reasons
}

export function install(rt) {
  const { ctx } = rt

  // The import plugin's service may not be applied yet when this module is installed, so it is
  // taken with an injection: the callback runs when the service is there. A DSH without the
  // plugin never calls back, and nothing is imported.
  let service
  const attach = (sub) => {
    const own = sub.chatImport
    service = own
    sub.effect(() => () => { if (service === own) service = undefined }, 'ds-bot: chat import service')
  }
  if (typeof ctx.inject === 'function') ctx.inject(['chatImport'], attach)
  else if (ctx.get?.('chatImport') !== undefined) attach({ chatImport: ctx.get('chatImport'), effect: (execute, label) => ctx.effect(execute, label) })

  /**
   * Run the import, when the app asked for it, and report the outcome to the app. The app
   * removes the DSH_HOME variable after this message, so a failure keeps the variable and the
   * user can try again.
   */
  async function runAutoImport() {
    const home = requestedHome()
    if (!home) return undefined
    // The plugin's helper for stating the target format version is looked up in the profile the
    // plugin was installed into. A plugin that moved it is not fatal: the import runs without a
    // stated version and fails as it did before.
    const profileDir = ctx.get?.('profileContext')?.dir
    const runWithVersion = profileDir === undefined ? undefined : await loadFormatRunner(profileDir)
    if (runWithVersion === undefined) {
      rt.warn('ds-bot: the import plugin does not offer its format-version helper; the import runs without a stated version')
    }
    const result = await importUserSessions(ctx, { home, service, runWithVersion, onProgress: message => rt.warn('%s', message) })
    // The line the installer check reads: it says what was imported and from where.
    console.log(`LinkBot: imported ${result.imported} sessions from ${home} (${result.formats.join(', ') || 'no sessions'})`)
    // The app listens for this message; a Host without an app (the plugin runs on its own)
    // has no channel, and the import is still done.
    if (typeof process.send === 'function') {
      process.send({ type: 'ds-bot:auto-import-done', result }, () => {})
    }
    return result
  }

  // The import runs off the start path: a large home takes a while, and the window must open.
  Object.assign(rt, { runAutoImport })
  setImmediate(() => { void runAutoImport().catch(() => {}) })
}
