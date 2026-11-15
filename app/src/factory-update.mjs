// The factory plugins update themselves at runtime: after 22:00 the app asks the intranet
// catalog what the plugins it installed have become, and puts the newer ones in place.
//
// The plugins run inside the Host, so a live copy cannot be overwritten while the Host holds it.
// The new copy is unpacked beside the old one first, checked, and only then swapped in; the old
// copy stays in a backup folder until the swap succeeds. The Host picks the new copy up on its
// next start, so the app tells the reader that a restart is what makes it take effect.
//
// Three gates stand between the catalog and the profile:
//   1. a plugin whose catalog entry names a host version the app does not satisfy is skipped;
//   2. an archive that does not unpack, or that does not carry the version the catalog names,
//      is refused and the old copy stays;
//   3. a plugin whose download or check fails three times in a row is left alone for a day.
//
// The state of the daily check lives in <dataDir>/factory-update.json, so a restart does not
// check again on the same day and the failure count survives it.
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { newerVersion } from './import-plugin.mjs'
import { PROFILE } from './bundled-plugins.mjs'

/**
 * The files of a gzipped tar, read with the zlib that Node carries: the archive is the shape npm
 * publishes, and unpacking it needs nothing else. The unpacking lives here because only the
 * runtime update pulls archives at runtime (#10 removed it from import-plugin.mjs, whose install
 * path works on plain folders now).
 * @param {Buffer} buffer - the archive
 * @returns {{ path: string, body: Buffer, directory: boolean }[]}
 */
function readTgz(buffer) {
  const archive = gunzipSync(buffer)
  const entries = []
  for (let at = 0; at + 512 <= archive.length; at += 512) {
    const header = archive.subarray(at, at + 512)
    // Two empty blocks end the archive.
    if (header.every(byte => byte === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '')
    if (name === '') continue
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/u, '')
    const path = prefix === '' ? name : `${prefix}/${name}`
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/u, '').trim() || '0', 8)
    const type = String.fromCharCode(header[156])
    const body = archive.subarray(at + 512, at + 512 + size)
    if (type === '0' || type === '\0') entries.push({ path, body, directory: false })
    else if (type === '5') entries.push({ path: `${path}/`, body: Buffer.alloc(0), directory: true })
    // The data of a file is padded to a whole block.
    at += Math.ceil(size / 512) * 512
  }
  return entries
}

/**
 * Write the files of an archive into a directory.
 *
 * The archive holds the package under `package/`, and the packages it depends on under
 * `package/node_modules/`. The plugin goes into the staging folder under its own name, and its
 * dependencies go beside it, where Node looks for them.
 * @param {Buffer} buffer - the archive
 * @param {string} into - the plugin's directory inside the staging folder
 * @param {string} [stagingModules] - the staging folder's node_modules, where the dependencies go
 */
