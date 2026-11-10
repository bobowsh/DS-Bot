// The factory plugins travel as a DSH home: they sit in the profile's own node_modules inside
// the data directory the installer ships. No archive, no first-start unpack: the data directory
// is the app's DSH home, so the folders are already where DSH finds an installed plugin.
// The first start only records them in the profile manifest, and refreshes them when a newer
// installer carries a newer version. The install never reaches the network.
//
// The source of each plugin is the factory manifest (`app/factory.manifest.json`), resolved in
// this order: the intranet Gitea npm registry first, then the local plugin development folder
// (`DS_BOT_PLUGINS_DEV`, by default `<repo>/../dsh-plugins-dev`). A plugin that resolves to
// neither stops the build: a package the manifest promises must not silently go missing.
// Every resolved version must match the manifest, so a drifted folder cannot ship.
import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** The profile inside the data directory whose node_modules holds the plugins. */
export const PROFILE = 'ds-bot'

/** The intranet registry the build pulls the factory plugins from when it can reach it. */
export function factoryRegistry() {
  return process.env.DS_BOT_FACTORY_REGISTRY?.trim()
    || 'http://192.168.1.10:3000/api/packages/dshplugin/npm/'
}

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
 * Put the plugins the factory manifest lists into the data directory the installer ships.
 * @param {string} appDir - the app directory
 * @param {{ name: string, version: string }[]} entries - the manifest's plugin entries
 * @param {string} [pluginsDev] - the local plugin development folder (the offline fallback)
 */
