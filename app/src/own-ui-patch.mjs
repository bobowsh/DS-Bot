// Reconcile: the desktop app never shows DSH's own welcome, sign-in and API-key screens.
// They all live in the single UI row `ui-settings-account`, which DSH's web-app bundle mounts;
// the runtime rows (`deepseek-account`, `account-controller`) and the model rows stay, so the
// model path is untouched. The app aligns the row back to disabled on every start through a
// `--patch` overlay it writes next to the profiles (`<DSH_HOME>/profiles/own-ui.patch.yml`),
// which DSH reads only through `patchFiles`: the plugins page can still open the screens for
// the running session, and the next launch turns them off again. When a DSH update drops the
// row, nothing is written: a patch naming a row that is gone would only warn.
import { dirname, join } from 'node:path'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { stringify } from 'yaml'

export const OWN_UI_PATCH_NAME = 'own-ui.patch.yml'
const UI_ROW = 'ui-settings-account'

// The factory plugins that ship turned off. A plugin that needs a service the user has not
// authorized shows its own "reconnecting" state forever, so the factory keeps it out of the
// way until the user turns it on. The build marks them on the factory list (`disabled: true`),
// and that list is what the app reads: the build and the app cannot disagree.
const FACTORY_LIST = join('factory', 'plugins.json')

/**
 * The factory plugins that ship turned off, as the factory list says.
 * @param {string} [dataHome] - the data directory the factory list lives in
 * @returns {string[]} the package names that ship off
 */
export function factoryOffNames(dataHome = process.env.DSH_HOME ?? '') {
  if (dataHome === '') return []
  try {
    const list = JSON.parse(readFileSync(join(dataHome, FACTORY_LIST), 'utf8'))
    if (!Array.isArray(list.plugins)) return []
    return list.plugins.filter(entry => entry?.disabled === true).map(entry => entry.name).filter(name => typeof name === 'string')
  } catch {
    return []
  }
}

/**
 * The overlay rows that keep the factory plugins that ship turned off off. A plugin that is
 * not in the profile has no row, so nothing is written for it.
 * @param {import('@deepseek-ai/dsh-app-boot').Profile} profile
 * @param {string[]} names - the package names that ship off
 * @returns {import('@deepseek-ai/cordis-plugin-include').PatchOptions[]}
 */
export function factoryOffRows(profile, names) {
  const entries = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches])
  const rows = []
  for (const id of names) {
    const row = entries.find(entry => entry.id === id)
    if (row === undefined) continue
    rows.push({ id, name: row.name, disabled: true })
  }
  return rows
}

/**
 * The overlay row that keeps the account UI off, or `undefined` when the composed profile
 * holds no such row to turn off. The row's name comes from the composition: a future package
 * rename then lands on the new name, and the match cannot silently miss.
 * @param {import('@deepseek-ai/dsh-app-boot').Profile} profile
 * @returns {import('@deepseek-ai/cordis-plugin-include').PatchOptions[] | undefined}
 */
export function ownUiPatch(profile) {
  const entries = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches])
  const row = entries.find(entry => entry.id === UI_ROW)
  if (row === undefined) return undefined
  return [{ id: UI_ROW, name: row.name, disabled: true }]
}

/**
 * Write the alignment overlay next to the profiles and report it for `patchFiles`; when the
 * row is gone, drop a stale overlay from an earlier launch.
 * @param {import('@deepseek-ai/dsh-app-boot').Profile} profile
 * @param {string[]} [factoryOff] - the factory plugins that ship turned off
 * @returns {string[]} the `patchFiles` argument for this launch
 */
export function reconcileOwnUi(profile, factoryOff = []) {
  const file = join(dirname(profile.dir), OWN_UI_PATCH_NAME)
  const rows = ownUiPatch(profile)
  const off = factoryOffRows(profile, factoryOff)
  if (rows === undefined && off.length === 0) {
    rmSync(file, { force: true })
    return []
  }
  writeFileSync(file, stringify([...(rows ?? []), ...off]), 'utf8')
  return [file]
}

// The work-details mode of the host's own chat: how much of a turn's tool calls
// shows. It is a field of the `ui-chat` settings namespace, and the host's settings
// document is the profile's own patch file — so a `transcriptView` there is the
// user's own choice, and the host's own settings page reads it back.
//
// Earlier builds of DS Bot wrote *their* default mode into that file on startup, so
// profiles that ran them carry a mode the user never chose — and because a patch
// row's config outranks the settings document, every later choice in the settings
// page is overwritten again on the next start. That is why the choice did not stick.
//
// This removes the mode from the profile's patch file once, so the host's settings
// page owns it from then on. A profile whose patch file already has no mode is left
// alone, and the removal is idempotent.
const WORK_DETAILS_FIELD = 'transcriptView'
const CHAT_ROW_ID = 'ui-chat'

/**
 * Remove the work-details mode from the profile's `ui-chat` patch row, and the row
 * itself when nothing else is left in it. `undefined` when there was no such file.
 * @param {string} file - the profile's `cordis.patch.yml`
 * @param {{ read?: typeof readFileSync, write?: typeof writeFileSync }} [io] - injectable for tests
 * @returns {boolean | undefined} whether the file was rewritten, or `undefined` when absent
 */
export function dropWorkDetailsPatch(file, { read = readFileSync, write = writeFileSync } = {}) {
  let content
  try {
    content = read(file, 'utf8')
  } catch {
    return undefined
  }
  const lines = content.split('\n')
  const start = lines.findIndex(line => line === `- id: ${CHAT_ROW_ID}`)
  if (start === -1) return false
  let end = start + 1
  while (end < lines.length && !lines[end].startsWith('- ')) end += 1
  const block = lines.slice(start, end)
  if (!block.some(line => line.trim().startsWith(`${WORK_DETAILS_FIELD}:`))) return false
  const kept = block.filter(line => !line.trim().startsWith(`${WORK_DETAILS_FIELD}:`))
  // The row's config is a nested mapping; with the mode gone it may hold nothing.
  const config = kept.findIndex(line => line === '  config:')
  const hasConfig = config !== -1 && kept.slice(config + 1).some(line => /^ {4}\S/u.test(line))
  const withoutConfig = config === -1 ? kept : kept.filter((line, index) => index !== config || hasConfig)
  // Nothing but the id and the name is left: the row has no purpose of its own.
  const onlyIdentity = withoutConfig.every(line => /^(- id: |  name: )/u.test(line))
  const next = onlyIdentity
    ? [...lines.slice(0, start), ...lines.slice(end)]
    : [...lines.slice(0, start), ...withoutConfig, ...lines.slice(end)]
  write(file, next.join('\n'), 'utf8')
  return true
}