async function unpackTgz(buffer, into, stagingModules) {
  for (const entry of readTgz(buffer)) {
    // The archive's own top folder is the package: its contents go straight into the target.
    const relative = entry.path.replace(/^[^/]+\//u, '').replace(/\/+$/u, '')
    if (relative === '') continue
    const parts = relative.split('/')
    // The plugin's dependencies are packed beside it, but belong beside the plugin: Node
    // resolves a package's imports from the node_modules above it.
    const target = parts[0] === 'node_modules' && stagingModules !== undefined
      ? join(stagingModules, ...parts.slice(1))
      : join(into, ...parts)
    if (entry.directory) {
      await mkdir(target, { recursive: true })
      continue
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, entry.body)
  }
}

/** The catalog the intranet publishes; it is readable without a token. */
export const CATALOG_URL = 'http://192.168.1.10:3000/dshplugin/dsh-catalog/raw/branch/main/plugins.json'
/** The npm registry the catalog's entries name, through which the archives are fetched. */
export const NPM_REGISTRY = 'http://192.168.1.10:3000/api/packages/dshplugin/npm/'
/** The hour the daily check runs after; a plugin is refreshed at night, not while it is used. */
export const CHECK_HOUR = 22
/** How many failures in a row put a plugin aside for the rest of the day. */
export const FAILURE_LIMIT = 3
/** Where the day's state is kept. */
const stateFile = dataDir => join(dataDir, 'factory-update.json')
/** Where the new copies are unpacked before they are swapped in. */
const stagingDir = dataDir => join(dataDir, 'factory-update-staging')
/** Where the replaced copies are kept until the swap is known to have worked. */
const backupDir = dataDir => join(dataDir, 'factory-update-backup')

/**
 * Whether the hour for today's check has come. The check runs once a day, after CHECK_HOUR, so a
 * session that starts in the morning does not reach for the network at all.
 * @param {Date} now - the current time
 * @returns {boolean}
 */
export function dueForCheck(now = new Date()) {
  return now.getHours() >= CHECK_HOUR
}

/**
 * The day a timestamp belongs to, in the local time zone: the state is kept per day.
 * @param {number} timestamp - epoch milliseconds
 * @returns {string} the day as YYYY-MM-DD
 */
export function dayOf(timestamp = Date.now()) {
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * The state of the daily check: the day it last ran, and how many times each plugin failed.
 * @param {string} dataDir - the data location
 * @returns {Promise<{ day?: string, failures: Record<string, number> }>}
 */
export async function readState(dataDir) {
  try {
    const raw = JSON.parse(await readFile(stateFile(dataDir), 'utf8'))
    return {
      day: typeof raw?.day === 'string' ? raw.day : undefined,
      failures: raw?.failures && typeof raw.failures === 'object' ? raw.failures : {},
    }
  } catch {
    return { failures: {} }
  }
}

/**
 * Write the state of the daily check.
 * @param {string} dataDir - the data location
 * @param {{ day?: string, failures?: Record<string, number> }} state
 * @returns {Promise<void>}
 */
export async function writeState(dataDir, state) {
  await mkdir(dataDir, { recursive: true })
  await writeFile(stateFile(dataDir), `${JSON.stringify({ day: state.day, failures: state.failures ?? {} }, undefined, 2)}\n`, 'utf8')
}

/**
 * The plugins the profile installed, with the version it holds. Only the profile's own
 * dependencies count: a package it carries without listing is one the reader turned off.
 * @param {string} profileDir - the profile directory
 * @returns {Promise<Record<string, string>>} the package name and its version
 */
export async function installedPlugins(profileDir) {
  try {
    const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
    const dependencies = manifest?.dependencies ?? {}
    const versions = {}
    for (const [name, version] of Object.entries(dependencies)) {
      if (typeof version === 'string') versions[name] = version
    }
    return versions
  } catch {
    return {}
  }
}

/**
 * The catalog's plugins, read from the intranet. A catalog that cannot be read is not an error
 * the reader has to see: the app simply stays on what it has.
 * @param {string} [url] - the catalog url
 * @param {typeof fetch} [fetchImpl] - the fetch to use
 * @returns {Promise<{ name: string, version: string, registry?: string }[]>}
 */
export async function readCatalog(url = CATALOG_URL, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(url, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  const body = await response.json()
  const plugins = Array.isArray(body?.plugins) ? body.plugins : []
  return plugins
    .map(entry => ({
      name: typeof entry?.name === 'string' ? entry.name : undefined,
      version: typeof entry?.version === 'string' ? entry.version : undefined,
      registry: typeof entry?.registry === 'string' ? entry.registry : undefined,
    }))
    .filter(entry => entry.name !== undefined && entry.version !== undefined)
}

/**
 * The archive url of one version of a package.
 * @param {string} name - the package name
 * @param {string} version - its version
 * @param {string} [registry] - the npm registry the catalog named
 * @param {typeof fetch} [fetchImpl] - the fetch to use
 * @returns {Promise<string>}
 */
export async function archiveUrl(name, version, registry = NPM_REGISTRY, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`${registry}${name}`, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  const meta = await response.json()
  const tarball = meta?.versions?.[version]?.dist?.tarball
  if (typeof tarball !== 'string' || tarball === '') throw new Error(`no archive for ${name}@${version}`)
  return tarball
}

/**
 * The plugins the catalog offers that the profile does not have, or has an older version of.
 * A catalog entry the profile never installed is a new factory plugin: it is installed, not
 * skipped. An entry the profile holds at the same or a newer version is not.
 * @param {Record<string, string>} installed - the profile's plugins and their versions
 * @param {{ name: string, version: string, registry?: string }[]} catalog
 * @returns {{ name: string, version: string, registry?: string, current?: string }[]}
 */
export function outdated(installed, catalog) {
  const updates = []
  for (const entry of catalog) {
    const current = installed[entry.name]
    if (current !== undefined && !newerVersion(entry.version, current)) continue
    updates.push({ ...entry, current })
  }
  return updates
}

/**
 * The package names on the factory list the build shipped: the plugins whose install scripts
 * were already reviewed when the installer was built. Only these may bring install scripts in
 * through an update.
 * @param {string} dataDir - the data location
 * @returns {string[]}
 */
function factoryApprovedNames(dataDir) {
  try {
    const list = JSON.parse(readFileSync(join(dataDir, 'factory', 'plugins.json'), 'utf8'))
    if (!Array.isArray(list.plugins)) return []
    return list.plugins.map(entry => (typeof entry === 'string' ? entry : entry?.name)).filter(name => typeof name === 'string')
  } catch {
    return []
  }
}

/** The npm lifecycle hooks that run code when a package is installed. */
const INSTALL_SCRIPT_KEYS = ['preinstall', 'install', 'postinstall']

/** Parse a version into comparable parts; null when it is not three dot-separated numbers. */
function parseVersionParts(version) {
  const core = String(version ?? '').replace(/^v/u, '').split(/-(.*)/su)[0]
  const parts = core.split('.')
  if (parts.length !== 3 || parts.some(part => !/^\d+$/u.test(part))) return null
  return parts.map(part => Number(part))
}

/**
 * Whether one comparison like `>=0.2.2`, `^0.2.0`, `~0.2.0` or `0.2.2` holds for the version.
 * @param {number[]} parts - the host version's three numbers
 * @param {string} operator @param {string} target
 */
function holdsComparison(parts, operator, target) {
  const targetParts = parseVersionParts(target)
  if (targetParts === null) return false
  for (let index = 0; index < 3; index += 1) {
    if (parts[index] !== targetParts[index]) break
  }
  const compare = (left, right) => left[0] !== right[0] ? left[0] - right[0] : left[1] !== right[1] ? left[1] - right[1] : left[2] - right[2]
  const order = compare(parts, targetParts)
  if (operator === '^') return order >= 0 && parts[0] === targetParts[0]
  if (operator === '~') return order >= 0 && parts[0] === targetParts[0] && parts[1] === targetParts[1]
  if (operator === '>=') return order >= 0
  if (operator === '>') return order > 0
  if (operator === '<=') return order <= 0
  if (operator === '<') return order < 0
  return order === 0
}

/**
 * Whether the host version satisfies a semver range like `^0.2.0 || >=0.3.0`. The subset npm
 * plugins actually declare: `^`, `~`, `>=`, `>`, `<=`, `<`, exact, joined by spaces (and) or
 * `||` (or). An unparseable range refuses the update, since it says nothing we can check.
 * @param {string} hostVersion - the DSH version this app runs
 * @param {string} range - the range the plugin declares
 */
export function satisfiesDshRange(hostVersion, range) {
  const parts = parseVersionParts(hostVersion)
  if (parts === null) return false
  for (const alternative of String(range).split('||')) {
    const comparisons = alternative.trim().split(/\s+/u).filter(part => part !== '')
    if (comparisons.length === 0) continue
    if (comparisons.every(comparison => {
      const match = /^(\^|~|>=|>|<=|<)?\s*(.+)$/u.exec(comparison)
      return match !== null && holdsComparison(parts, match[1] ?? '=', match[2])
    })) return true
  }
  return false
}

/**
 * Put a newer copy of a plugin in place.
 *
 * The new copy is unpacked into a staging folder and checked there: the archive has to carry the
 * version the catalog named, or it is refused and nothing is touched. The old copy is moved to a
 * backup folder and the staged one is moved into its place; if that move fails the old copy is
 * put back.
 *
 * @param {object} options
 * @param {string} options.dataDir - the data location
 * @param {string} options.profileDir - the profile directory
 * @param {string} options.name - the package name
 * @param {string} options.version - the version the catalog named
 * @param {Buffer} options.archive - the archive
 * @param {string} [options.hostVersion] - the DSH version this app runs, for `engines.dsh`
 * @returns {Promise<{ updated: boolean, incompatible?: boolean, reason?: string }>}
 */
export async function installUpdate({ dataDir, profileDir, name, version, archive, hostVersion }) {
  const staging = join(stagingDir(dataDir), name.replace(/[\\/]/gu, '__'))
  const backup = join(backupDir(dataDir), name.replace(/[\\/]/gu, '__'))
  const target = join(profileDir, 'node_modules', ...name.split('/'))
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  try {
    await unpackTgz(archive, staging, join(staging, 'node_modules'))
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    return { updated: false, reason: `unpack failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  // The archive has to carry the version the catalog named: an archive of another version would
  // silently move the plugin backwards.
  const manifestPath = join(staging, 'package.json')
  let stagedVersion
  try {
    stagedVersion = JSON.parse(await readFile(manifestPath, 'utf8')).version
  } catch {
    stagedVersion = undefined
  }
  if (stagedVersion !== version) {
    await rm(staging, { recursive: true, force: true })
    return { updated: false, reason: `the archive carries ${String(stagedVersion)}, not ${version}` }
  }
  // Gate: the archive has to declare itself a DSH plugin. An archive without the manifest
  // cannot be checked against anything the Host understands, and the factory distributes
  // DSH plugins only.
  let stagedManifest
  try {
    stagedManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch {
    stagedManifest = undefined
  }
  if (stagedManifest?.dsh === undefined) {
    await rm(staging, { recursive: true, force: true })
    return { updated: false, reason: 'the archive does not declare itself a DSH plugin (no dsh manifest)' }
  }
  // Gate: install scripts never run here — the unpacker only writes files — but a new copy
  // that starts carrying them is a change the factory has not reviewed. Only plugins on the
  // shipped factory list may bring install scripts through an update.
  const scripts = stagedManifest?.scripts ?? {}
  const installScripts = INSTALL_SCRIPT_KEYS.filter(key => typeof scripts[key] === 'string' && scripts[key] !== '')
  if (installScripts.length > 0 && !factoryApprovedNames(dataDir).includes(name)) {
    await rm(staging, { recursive: true, force: true })
    return { updated: false, reason: `${name} carries install scripts (${installScripts.join(', ')}) and is not on the factory list` }
  }
  // Gate: the compatibility the plugin declares in `engines.dsh`. #12 calls this the one risky
  // step of the whole case: an update that the running DSH does not satisfy is skipped, not
  // counted as a failure, so it is looked at again the next day.
  const dshRange = stagedManifest?.engines?.dsh
  if (typeof dshRange === 'string' && dshRange !== '' && hostVersion !== undefined && !satisfiesDshRange(hostVersion, dshRange)) {
    await rm(staging, { recursive: true, force: true })
    return { updated: false, incompatible: true, reason: `${name} declares engines.dsh ${dshRange}, but this app runs DSH ${hostVersion}` }
  }
  await rm(backup, { recursive: true, force: true })
  await mkdir(backupDir(dataDir), { recursive: true })
  const had = existsSync(target)
  if (had) await rename(target, backup)
  try {
    await mkdir(join(target, '..'), { recursive: true })
    await rename(staging, target)
  } catch (error) {
    // The swap failed: the old copy goes back, so the profile keeps what it had.
    if (had) await rename(backup, target).catch(() => {})
    await rm(staging, { recursive: true, force: true })
    return { updated: false, reason: `the swap failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  await rm(backup, { recursive: true, force: true })
  return { updated: true }
}

/**
 * Record a newly installed plugin in the profile's manifest: the dependency the profile owns and
 * the bundle list entry that makes DSH load it.
 * @param {object} options
 * @param {string} options.profileDir - the profile directory
 * @param {string} options.name - the package name
 * @param {string} options.version - the version installed
 * @returns {Promise<void>}
 */
async function recordInstalledPlugin({ profileDir, name, version }) {
  const manifestPath = join(profileDir, 'package.json')
  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch {
    manifest = { name: `dsh-profile-${PROFILE}`, private: true, dependencies: {} }
  }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  manifest.dependencies = { ...manifest.dependencies ?? {}, [name]: version }
  if (!bundles.includes(name)) {
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...bundles, name] } }
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8')
}

/**
 * Update the profile's plugins from the catalog.
 *
 * @param {object} options
 * @param {string} options.dataDir - the data location
 * @param {string} options.profileDir - the profile directory
 * @param {string} [options.catalogUrl] - the catalog url
 * @param {string} [options.hostVersion] - the DSH version this app runs, for `engines.dsh`
 * @param {typeof fetch} [options.fetch] - the fetch to use
 * @param {Console} [options.log] - where the outcome is written
 * @returns {Promise<{ checked: boolean, updated: string[], installed: string[], failed: string[], skipped: string[], leftAlone: string[], reason?: string }>}
 */
export async function updateFactoryPlugins({ dataDir, profileDir, catalogUrl = CATALOG_URL, hostVersion, fetch: fetchImpl = globalThis.fetch, log = console }) {
  const result = { checked: false, updated: [], installed: [], failed: [], skipped: [], leftAlone: [] }
  const state = await readState(dataDir)
  const today = dayOf()
  if (state.day === today) {
    result.reason = 'already checked today'
    return result
  }
  let catalog
  try {
    catalog = await readCatalog(catalogUrl, fetchImpl)
  } catch (error) {
    result.reason = `the catalog could not be read: ${error instanceof Error ? error.message : String(error)}`
    log.error(`LinkHarness: ${result.reason}`)
    return result
  }
  result.checked = true
  const installed = await installedPlugins(profileDir)
  const updates = outdated(installed, catalog)
  // A plugin the profile holds that the catalog no longer names is left alone: the factory
  // stopped distributing it, but removing it would take away something the reader may use.
  result.leftAlone = Object.keys(installed).filter(name => !catalog.some(entry => entry.name === name))
  const failures = { ...state.failures }
  for (const update of updates) {
    const count = failures[update.name] ?? 0
    if (count >= FAILURE_LIMIT) {
      result.skipped.push(update.name)
      continue
    }
    const isNew = update.current === undefined
    try {
      const url = await archiveUrl(update.name, update.version, update.registry ?? NPM_REGISTRY, fetchImpl)
      const response = await fetchImpl(url)
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      const archive = Buffer.from(await response.arrayBuffer())
      const outcome = await installUpdate({ dataDir, profileDir, name: update.name, version: update.version, archive, hostVersion })
      if (outcome.updated) {
        delete failures[update.name]
        // A new factory plugin has to be recorded, or DSH never loads it: the manifest gains
        // the dependency and the bundle list gains the name. An update of an installed plugin
        // never touches the manifest, so a plugin the reader turned off stays off.
        if (isNew) await recordInstalledPlugin({ profileDir, name: update.name, version: update.version })
        result[isNew ? 'installed' : 'updated'].push(update.name)
        log.info(`LinkHarness: plugin ${update.name} ${isNew ? 'installed' : 'updated to'} ${update.version}`)
      } else if (outcome.incompatible) {
        // A plugin the running DSH cannot satisfy is skipped, not counted as a failure: #12
        // wants it looked at again the next day, when the app itself may have moved ahead.
        result.skipped.push(update.name)
        log.info(`LinkHarness: plugin ${update.name} was skipped: ${outcome.reason}`)
      } else {
        failures[update.name] = count + 1
        result.failed.push(update.name)
        log.error(`LinkHarness: plugin ${update.name} was not updated: ${outcome.reason ?? 'unknown reason'}`)
      }
    } catch (error) {
      failures[update.name] = count + 1
      result.failed.push(update.name)
      log.error(`LinkHarness: plugin ${update.name} was not updated: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  await writeState(dataDir, { day: today, failures })
  return result
}

/**
 * Run the daily check when it is due, and keep running it on the hour.
 *
 * The check itself is guarded by the state file, so a restart on the same day does not repeat it.
 *
 * @param {object} options
 * @param {string} options.dataDir - the data location
 * @param {string} options.profileDir - the profile directory
 * @param {() => string} options.profileDirOf - where the profile lives, read when the check runs
 * @param {string} [options.catalogUrl] - the catalog url
 * @param {() => string} [options.hostVersionOf] - the DSH version this app runs, read when the check runs
 * @param {typeof fetch} [options.fetch] - the fetch to use
 * @param {Console} [options.log] - where the outcome is written
 * @param {(updated: string[]) => void} [options.onUpdated] - told when plugins were replaced
 * @returns {{ stop: () => void, check: () => Promise<void> }}
 */
export function watchFactoryPlugins({ dataDir, profileDirOf, catalogUrl, hostVersionOf, fetch: fetchImpl, log = console, onUpdated }) {
  const HOUR_MS = 60 * 60_000
  let busy = false
  const check = async () => {
    if (busy) return
    if (!dueForCheck()) return
    busy = true
    try {
      const outcome = await updateFactoryPlugins({
        dataDir,
        profileDir: profileDirOf(),
        catalogUrl,
        hostVersion: hostVersionOf?.(),
        fetch: fetchImpl,
        log,
      })
      if (outcome.updated.length > 0 && onUpdated !== undefined) onUpdated(outcome.updated)
    } finally {
      busy = false
    }
  }
  const timer = setInterval(() => { void check() }, HOUR_MS)
  timer.unref?.()
  void check()
  return { stop: () => { clearInterval(timer) }, check }
}
