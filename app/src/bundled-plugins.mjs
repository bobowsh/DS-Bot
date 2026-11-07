// The plugins the installer carries: they travel in the data directory beside the program, as
// plain folders, and the app copies them into the profile on every start.
//
// The folder name is flattened (`@scope/name` -> `scope-name`), so the package name comes from
// the folder's own manifest.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** A folder's package manifest, or undefined when it has none. */
function readManifestSync(folder) {
  try {
    return JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * The plugins the installer carries, as folders in the data directory beside the program. Each
 * folder holds the plugin and the packages it depends on.
 * @param {string} dataDir - the data directory
 * @returns {{ name: string, folder: string, version: string }[]}
 */
export function bundledPlugins(dataDir) {
  const dir = join(dataDir, 'plugins')
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const folder = join(dir, entry.name)
    const manifest = readManifestSync(folder)
    if (manifest === undefined) continue
    const name = typeof manifest.name === 'string' ? manifest.name : undefined
    const version = typeof manifest.version === 'string' ? manifest.version : undefined
    if (name === undefined || version === undefined) continue
    found.push({ name, folder, version })
  }
  return found.sort((a, b) => a.name.localeCompare(b.name, 'en'))
}

/**
 * The plugin folder the installer carries for one package, by its package name.
 * @param {string} dataDir - the data directory
 * @param {string} name - the plugin's package name
 * @returns {{ folder: string, version: string } | undefined}
 */
export function findBundledPlugin(dataDir, name) {
  return bundledPlugins(dataDir).find(entry => entry.name === name)
}
