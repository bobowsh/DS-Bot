// The import plugin, put into the profile the way a plugin the user installed would be.
//
// The plugin travels with the installer and is copied into the profile's own node_modules on
// every start, so the install never reaches the network and an updated app brings an updated
// plugin. It is deliberately not a dependency of the app: a package the app itself provides is
// shown as part of the installation and offers no switch, while one the profile owns is a plugin
// the user may turn off in the plugin manager.
//
// The profile keeps the plugin's files, so the copy is refreshed when the installer carries a
// newer one. A plugin the user turned off is left alone: turning it off stays off.
//
// The package is copied, not linked: the profile's node_modules belongs to the profile, and the
// files inside the asar are read once at the start.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { optionalBundles } from './profile.mjs'

export const PLUGIN_NAME = 'dsh-chat-import'

/** Where the plugin is put inside the profile. */
const pluginDir = profileDir => join(profileDir, 'node_modules', PLUGIN_NAME)

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
 * Put the plugin into the profile and add it to the profile's bundle list.
 *
 * The bundle list is only touched when the plugin is not in it yet: the plugin manager removes a
 * bundle from the list when the user turns it off, and putting it back would undo that.
 *
 * @param {object} options
 * @param {string} options.profileDir - the profile directory
 * @param {string} options.sourceDir - the plugin's directory inside the installation
 * @returns {Promise<{ installed: boolean, updated: boolean, listed: boolean }>}
 */
export async function installImportPlugin({ profileDir, sourceDir }) {
  const manifest = await readManifest(profileDir)
  if (manifest === undefined) return { installed: false, updated: false, listed: false }
  const listed = (manifest.dsh?.profile?.bundles ?? []).includes(PLUGIN_NAME)
  // A plugin the user turned off in the plugin manager stays off: the app does not put it back
  // into the list, and does not refresh its files either.
  const turnedOff = optionalBundles(profileDir).turnedOff.includes(PLUGIN_NAME)
  const sourceVersion = await packageVersion(sourceDir)
  if (sourceVersion === undefined) return { installed: false, updated: false, listed }
  const target = pluginDir(profileDir)
  const targetVersion = await packageVersion(target)
  // The copy is refreshed when the installer carries a newer plugin. A copy that is already the
  // same version is left alone, and so is one that is newer than the installer (a user who put
  // a newer plugin in place keeps it).
  const updated = targetVersion !== sourceVersion && newerVersion(sourceVersion, targetVersion ?? '0.0.0')
  if (!existsSync(target) || updated) {
    await mkdir(join(profileDir, 'node_modules'), { recursive: true })
    if (existsSync(target)) await rm(target, { recursive: true, force: true })
    await cp(sourceDir, target, { recursive: true })
  }
  // The profile owns the plugin: it is one of the profile's dependencies, not of the app's.
  const dependencies = { ...(manifest.dependencies ?? {}) }
  if (dependencies[PLUGIN_NAME] !== sourceVersion) dependencies[PLUGIN_NAME] = sourceVersion
  if (!listed && !turnedOff) {
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...(manifest.dsh?.profile?.bundles ?? []), PLUGIN_NAME] } }
  }
  manifest.dependencies = dependencies
  await writeFile(join(profileDir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8')
  return { installed: true, updated, listed: !listed && !turnedOff }
}