export async function prepareBundledPlugins(appDir, entries, pluginsDev = defaultPluginsDev(appDir), disabled = []) {
  // Build from nothing: an old flat `data/plugins` tree from an earlier layout must not survive
  // into the package and be mistaken for the current output. Only our own old trees go.
  await rm(join(bundledDataDir(appDir), 'plugins'), { recursive: true, force: true })
  await rm(join(bundledDataDir(appDir), 'profiles'), { recursive: true, force: true })
  await rm(join(bundledDataDir(appDir), 'factory'), { recursive: true, force: true })
  await mkdir(nodeModulesDir(appDir), { recursive: true })
  // One reachability probe for the whole build: an offline machine pays it once, not per plugin.
  const registry = factoryRegistry()
  const useRegistry = await registryReachable(registry)
  if (!useRegistry) console.log(`LinkHarness: the factory registry ${registry} is unreachable, packing the plugins from ${pluginsDev}`)
  const made = []
  for (const entry of entries) {
    const staged = await sourceOf(appDir, entry, pluginsDev, useRegistry)
    const { from, manifest, via } = staged
    if (manifest.name !== entry.name) throw new Error(`The folder resolved for ${entry.name} is actually ${manifest.name}; the factory manifest and the folder disagree.`)
    if (manifest.version !== entry.version) throw new Error(`${entry.name} is version ${manifest.version} where the manifest promises ${entry.version}; refusing to pack a drifted version.`)
    // The plugin's own dependencies travel with it, and their dependencies too.
    const stage = await stagePlugin(appDir, from, manifest)
    const folder = await copyPlugin(stage, bundledPluginDir(appDir, entry.name))
    made.push({ name: manifest.name, version: manifest.version, via, folder })
    await rm(dirname(stage), { recursive: true, force: true })
  }
  // The list of the plugins the build carries. The installer and the first start read it to tell
  // the factory plugins from the ones the user installed, so an upgrade only replaces these names.
  // Plain-text form is for the NSIS installer, which cannot read JSON.
  // A plugin that ships turned off carries `disabled: true` on its entry: the first start keeps
  // it out of the bundle list, and the overlay turns it off on a machine that installed it.
  const factory = join(bundledDataDir(appDir), 'factory')
  await mkdir(factory, { recursive: true })
  const off = new Set(disabled.map(entry => entry.name))
  writeFileSync(join(factory, 'plugins.json'), `${JSON.stringify({
    plugins: made.map(({ name, version }) => ({
      name, version, path: `profiles/${PROFILE}/node_modules/${name}`,
      ...(off.has(name) ? { disabled: true } : {}),
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
 * One short probe of the registry metadata, so an offline build does not wait out a per-plugin
 * network timeout twelve times.
 * @param {string} registry - the registry root
 * @param {number} [timeoutMs] - how long the probe may take
 */
export async function registryReachable(registry, timeoutMs = 2500) {
  try {
    const response = await fetch(registry, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) })
    return response.ok || response.status === 404
  } catch {
    return false
  }
}

/**
 * Resolve one manifest entry to a package folder and its manifest.
 *
 * The registry wins when the build can reach it: its tarball is the version the intranet
 * publishes. The development folder is the offline fallback; a plugin that resolves to neither
 * stops the build.
 * @param {string} appDir @param {{ name: string, version: string }} entry @param {string} pluginsDev @param {boolean} useRegistry
 */
async function sourceOf(appDir, entry, pluginsDev, useRegistry) {
  const registry = factoryRegistry()
  if (useRegistry) {
    const staged = await packFromRegistry(entry, registry).catch(() => undefined)
    if (staged !== undefined) return { ...staged, via: 'registry' }
    console.log(`LinkHarness: ${entry.name}@${entry.version} is not on the registry, falling back to ${pluginsDev}`)
  }
  // The development folder names a plugin directory after the package name without its scope,
  // or after the full scoped name; both shapes are accepted, the flat one is the convention.
  const leaf = entry.name.replace(/^@[^/]+\//u, '')
  for (const dir of [join(pluginsDev, leaf), join(pluginsDev, ...entry.name.split('/'))]) {
    const manifest = await readManifest(dir)
    if (manifest !== undefined) return { from: dir, manifest, via: 'dev-folder' }
  }
  throw new Error(`The factory plugin ${entry.name}@${entry.version} resolved to nothing: it is neither on ${registry} nor in ${join(pluginsDev, leaf)}. The build stops instead of shipping without it.`)
}

async function readManifest(dir) {
  return readFile(join(dir, 'package.json'), 'utf8').then(JSON.parse).catch(() => undefined)
}

/**
 * Download one plugin tarball from the registry and unpack it into a temp folder.
 * @param {{ name: string, version: string }} entry
 * @returns {{ from: string, manifest: object }} the unpacked package folder
 */
function packFromRegistry(entry, registry) {
  return new Promise((resolve, reject) => {
    const staging = mkdtempSync(join(tmpdir(), 'ds-bot-registry-'))
    const spec = `${entry.name}@${entry.version}`
    const child = spawn('npm', ['pack', spec, '--registry', registry, '--pack-destination', staging, '--silent'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let settled = false
    const done = error => { if (!settled) { settled = true; clearTimeout(timer); error === undefined ? resolveActual() : reject(error) } }
    const timer = setTimeout(() => { child.kill(); done(new Error(`npm pack ${spec} timed out`)) }, 20000)
    let actual
    const resolveActual = () => {
      // npm pack prints the archive name on the last line; unpack it beside itself.
      try {
        const archive = actual?.trim().split('\n').pop()
        if (archive === undefined || archive === '') throw new Error(`npm pack ${spec} printed no archive name`)
        const unpacked = join(staging, 'unpacked')
        const tar = spawn('tar', ['-xzf', join(staging, archive), '-C', unpacked], { stdio: 'ignore' })
        tar.on('exit', code => {
          if (code !== 0) { reject(new Error(`tar could not unpack ${archive} (exit ${code})`)); return }
          resolve({ from: join(unpacked, 'package'), manifest: JSON.parse(readFileSync(join(unpacked, 'package', 'package.json'), 'utf8')) })
        })
      } catch (error) { reject(error) }
    }
    child.stdout.on('data', data => { actual = (actual ?? '') + data })
    child.on('error', done)
    child.on('exit', code => { if (code !== 0) done(new Error(`npm pack ${spec} exited with ${code}`)); else done() })
  })
}

/**
 * Gather one plugin into a staging folder laid out the way Node resolves it.
 *
 * A plugin that carries its own node_modules (the shape the published copies ship in) is taken
 * as it is. A plugin without one gets its `dependencies` copied in from the app's node_modules,
 * the way the import plugin has always been packed.
 * @param {string} appDir @param {string} from @param {object} manifest
 */
async function stagePlugin(appDir, from, manifest) {
  const stage = mkdtempSync(join(tmpdir(), 'ds-bot-plugin-stage-'))
  const packages = join(stage, 'package')
  await mkdir(packages, { recursive: true })
  await cp(from, packages, { recursive: true })
  const carried = existsSync(join(packages, 'node_modules'))
  if (carried) return packages
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
