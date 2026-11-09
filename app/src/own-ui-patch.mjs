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
// shows. It is a field of the `ui-chat` plugin's own configuration, and the host's
// settings document IS the profile's patch file: a `transcriptView` in the profile's
// `ui-chat` row is the user's own layer, and the host's settings page reads it back.
//
// Earlier builds of DS Bot wrote *their* default mode into that row on every start,
// so a profile that ran them carries a mode the user never chose, and the choice in
// the settings page never survives a restart.
//
// This realigns that one field to the mode the team wants: 'standard'. The row itself
// stays — it is the user's layer, and the host writes the user's choice back into it.
//
// A row with nothing but an id and a name is a leftover shell: the Host writes it when
// it takes the row over, and it serves no purpose of its own. It goes too.
const WORK_DETAILS_FIELD = 'transcriptView'
const CHAT_ROW_ID = 'ui-chat'
const DEFAULT_WORK_DETAILS = 'standard'

/**
 * Realign the work-details mode in the profile's `ui-chat` patch row to 'standard',
 * and drop a row that holds nothing but an id and a name.
 * `undefined` when there was no such file.
 * @param {string} file - the profile's `cordis.patch.yml`
 * @param {{ read?: typeof readFileSync, write?: typeof writeFileSync }} [io] - injectable for tests
 * @returns {boolean | undefined} whether the file was rewritten, or `undefined` when absent
 */
export function alignWorkDetailsPatch(file, { read = readFileSync, write = writeFileSync } = {}) {
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
  const field = block.findIndex(line => line.trim().startsWith(`${WORK_DETAILS_FIELD}:`))
  if (field === -1) {
    // A row with only an id and a name is a leftover shell, and it goes.
    const onlyIdentity = block.every(line => /^(- id: | {2}name: )/u.test(line))
    if (!onlyIdentity) return false
    write(file, [...lines.slice(0, start), ...lines.slice(end)].join('\n'), 'utf8')
    return true
  }
  const value = block[field].slice(block[field].indexOf(':') + 1).trim()
  if (value === DEFAULT_WORK_DETAILS) return false
  const kept = [...block]
  kept[field] = `${block[field].slice(0, block[field].indexOf(':') + 1)} ${DEFAULT_WORK_DETAILS}`
  write(file, [...lines.slice(0, start), ...kept, ...lines.slice(end)].join('\n'), 'utf8')
  return true
}
