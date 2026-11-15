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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { compatibilityOf, hostDshVersion, isNewer, latestVersion } from './factory-versions.mjs'

/** The profiles the installer ships the factory plugins for, by name below. */
export const PROFILE = 'ds-bot'

/** The public registries the build pulls the factory plugins from, in the order it tries them. */
export const PUBLIC_REGISTRIES = ['https://registry.npmmirror.com', 'https://registry.npmjs.org']

/**
 * The registries the build pulls the factory plugins from.
 *
 * The public mirrors come first (npmmirror, then npmjs), because the machine that cuts a release
 * has no reason to reach into the intranet. `DS_BOT_FACTORY_REGISTRY` replaces the list outright
 * for an offline or intranet build, which is how the intranet installer is still produced.
 * @returns {string[]}
 */
export function factoryRegistries() {
  const fromEnv = process.env.DS_BOT_FACTORY_REGISTRY?.trim()
  if (fromEnv) return [fromEnv]
  return [...PUBLIC_REGISTRIES]
}

/** The first registry the build pulls from, for the messages that name one. */
export function factoryRegistry() {
  return factoryRegistries()[0]
}

/** The root of the shipped data directory (a DSH home layout). */
export const bundledDataDir = appDir => join(appDir, 'build', 'data')

/**
 * The npm command the build runs, and how it is started.
 *
 * On Windows `npm` is a `.cmd` shim. `spawn` cannot start a `.cmd` directly — Node refuses it
 * with EINVAL, and the bare name is not found at all — so the call goes through a shell.
 * Every argument here is fixed by this module: the package name and version come from the
 * factory manifest, and the registry is a build constant. The shell sees no input of its own.
 */
export function npmCommand() {
  return 'npm'
}

