// The import plugin, put into the profile the way a plugin the user installed would be.
//
// The plugin travels with the installer as a plain folder in the data directory and is copied
// into the profile's own node_modules on every start, so the install never reaches the network
// and an updated app brings an updated plugin. It is deliberately not a dependency of the app:
// a package the app itself provides is shown as part of the installation and offers no switch,
// while one the profile owns is a plugin the user may turn off in the plugin manager.
//
// The plugin manager removes a bundle from the profile's bundle list when the user turns it off
// and leaves the package in the profile's dependencies. The app reads that: a plugin the profile
// depends on but does not list was turned off, and putting it back would undo the choice.
//
// The package is copied, not linked: the profile's node_modules belongs to the profile, and the
// files in the data directory are read once at the start.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export const PLUGIN_NAME = 'dsh-chat-import'

/** Where a plugin is put inside the profile. */
const pluginDir = (profileDir, name) => join(profileDir, 'node_modules', ...name.split('/'))



/** The profile's manifest, or undefined when it cannot be read. */
async function readManifest(profileDir) {
  try {
    return JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/** The version a package directory holds, or undefined. */
async function packageVersion(dir) {
  try {
    return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).version
  } catch {
    return undefined
  }
}



/**
 * Whether `a` is a newer version than `b`. A pre-release is older than the release it leads to,
 * and a pre-release is compared by its own parts. The same rule the app's own update check uses.
 * @param {string} a @param {string} b
 */
export function newerVersion(a, b) {
  const parse = (value) => {
    const [core, pre] = String(value ?? '').replace(/^v/u, '').split(/-(.*)/su)
    return { nums: core.split('.').map(part => Number(part) || 0), pre: pre ?? null }
  }
  const x = parse(a)
  const y = parse(b)
  for (let index = 0; index < 3; index += 1) if (x.nums[index] !== y.nums[index]) return x.nums[index] > y.nums[index]
  if (x.pre === y.pre) return false
  if (x.pre === null) return true
  if (y.pre === null) return false
  return x.pre.localeCompare(y.pre, 'en', { numeric: true }) > 0
}

/**
 * Put a bundled plugin into the profile and add it to the profile's bundle list.
 *
 * The bundle list is only touched the first time: the plugin manager removes a bundle from the
 * list when the user turns it off, and the profile keeps it in its dependencies, so the app can
 * tell the two apart. A user who removes the plugin instead of turning it off has it installed
 * again on the next start: the app keeps the feature there, and turning it off is the way to
 * keep it from running.
 *
 * @param {object} options
 * @param {string} options.profileDir - the profile directory
 * @param {string} options.folder - the plugin's folder in the data directory
 * @param {string} [options.name] - the package name, when it is not the import plugin
 * @param {string} [options.version] - the folder's version, when the caller knows it
 * @returns {Promise<{ installed: boolean, updated: boolean, listed: boolean }>}
 */
export async function installImportPlugin({ profileDir, folder, name = PLUGIN_NAME, version }) {
  const target = pluginDir(profileDir, name)
  const targetVersion = await packageVersion(target)
  // The version is read from the folder's own manifest, so a start that finds nothing to do
  // reads one small file instead of copying hundreds.
  const sourceVersion = version ?? await packageVersion(folder)
  if (sourceVersion === undefined) return { installed: false, updated: false, listed: false }
  // The profile is made by the Host when it boots, and the app puts the plugin there before
  // that. The profile's own files are written here as well, so the plugin has a place to live
  // and the Host finds the profile already there.
  await mkdir(profileDir, { recursive: true })
  await mkdir(join(profileDir, 'node_modules'), { recursive: true })
  const manifest = await readManifest(profileDir) ?? { name: `dsh-profile-${basename(profileDir)}`, private: true, dependencies: {} }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const dependencies = manifest.dependencies ?? {}
  const known = Object.hasOwn(dependencies, name)
  const listed = bundles.includes(name)
  // The copy is refreshed when the installer carries a newer plugin. A copy that is already the
  // same version is left alone, and so is one that is newer than the installer (a user who put
  // a newer plugin in place keeps it).
  const updated = targetVersion !== sourceVersion && newerVersion(sourceVersion, targetVersion ?? '0.0.0')
  if (!existsSync(target) || updated) {
    if (existsSync(target)) await rm(target, { recursive: true, force: true })
    if (!existsSync(folder)) return { installed: false, updated: false, listed: false }
    // The plugin's own dependencies travel in the folder's node_modules; they belong beside
    // the plugin in the profile, where Node resolves a package's imports from. A plugin
    // without dependencies has no such folder.
    if (existsSync(join(folder, 'node_modules'))) {
      await cp(join(folder, 'node_modules'), join(profileDir, 'node_modules'), { recursive: true })
    }
    await cp(folder, target, { recursive: true })
  }
  // The profile owns the plugin: it is one of the profile's dependencies, not of the app's.
  manifest.dependencies = { ...dependencies, [name]: sourceVersion }
  if (!known && !listed) {
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...bundles, name] } }
  }
  await writeFile(join(profileDir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8')
  return { installed: true, updated, listed: !known && !listed }
}
