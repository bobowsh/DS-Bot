// The app's own DSH profile: its name, its bundles and its installation.
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stringify } from 'yaml'
import { LEGACY_ENGINE } from './legacy.mjs'
import { initProfile, loadProfileDirectory, readProfileManifest, resolveProfileDir, writeProfileBundles } from '@deepseek-ai/dsh-app-boot'

export const PROFILE = 'ds-bot'
// DSH's shared core, DSH's web front end (the window) and voice input, then the Bot team.
// Bundles the user installs follow. The import plugin is not among them: it belongs to the
// profile, so the user may turn it off in the plugin manager (src/import-plugin.mjs puts it there).
export const BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-experimental-voice-input-bundle', 'ds-bot']
// The first-run check reads a copy of the team's chats without the Bot team running on them.
// DSH reads a log the same way whatever the profile mounts.
export const CHECK_PROFILE = 'import-check'
export const CHECK_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
// Bundles that earlier builds of the app put in its profile: the engine layer of its own window (../engine).
const RETIRED_BUNDLES = [LEGACY_ENGINE, 'dsbot-engine']
// The app's own manifest is the installation: DSH imports plugins only from the installation's dependency
// graph, resolves bundles there first, and keeps the bundles it names as direct dependencies from removal.
export const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

// The intranet registries the factory plugins and skills are distributed from: the npm registry
// (written into the profile as .npmrc) and the SkillHub catalog (written as a --patch overlay).
// Both are constants of this installation, not user settings.
//
// The plugin market's catalog is deliberately NOT named here. dshmarket already carries its own
// catalog source list (its official domain, with the published `dsh-plugin-catalog` npm package as
// a fallback), and setting DSHM_REGISTRY_URL REPLACES that whole list rather than heading it
// (dshmarket lib/regions.js routesFor). Pointing it at an intranet address therefore costs the
// market its own sources, and while that intranet service is down the market has no catalog at
// all. Leaving the variable unset keeps the market on its own routing, and keeps us from having
// to track dshmarket's sources as it updates them.
//
// The intranet catalog is still used by our own factory plugin auto-update (factory-update.mjs,
// which has its own CATALOG_URL) — that is a different line from the public market.
export const NPM_REGISTRY = 'http://192.168.1.10:3000/api/packages/dshplugin/npm/'
export const SKILLHUB_REGISTRY = 'http://192.168.1.10:8081'

const FACTORY_PATCH_NAME = 'factory-registry.patch.yml'
// The marketplace's download region, pinned here rather than left to its own probe.
//
// dshmarket tries its catalog sources in the region's order (lib/regions.js). The `global`
// order asks the project's own domain FIRST — measured on this network: 15.3 MB at about
// 10 KB/s, so the first source alone holds the market for minutes before it falls back. The
// `china` order asks an npm mirror first, which serves the same catalog as a 5 MB package in
// well under a second. Measured end to end with dshmarket's own code: global 355 s / 10,936
// entries, china 0.9 s / 10,974 entries.
//
// It is a config-layer choice, not a patch to dshmarket: routes.js reads `config.region`, and
// treats a region written into the profile as the operator's answer, so its probe stands down.
const MARKET_REGION = 'china'
const FACTORY_PATCH_ROWS = [
  { id: 'astron-skillhub', name: '@astron-team/skillhub-dsh', config: { registryUrl: SKILLHUB_REGISTRY } },
  { id: 'dsh-market', config: { region: MARKET_REGION } },
]
const npmrcMarker = '# managed by LinkHarness factory registries\n'
const npmrcManaged = `${npmrcMarker}registry=${NPM_REGISTRY}\n`

/**
 * Point the profile's package manager at the intranet npm registry. A .npmrc without our marker
 * belongs to the user and is kept as it is; one we wrote is refreshed when the URL changes.
 * @param {string} dir - the profile directory
 * @returns {{ written: boolean, kept: boolean }}
 */
