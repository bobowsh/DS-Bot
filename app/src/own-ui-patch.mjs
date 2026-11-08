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
