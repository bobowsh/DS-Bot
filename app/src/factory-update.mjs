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
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { unpackTgz, newerVersion } from './import-plugin.mjs'

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
 * The plugins the catalog offers that the profile holds an older version of.
 * @param {Record<string, string>} installed - the profile's plugins and their versions
 * @param {{ name: string, version: string, registry?: string }[]} catalog
 * @returns {{ name: string, version: string, registry?: string, current: string }[]}
 */
export function outdated(installed, catalog) {
  const updates = []
  for (const entry of catalog) {
    const current = installed[entry.name]
    if (current === undefined) continue
    if (!newerVersion(entry.version, current)) continue
    updates.push({ ...entry, current })
  }
  return updates
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
 * @returns {Promise<{ updated: boolean, reason?: string }>}
 */
export async function installUpdate({ dataDir, profileDir, name, version, archive }) {
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
 * Update the profile's plugins from the catalog.
 *
 * @param {object} options
 * @param {string} options.dataDir - the data location
 * @param {string} options.profileDir - the profile directory
 * @param {string} [options.catalogUrl] - the catalog url
 * @param {typeof fetch} [options.fetch] - the fetch to use
 * @param {Console} [options.log] - where the outcome is written
 * @returns {Promise<{ checked: boolean, updated: string[], failed: string[], skipped: string[], reason?: string }>}
 */
export async function updateFactoryPlugins({ dataDir, profileDir, catalogUrl = CATALOG_URL, fetch: fetchImpl = globalThis.fetch, log = console }) {
  const result = { checked: false, updated: [], failed: [], skipped: [] }
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
    log.error(`LinkBot: ${result.reason}`)
    return result
  }
  result.checked = true
  const installed = await installedPlugins(profileDir)
  const updates = outdated(installed, catalog)
  const failures = { ...state.failures }
  for (const update of updates) {
    const count = failures[update.name] ?? 0
    if (count >= FAILURE_LIMIT) {
      result.skipped.push(update.name)
      continue
    }
    try {
      const url = await archiveUrl(update.name, update.version, update.registry ?? NPM_REGISTRY, fetchImpl)
      const response = await fetchImpl(url)
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      const archive = Buffer.from(await response.arrayBuffer())
      const outcome = await installUpdate({ dataDir, profileDir, name: update.name, version: update.version, archive })
      if (outcome.updated) {
        delete failures[update.name]
        result.updated.push(update.name)
        log.info(`LinkBot: plugin ${update.name} updated to ${update.version}`)
      } else {
        failures[update.name] = count + 1
        result.failed.push(update.name)
        log.error(`LinkBot: plugin ${update.name} was not updated: ${outcome.reason ?? 'unknown reason'}`)
      }
    } catch (error) {
      failures[update.name] = count + 1
      result.failed.push(update.name)
      log.error(`LinkBot: plugin ${update.name} was not updated: ${error instanceof Error ? error.message : String(error)}`)
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
 * @param {typeof fetch} [options.fetch] - the fetch to use
 * @param {Console} [options.log] - where the outcome is written
 * @param {(updated: string[]) => void} [options.onUpdated] - told when plugins were replaced
 * @returns {{ stop: () => void, check: () => Promise<void> }}
 */
export function watchFactoryPlugins({ dataDir, profileDirOf, catalogUrl, fetch: fetchImpl, log = console, onUpdated }) {
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