export function writeFactoryNpmrc(dir) {
  const file = join(dir, '.npmrc')
  mkdirSync(dir, { recursive: true })
  if (existsSync(file)) {
    const current = readFileSync(file, 'utf8')
    if (!current.includes(npmrcMarker) && /registry\s*=/u.test(current)) return { written: false, kept: true }
    if (current === npmrcManaged) return { written: false, kept: false }
  }
  writeFileSync(file, npmrcManaged, 'utf8')
  return { written: true, kept: false }
}

/**
 * Keep the marketplace's saved region in step with MARKET_REGION.
 *
 * The plugin keeps its own state (`<profile>/.dsh-market/state.json`), and a region written
 * there wins over the composition's config (dshmarket lib/routes.js: it copies
 * `marketState.region` over `config.region` before choosing sources). A machine that has been
 * probed once therefore keeps the region the probe picked — `global` here, whose first catalog
 * source is the slow one — and the patch alone would never take effect on it.
 *
 * Only an AUTO-picked region is replaced: `regionAuto` records that the probe chose it. A region
 * the user picked themselves is left alone, which is what the flag is there to tell apart.
 * @param {string} dir - the profile directory
 * @returns {'updated' | 'kept' | 'absent'} what it did
 */
export function alignMarketRegion(dir) {
  const file = join(dir, '.dsh-market', 'state.json')
  let state
  try {
    state = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // No state yet (a fresh profile): the patch's region is the only answer, nothing to align.
    return 'absent'
  }
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return 'kept'
  if (state.region === MARKET_REGION && state.regionAuto !== true) return 'kept'
  if (state.regionAuto !== true && state.region !== undefined) return 'kept'
  writeFileSync(file, `${JSON.stringify({ ...state, region: MARKET_REGION, regionAuto: false }, undefined, 2)}\n`, 'utf8')
  return 'updated'
}

/**
 * Write the --patch overlay that sets the SkillHub registry url, and report it for patchFiles.
 * DSH reads it only through patchFiles, so the profile's own cordis.patch.yml is never edited.
 * @param {import('@deepseek-ai/dsh-app-boot').Profile} profile
 * @returns {string[]} its part of the `patchFiles` argument
 */
export function writeFactoryRegistryPatch(profile) {
  const file = join(dirname(profile.dir), FACTORY_PATCH_NAME)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, stringify(FACTORY_PATCH_ROWS), 'utf8')
  return [file]
}

/**
 * Put the app's bundles at the head of a profile's bundle list and keep the user's after them.
 * initProfile writes the list only into a new profile, so a profile from an earlier build keeps its old list.
 * @param {string} dir - the profile directory
 */
export function claimBundles(dir) {
  const manifest = readProfileManifest('dsh', dir)
  const listed = manifest.dsh?.profile?.bundles ?? []
  const bundles = [...BUNDLES, ...listed.filter((name) => !BUNDLES.includes(name) && !RETIRED_BUNDLES.includes(name))]
  if (bundles.join('\n') !== listed.join('\n')) writeProfileBundles(dir, manifest, bundles)
}

/**
 * Create or update the profile under the current DSH_HOME and load it.
 * @returns {import('@deepseek-ai/dsh-app-boot').Profile} the loaded profile
 * @throws when one of the app's own bundles does not load
 */
export function loadAppProfile() {
  const dir = resolveProfileDir(PROFILE)
  initProfile(dir, BUNDLES)
  claimBundles(dir)
  writeFactoryNpmrc(dir)
  alignMarketRegion(dir)
  return loadOwnBundles(dir, BUNDLES)
}

/** The profile of the first-run check, under the current DSH_HOME. */
export function loadCheckProfile() {
  const dir = resolveProfileDir(CHECK_PROFILE)
  initProfile(dir, CHECK_BUNDLES)
  return loadOwnBundles(dir, CHECK_BUNDLES)
}

function loadOwnBundles(dir, bundles) {
  const profile = loadProfileDirectory('dsh', dir, INSTALL_ANCHOR)
  const lost = profile.skippedBundles.filter(({ packageName }) => bundles.includes(packageName))
  if (lost.length > 0) throw new Error(`The app could not load its own bundles:\n${lost.map(({ packageName, reason }) => `${packageName}: ${reason}`).join('\n')}`)
  return profile
}
