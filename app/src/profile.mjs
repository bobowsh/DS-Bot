// The app's own DSH profile: its name, its bundles and its installation.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { initProfile, loadProfileDirectory, readProfileManifest, resolveProfileDir, writeProfileBundles } from '@deepseek-ai/dsh-app-boot'

export const PROFILE = 'ds-bot'
// DSH's shared core, DSH's web front end (the window), then the Bot team. Bundles the user
// installs follow.
export const BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'ds-bot']
// The import plugin brings in the sessions of a DSH the user already has, and its own panel
// offers the same import by hand. It is not in BUNDLES: the user may turn it off in the plugin
// manager, and a bundle the app writes back on every start would silently undo that.
export const OPTIONAL_BUNDLES = ['dsh-chat-import']
// Bundles that earlier builds of the app put in its profile: the engine layer of its own window (../engine).
const RETIRED_BUNDLES = ['deepseek-bot-engine']
// The app's own manifest is the installation: DSH imports plugins only from the installation's dependency
// graph, resolves bundles there first, and keeps the bundles it names as direct dependencies from removal.
export const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

// Where the app remembers which optional bundles it manages and which the user turned off. DSH's
// plugin manager removes a bundle from the profile's list when it is disabled, so the list alone
// cannot tell a bundle the user turned off from one this app never added. This file says which
// ones the app manages, and the app never adds a turned-off one back.
const optionalFile = dir => join(dir, 'optional-bundles.json')

/**
 * The optional bundles the app manages, and the ones the user turned off.
 * @param {string} dir - the profile directory
 * @returns {{ managed: string[], turnedOff: string[] }}
 */
export function optionalBundles(dir) {
  try {
    const parsed = JSON.parse(readFileSync(optionalFile(dir), 'utf8'))
    const list = value => Array.isArray(value) ? value.filter(name => typeof name === 'string') : []
    return { managed: list(parsed?.managed), turnedOff: list(parsed?.turnedOff) }
  } catch {
    // No record yet: this profile predates the app managing optional bundles.
    return { managed: [], turnedOff: [] }
  }
}

/**
 * Put the app's bundles at the head of a profile's bundle list and keep the user's after them.
 * initProfile writes the list only into a new profile, so a profile from an earlier build keeps its old list.
 *
 * An optional bundle the user turned off in the plugin manager is gone from the profile's list, and
 * putting it back would undo their choice on every start. The app therefore remembers the ones it
 * manages and the ones that were turned off, and leaves a turned-off one alone.
 * @param {string} dir - the profile directory
 */
export function claimBundles(dir) {
  const manifest = readProfileManifest('dsh', dir)
  const listed = manifest.dsh?.profile?.bundles ?? []
  const state = optionalBundles(dir)
  // A bundle the app manages and that is no longer in the list was turned off in the plugin
  // manager; a bundle that is in the list again was turned back on. A profile from an earlier
  // build has no record yet: the ones it lists are managed.
  const turnedOff = [...new Set([...state.turnedOff.filter(name => !listed.includes(name)), ...state.managed.filter(name => !listed.includes(name))])]
  const managed = [...new Set([...state.managed, ...OPTIONAL_BUNDLES.filter(name => listed.includes(name) || !turnedOff.includes(name))])]
  // A managed bundle that is not turned off is in the list; one the user turned off is not.
  const optional = managed.filter(name => !turnedOff.includes(name))
  const bundles = [...BUNDLES, ...optional, ...listed.filter((name) => !BUNDLES.includes(name) && !OPTIONAL_BUNDLES.includes(name) && !RETIRED_BUNDLES.includes(name))]
  if (bundles.join('\n') !== listed.join('\n')) writeProfileBundles(dir, manifest, bundles)
  writeFileSync(optionalFile(dir), `${JSON.stringify({ managed, turnedOff }, undefined, 2)}\n`, 'utf8')
}

/**
 * Create or update the profile under the current DSH_HOME and load it.
 * @returns {import('@deepseek-ai/dsh-app-boot').Profile} the loaded profile
 * @throws when one of the app's own bundles does not load
 */
export function loadAppProfile() {
  const dir = resolveProfileDir(PROFILE)
  // A new profile starts with the optional bundles in it, so the import plugin works out of the
  // box. An older profile keeps its own list; claimBundles then adds the ones that are missing.
  initProfile(dir, [...BUNDLES, ...OPTIONAL_BUNDLES])
  claimBundles(dir)
  return loadOwnBundles(dir, [...BUNDLES, ...OPTIONAL_BUNDLES.filter(name => !optionalBundles(dir).turnedOff.includes(name))])
}

function loadOwnBundles(dir, bundles) {
  const profile = loadProfileDirectory('dsh', dir, INSTALL_ANCHOR)
  const lost = profile.skippedBundles.filter(({ packageName }) => bundles.includes(packageName))
  if (lost.length > 0) throw new Error(`The app could not load its own bundles:\n${lost.map(({ packageName, reason }) => `${packageName}: ${reason}`).join('\n')}`)
  return profile
}
