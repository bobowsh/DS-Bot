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

// The intranet registries the factory plugins and skills are distributed from. DSHM_REGISTRY_URL
// is read by the dshmarket plugin from the Host's environment; the other two are written into the
// profile by loadAppProfile(). All three are constants of this installation, not user settings.
export const NPM_REGISTRY = 'http://192.168.1.10:3000/api/packages/dshplugin/npm/'
export const CATALOG_URL = 'http://192.168.1.10:3000/dshplugin/dsh-catalog/raw/branch/main/plugins.json'
export const SKILLHUB_REGISTRY = 'http://192.168.1.10:8081'
export const DSHM_REGISTRY_URL = CATALOG_URL

const FACTORY_PATCH_NAME = 'factory-registry.patch.yml'
const FACTORY_PATCH_ROWS = [
  { id: 'astron-skillhub', name: '@astron-team/skillhub-dsh', config: { registryUrl: SKILLHUB_REGISTRY } },
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
