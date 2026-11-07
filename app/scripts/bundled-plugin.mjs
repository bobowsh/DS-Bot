// The factory plugins travel as a DSH home: they sit in the profile's own node_modules inside
// the data directory the installer ships. No archive, no first-start unpack: the data directory
// is the app's DSH home, so the folders are already where DSH finds an installed plugin.
// The first start only records them in the profile manifest, and refreshes them when a newer
// installer carries a newer version. The install never reaches the network.
import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** The profile inside the data directory whose node_modules holds the plugins. */
export const PROFILE = 'ds-bot'

/** The root of the shipped data directory (a DSH home layout). */
export const bundledDataDir = appDir => join(appDir, 'build', 'data')

/** The directory the installer ships the factory plugins and their list in. */
const nodeModulesDir = appDir => join(bundledDataDir(appDir), 'profiles', PROFILE, 'node_modules')

/**
 * Where a plugin's folder is written: the profile's own node_modules. A scoped name keeps its
 * scope (`@scope/name` -> `node_modules/@scope/name`), the way Node resolves it.
 */
export const bundledPluginDir = (appDir, name) => join(nodeModulesDir(appDir), ...name.split('/'))

/**
 * Copy a package directory into the place the installer ships it from.
 * @param {string} from - the package directory
 * @param {string} to - the folder to write
 */
export async function copyPlugin(from, to) {
  await mkdir(dirname(to), { recursive: true })
  await rm(to, { recursive: true, force: true })
  await cp(from, to, { recursive: true })
  return to
}

/**
 * Put the plugins the app carries into the data directory the installer ships.
 *
 * The package content comes from the plugin development folder (`DS_BOT_PLUGINS_DEV`, by default
 * `<repo>/../dsh-plugins-dev`), where each plugin has a `pack/` holding the npm-published version
 * that ships. A package missing there is taken from the app's own node_modules, which is how the
 * import plugin has always been packed.
 *
 * Each folder holds the plugin and the packages it depends on, because the plugin runs from the
 * profile and Node resolves its imports from the folder's own node_modules.
 * @param {string} appDir - the app directory
 * @param {string[]} names - the package names to pack
 * @param {string} [pluginsDev] - the plugin development folder
 */
export async function prepareBundledPlugins(appDir, names, pluginsDev = defaultPluginsDev(appDir)) {
  // Build from nothing: an old flat `data/plugins` tree from an earlier layout must not survive
  // into the package and be mistaken for the current output. Only our own old trees go; the
  // skills repository is written by beforePack before we are called.
  await rm(join(bundledDataDir(appDir), 'plugins'), { recursive: true, force: true })
  await rm(join(bundledDataDir(appDir), 'profiles'), { recursive: true, force: true })
  await rm(join(bundledDataDir(appDir), 'factory'), { recursive: true, force: true })
  await mkdir(nodeModulesDir(appDir), { recursive: true })
  const made = []
  for (const name of names) {
    const staged = await sourceOf(appDir, name, pluginsDev)
    if (staged === undefined) continue
    const { from, manifest } = staged
    // The plugin's own dependencies travel with it, and their dependencies too.
    const stage = await stagePlugin(appDir, from, manifest)
    const folder = await copyPlugin(stage, bundledPluginDir(appDir, name))
    made.push({ name: manifest.name ?? name, version: manifest.version, folder })
    await rm(dirname(stage), { recursive: true, force: true })
  }
  // The list of the plugins the build carries. The installer and the first start read it to tell
  // the factory plugins from the ones the user installed, so an upgrade only replaces these names.
  // Plain-text form is for the NSIS installer, which cannot read JSON.
  const factory = join(bundledDataDir(appDir), 'factory')
  await mkdir(factory, { recursive: true })
  writeFileSync(join(factory, 'plugins.json'), `${JSON.stringify({
    plugins: made.map(({ name, version }) => ({
      name, version, path: `profiles/${PROFILE}/node_modules/${name}`,
    })),
  }, undefined, 2)}\n`, 'utf8')
  writeFileSync(join(factory, 'plugins.txt'),
    `${made.map(({ name }) => name.replace(/\//gu, '\\')).join('\n')}\n`, 'utf8')
  return made.map(({ folder }) => folder)
}

/** The folder the plugin development checkouts live in: the environment, else beside the repo. */
export function defaultPluginsDev(appDir) {
  const fromEnv = process.env.DS_BOT_PLUGINS_DEV?.trim()
  if (fromEnv) return fromEnv
  return join(dirname(dirname(appDir)), 'dsh-plugins-dev')
}

/**
 * The package folder to pack for one plugin, and its manifest.
 *
 * `pack/` in the development folder wins: that is the npm-published version chosen to ship. A
 * plugin that only exists in the app's node_modules (the import plugin) is taken from there.
 * @param {string} appDir @param {string} name @param {string} pluginsDev
 */
async function sourceOf(appDir, name, pluginsDev) {
  const read = async dir => readFile(join(dir, 'package.json'), 'utf8').then(JSON.parse).catch(() => undefined)
  // The development folder names a plugin directory after the package name without its scope.
  const leaf = name.replace(/^@[^/]+\//u, '')
  const candidates = [
    join(pluginsDev, leaf, 'pack'),
    join(pluginsDev, name, 'pack'),
    join(appDir, 'node_modules', name),
  ]
  for (const dir of candidates) {
    const manifest = await read(dir)
    if (manifest?.version !== undefined) return { from: dir, manifest }
  }
  return undefined
}

/**
 * Gather a package and the packages it depends on into one folder, laid out the way node
 * resolves them: the package itself, and its dependencies beside it.
 */
async function stagePlugin(appDir, from, manifest) {
  const stage = mkdtempSync(join(tmpdir(), 'ds-bot-plugin-stage-'))
  const packages = join(stage, 'package')
  await mkdir(packages, { recursive: true })
  await cp(from, packages, { recursive: true })
  const seen = new Set([manifest.name])
  const queue = Object.keys(manifest.dependencies ?? {})
  while (queue.length > 0) {
    const dependency = queue.shift()
    if (seen.has(dependency)) continue
    seen.add(dependency)
    const dir = join(appDir, 'node_modules', dependency)
    const own = await readFile(join(dir, 'package.json'), 'utf8').then(JSON.parse).catch(() => undefined)
    if (own === undefined) continue
    await cp(dir, join(packages, 'node_modules', dependency), { recursive: true })
    queue.push(...Object.keys(own.dependencies ?? {}))
  }
  // The package folder itself is what gets copied: its parent is the staging area.
  return packages
}