export function npmSpawnOptions() {
  return process.platform === 'win32' ? { shell: true } : {}
}

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
export async function prepareBundledPlugins(appDir, entries, pluginsDev = defaultPluginsDev(appDir), disabled = [], resolve = resolveFactoryVersion) {
  // Build from nothing: an old flat `data/plugins` tree from an earlier layout must not survive
  // into the package and be mistaken for the current output. Only our own old trees go.
  await rm(join(bundledDataDir(appDir), 'plugins'), { recursive: true, force: true })
  await rm(join(bundledDataDir(appDir), 'profiles'), { recursive: true, force: true })
  await rm(join(bundledDataDir(appDir), 'factory'), { recursive: true, force: true })
  await mkdir(nodeModulesDir(appDir), { recursive: true })
  // One reachability probe per registry for the whole build: an offline machine pays it once,
  // not per plugin. The first registry that answers carries the build.
  const registries = []
  for (const registry of factoryRegistries()) {
    if (await registryReachable(registry)) { registries.push(registry); continue }
    console.log(`LinkHarness: the factory registry ${registry} is unreachable`)
  }
  const useRegistry = registries.length > 0
  if (!useRegistry) console.log(`LinkHarness: no factory registry answered, packing the plugins from ${pluginsDev}`)
  const made = []
  for (const entry of entries) {
    // Which version to ship, and whether this app can load it. The registry's latest is used
    // when it is newer AND compatible; otherwise the version the manifest pins is shipped.
    const resolved = useRegistry
      ? await resolve(entry, { appDir, registries })
      : { version: entry.version, via: 'dev-folder', note: 'no registry answered' }
    const effective = { ...entry, version: resolved.version }
    const staged = await sourceOf(appDir, effective, pluginsDev, useRegistry && resolved.via === 'registry', registries)
    const { from, manifest, via } = staged
    if (manifest.name !== entry.name) throw new Error(`The folder resolved for ${entry.name} is actually ${manifest.name}; the factory manifest and the folder disagree.`)
    if (manifest.version !== effective.version) throw new Error(`${entry.name} is version ${manifest.version} where the manifest promises ${effective.version}; refusing to pack a drifted version.`)
    // The plugin's own dependencies travel with it, and their dependencies too.
    const stage = await stagePlugin(appDir, from, manifest)
    const folder = await copyPlugin(stage, bundledPluginDir(appDir, entry.name))
    made.push({ name: manifest.name, version: manifest.version, via, folder, pinned: entry.version, note: resolved.note })
    console.log(`LinkHarness: ${manifest.name}@${manifest.version} from ${via === 'registry' ? resolved.registry ?? registries.join(' / ') : pluginsDev}${entry.version === manifest.version ? '' : ` (the manifest pins ${entry.version})`}${resolved.note === undefined ? '' : ` — ${resolved.note}`}`)
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
  // The manifest records the version this build actually shipped, so the package and the list
  // stay consistent and a shipped version is traceable afterwards. A plugin left at its pinned
  // version is untouched: no needless churn in the diff.
  writePackedVersions(appDir, made)
  return made.map(({ folder }) => folder)
}

/**
 * Write the versions this build shipped back into `factory.manifest.json`.
 *
 * Without it the manifest would keep claiming the old pinned version while the package carries a
 * newer one — the list and the package would disagree, and the next build would have no record of
 * what went out. Only entries that changed are rewritten, so a build that pulls nothing new
 * leaves the file byte-identical.
 * @param {string} appDir @param {{ name: string, version: string, pinned: string }[]} made
 * @returns {string[]} the names whose version changed
 */
export function writePackedVersions(appDir, made) {
  const file = join(appDir, 'factory.manifest.json')
  // A caller that assembles the data tree without the app's manifest (a test, or a one-off
  // staging run) has nothing to record against: the shipped list is still written, the manifest
  // simply stays as it is.
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf8')
  const manifest = JSON.parse(text)
  const changed = []
  for (const plugin of manifest.plugins ?? []) {
    const shipped = made.find(entry => entry.name === plugin.name)
    if (shipped === undefined || shipped.version === plugin.version) continue
    changed.push({ name: plugin.name, from: plugin.version, to: shipped.version })
    plugin.version = shipped.version
  }
  if (changed.length === 0) return []
  // The file is hand-kept and reviewed: its entries are one line each, so the diff of a build is
  // the versions that moved and nothing else. Rewriting it through JSON.stringify would reflow
  // every entry and bury that diff, so only the changed lines are replaced.
  let out = text
  for (const { name, from, to } of changed) {
    const before = `{ "name": ${JSON.stringify(name)}, "version": ${JSON.stringify(from)} }`
    const after = `{ "name": ${JSON.stringify(name)}, "version": ${JSON.stringify(to)} }`
    if (!out.includes(before)) {
      // The entry is laid out some other way than this file uses: fall back to the whole object,
      // which still keeps every key and its order.
      out = `${JSON.stringify(manifest, undefined, 2)}\n`
      break
    }
    out = out.replace(before, after)
  }
  writeFileSync(file, out, 'utf8')
  return changed
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
 * The registry wins when the build can reach it: its tarball is the version {@link
 * resolveFactoryVersion} chose. The development folder is the offline fallback; a plugin that
 * resolves to neither stops the build.
 * @param {string} appDir @param {{ name: string, version: string }} entry @param {string} pluginsDev
 * @param {boolean} useRegistry @param {string[]} registries
 */
async function sourceOf(appDir, entry, pluginsDev, useRegistry, registries = []) {
  if (useRegistry) {
    for (const registry of registries) {
      // The reason a registry pull failed is worth printing: a build that silently falls back
      // to the development folder ships a different plugin than the manifest promises.
      const staged = await packFromRegistry(entry, registry).catch(error => {
        console.log(`LinkHarness: ${entry.name}@${entry.version} could not be pulled from ${registry} (${error.message})`)
        return undefined
      })
      if (staged !== undefined) return { ...staged, via: 'registry' }
    }
    console.log(`LinkHarness: ${entry.name}@${entry.version} is not on any factory registry, falling back to ${pluginsDev}`)
  }
  // The development folder names a plugin directory after the package name without its scope,
  // or after the full scoped name; both shapes are accepted, the flat one is the convention.
  const leaf = entry.name.replace(/^@[^/]+\//u, '')
  for (const dir of [join(pluginsDev, leaf), join(pluginsDev, ...entry.name.split('/'))]) {
    const manifest = await readManifest(dir)
    if (manifest !== undefined) return { from: dir, manifest, via: 'dev-folder' }
  }
  throw new Error(`The factory plugin ${entry.name}@${entry.version} resolved to nothing: it is neither on ${registries.join(' / ')} nor in ${join(pluginsDev, leaf)}. The build stops instead of shipping without it.`)
}

async function readManifest(dir) {
  return readFile(join(dir, 'package.json'), 'utf8').then(JSON.parse).catch(() => undefined)
}

/**
 * Which version of one factory plugin this build ships.
 *
 * Asks the registries for `dist-tags.latest`, then decides:
 *
 *   - latest is older than or equal to the pinned version → ship the pinned version (see
 *     `isNewer`: a mirror's `latest` can point at a placeholder far behind what we ship);
 *   - latest is newer → fetch its manifest and check the app can load it (`engines.dsh` and a
 *     peer dependency on `@deepseek-ai/dsh*`); ship latest when it can;
 *   - latest is newer but NOT compatible → ship the pinned version and say why (one plugin
 *     outside its range must not fail the whole build, and must not ship a copy the Host would
 *     refuse to activate);
 *   - the registry cannot be read → ship the pinned version and say why.
 *
 * A plugin the manifest pins but that has vanished from the registry is still shipped at the
 * pinned version: `sourceOf` then reports the pull failure, and the build stops if the plugin
 * is nowhere at all.
 * @param {{ name: string, version: string }} entry @param {{ appDir: string, registries: string[] }} options
 * @returns {Promise<{ version: string, via: 'registry' | 'manifest', registry?: string, note?: string }>}
 */
export async function resolveFactoryVersion(entry, { appDir, registries }) {
  const { version: hostVersion, packages } = hostDshVersion(appDir)
  const host = { version: hostVersion, packages }
  const pinned = entry.version
  for (const registry of registries) {
    const latest = await latestVersion(entry.name, registry)
    if (latest.error !== undefined) {
      if (registries.indexOf(registry) === registries.length - 1) {
        return { version: pinned, via: 'manifest', note: `the registry could not be read (${latest.error}); shipping the version the manifest pins` }
      }
      continue
    }
    if (!isNewer(latest.version, pinned)) {
      return { version: pinned, via: 'manifest', registry, note: `the registry's latest is ${latest.version}, which is not newer; shipping the version the manifest pins` }
    }
    const info = await manifestAt(entry.name, latest.version, registry)
    if (info.error !== undefined) {
      return { version: pinned, via: 'manifest', registry, note: `${latest.version} could not be read (${info.error}); shipping the version the manifest pins` }
    }
    const check = compatibilityOf(info.manifest, host)
    if (!check.compatible) {
      return { version: pinned, via: 'manifest', registry, note: `skipped ${latest.version}: ${check.reason}` }
    }
    return { version: latest.version, via: 'registry', registry, note: undefined }
  }
  return { version: pinned, via: 'manifest', note: 'no registry answered; shipping the version the manifest pins' }
}

/**
 * One version's manifest, straight from a registry's metadata.
 *
 * The plugin's own tarball is what actually ships; this only reads the declarations that decide
 * whether the app can load it, so the check costs no download.
 * @param {string} name @param {string} version @param {string} registry
 * @returns {Promise<{ manifest: object } | { error: string }>}
 */
async function manifestAt(name, version, registry) {
  const base = registry.endsWith('/') ? registry : `${registry}/`
  try {
    const response = await fetch(`${base}${name.replace('/', '%2f')}/${version}`, { signal: AbortSignal.timeout(4000) })
    if (!response.ok) return { error: `the registry answered ${response.status}` }
    const body = await response.json()
    return body?.['dist-tags'] === undefined && body?.version !== undefined
      ? { manifest: body }
      : { error: 'the registry published no manifest for that version' }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
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
    const child = spawn(npmCommand(), ['pack', spec, '--registry', registry, '--pack-destination', staging, '--silent'], { ...npmSpawnOptions(), stdio: ['ignore', 'pipe', 'pipe'] })
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
        // `tar -C` needs the target to exist; without it the unpack fails with exit 1.
        mkdirSync(unpacked, { recursive: true })
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
