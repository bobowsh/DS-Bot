// The bundled plugin, shipped as a plain folder of files.
//
// The plugin travels with the app as a folder, not as an archive: the installer then holds a
// few hundred plain files instead of one compressed file, and the first start copies them into
// the profile (src/import-plugin.mjs), where DSH loads it like a plugin the user installed.
// The folder sits in the data directory beside the program, so the install never reaches the
// network and an updated app brings an updated plugin.
import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Where a plugin's folder is written, and where the installer expects it. A scoped name is
 * flattened (`@scope/name` -> `scope-name`): the installer reads one flat directory, and a
 * slash in the name would turn into a subdirectory it never looks in.
 */
export const bundledPluginDir = (appDir, name) => join(appDir, 'build', 'data', 'plugins', name.replace(/^@/u, '').replace(/\//gu, '-'))

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
 * Put the plugins the app carries into folders the installer ships.
 *
 * The package content comes from the plugin development folder (`DS_BOT_PLUGINS_DEV`, by default
 * `<repo>/../dsh-plugins-dev`), where each plugin has a `pack/` holding the npm-published version
 * that ships. A package missing there is taken from the app's own node_modules, which is how the
 * import plugin has always been packed.
 *
 * The folder holds the plugin and the packages it depends on: the plugin runs from the profile,
 * where Node resolves its imports from the profile's own node_modules, so a dependency that
 * stayed in the app's node_modules would not be found.
 * @param {string} appDir - the app directory
 * @param {string[]} names - the package names to pack
 * @param {string} [pluginsDev] - the plugin development folder
 */
export async function prepareBundledPlugins(appDir, names, pluginsDev = defaultPluginsDev(appDir)) {
  const made = []
  for (const name of names) {
    const staged = await sourceOf(appDir, name, pluginsDev)
    if (staged === undefined) continue
    const { from, manifest } = staged
    // The plugin's own dependencies travel with it, and their dependencies too.
    const stage = await stagePlugin(appDir, from, manifest)
    made.push(await copyPlugin(stage, bundledPluginDir(appDir, name)))
    await rm(dirname(stage), { recursive: true, force: true })
  }
  return made
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
