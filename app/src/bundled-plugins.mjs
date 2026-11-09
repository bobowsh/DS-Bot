// The factory plugins the installer carries: they live in the data directory (the app's DSH
// home) under the profile's own node_modules, as plain folders. The build writes a factory list
// naming them, so the first start can tell them apart from plugins the user installed later.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The profile inside the data directory whose node_modules holds the plugins. */
export const PROFILE = 'ds-bot'

/** A folder's package manifest, or undefined when it has none. */
function readManifestSync(folder) {
  try {
    return JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/** The names on the factory list the build shipped, or [] when there is none. */
function factoryNames(dataDir) {
  try {
    const list = JSON.parse(readFileSync(join(dataDir, 'factory', 'plugins.json'), 'utf8'))
    if (!Array.isArray(list.plugins)) return []
    return list.plugins.map(p => (typeof p === 'string' ? p : p.name)).filter(n => typeof n === 'string')
  } catch {
    return []
  }
}

/**
 * The factory plugins that ship turned off: they travel with the installer, but the Host must
 * not load them until the user turns them on in the plugin manager. The build marks them on the
 * factory list itself (`disabled: true` on their entry), so the first start reads the same
 * decision the build made.
 * @param {string} dataDir - the data directory (DSH home)
 * @returns {string[]} the package names that ship off
 */
export function factoryDisabledPlugins(dataDir) {
  try {
    const list = JSON.parse(readFileSync(join(dataDir, 'factory', 'plugins.json'), 'utf8'))
    if (!Array.isArray(list.plugins)) return []
    return list.plugins.filter(entry => entry?.disabled === true).map(entry => entry.name).filter(name => typeof name === 'string')
  } catch {
    return []
  }
}

/**
 * The factory plugins the installer carries, as folders in the data directory. Only names on the
 * shipped factory list are returned, so a plugin the user installed never becomes "factory".
 * @param {string} dataDir - the data directory (DSH home)
 * @returns {{ name: string, folder: string, version: string }[]}
 */
export function bundledPlugins(dataDir) {
  const root = join(dataDir, 'profiles', PROFILE, 'node_modules')
  const found = []
  for (const name of factoryNames(dataDir)) {
    const folder = join(root, ...name.split('/'))
    const manifest = readManifestSync(folder)
    if (manifest === undefined) continue
    const version = typeof manifest.version === 'string' ? manifest.version : undefined
    if (version === undefined) continue
    found.push({ name, folder, version })
  }
  return found.sort((a, b) => a.name.localeCompare(b.name, 'en'))
}

/**
 * The factory plugin folder for one package, by its package name.
 * @param {string} dataDir - the data directory
 * @param {string} name - the plugin's package name
 * @returns {{ folder: string, version: string } | undefined}
 */
export function findBundledPlugin(dataDir, name) {
  return bundledPlugins(dataDir).find(entry => entry.name === name)
}
