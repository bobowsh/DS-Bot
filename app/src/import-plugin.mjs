// The import plugin, put into the profile the way a plugin the user installed would be.
//
// The plugin travels with the installer and is copied into the profile's own node_modules on
// every start, so the install never reaches the network and an updated app brings an updated
// plugin. It is deliberately not a dependency of the app: a package the app itself provides is
// shown as part of the installation and offers no switch, while one the profile owns is a plugin
// the user may turn off in the plugin manager.
//
// The plugin manager removes a bundle from the profile's bundle list when the user turns it off
// and leaves the package in the profile's dependencies. The app reads that: a plugin the profile
// depends on but does not list was turned off, and putting it back would undo the choice.
//
// The package is copied, not linked: the profile's node_modules belongs to the profile, and the
// files inside the asar are read once at the start.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'

export const PLUGIN_NAME = 'dsh-chat-import'

/** Where the plugin is put inside the profile. */
const pluginDir = profileDir => join(profileDir, 'node_modules', PLUGIN_NAME)

/**
 * The files of a gzipped tar, read with the zlib that Node carries: the archive is the shape npm
 * publishes, and unpacking it needs nothing else.
 * @param {Buffer} buffer - the archive
 * @returns {{ path: string, body: Buffer, directory: boolean }[]}
 */
export function readTgz(buffer) {
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
 * `package/node_modules/`. The plugin goes into the profile's own `node_modules` under its own
 * name, and its dependencies go beside it, where Node looks for them.
 * @param {Buffer} buffer - the archive
 * @param {string} into - the plugin's directory inside the profile
 * @param {string} [profileModules] - the profile's node_modules, where the dependencies go
 */
export async function unpackTgz(buffer, into, profileModules) {
  for (const entry of readTgz(buffer)) {
    // The archive's own top folder is the package: its contents go straight into the target.
    const relative = entry.path.replace(/^[^/]+\//u, '').replace(/\/+$/u, '')
    if (relative === '') continue
    const parts = relative.split('/')
    // The plugin's dependencies are packed beside it, but belong beside the plugin in the
    // profile: Node resolves a package's imports from the node_modules above it.
    const target = parts[0] === 'node_modules' && profileModules !== undefined
      ? join(profileModules, ...parts.slice(1))
      : join(into, ...parts)
    if (entry.directory) {
      await mkdir(target, { recursive: true })
      continue
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, entry.body)
  }
}

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

/** The version an archive holds, read from its manifest. */
async function archiveVersion(archive) {
  try {
    const entries = readTgz(await readFile(archive))
    const manifest = entries.find(entry => entry.path === 'package/package.json')
    return manifest === undefined ? undefined : JSON.parse(manifest.body.toString('utf8')).version
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
 * The bundle list is only touched the first time: the plugin manager removes a bundle from the
 * list when the user turns it off, and the profile keeps it in its dependencies, so the app can
 * tell the two apart. A user who removes the plugin instead of turning it off has it installed
 * again on the next start: the app keeps the feature there, and turning it off is the way to
 * keep it from running.
 *
 * @param {object} options
 * @param {string} options.profileDir - the profile directory
 * @param {string} options.archive - the plugin's archive inside the installation
 * @param {string} [options.version] - the archive's version, when the file name carries it
 * @returns {Promise<{ installed: boolean, updated: boolean, listed: boolean }>}
 */
export async function installImportPlugin({ profileDir, archive, version }) {
  const target = pluginDir(profileDir)
  const targetVersion = await packageVersion(target)
  // The version is in the archive's name, so a start that finds nothing to do reads a file name
  // instead of unpacking the archive.
  const sourceVersion = version ?? await archiveVersion(archive)
  if (sourceVersion === undefined) return { installed: false, updated: false, listed: false }
  // The profile is made by the Host when it boots, and the app puts the plugin there before
  // that. The profile's own files are written here as well, so the plugin has a place to live
  // and the Host finds the profile already there.
  await mkdir(profileDir, { recursive: true })
  await mkdir(join(profileDir, 'node_modules'), { recursive: true })
  const manifest = await readManifest(profileDir) ?? { name: `dsh-profile-${basename(profileDir)}`, private: true, dependencies: {} }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const dependencies = manifest.dependencies ?? {}
  const known = Object.hasOwn(dependencies, PLUGIN_NAME)
  const listed = bundles.includes(PLUGIN_NAME)
  // The profile depends on it but does not list it: the user turned it off.
  const turnedOff = known && !listed
  // The copy is refreshed when the installer carries a newer plugin. A copy that is already the
  // same version is left alone, and so is one that is newer than the installer (a user who put
  // a newer plugin in place keeps it).
  const updated = targetVersion !== sourceVersion && newerVersion(sourceVersion, targetVersion ?? '0.0.0')
  if (!existsSync(target) || updated) {
    if (existsSync(target)) await rm(target, { recursive: true, force: true })
    let source
    try {
      source = await readFile(archive)
    } catch {
      return { installed: false, updated: false, listed: false }
    }
    await unpackTgz(source, target, join(profileDir, 'node_modules'))
  }
  // The profile owns the plugin: it is one of the profile's dependencies, not of the app's.
  manifest.dependencies = { ...dependencies, [PLUGIN_NAME]: sourceVersion }
  if (!known && !listed) {
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...bundles, PLUGIN_NAME] } }
  }
  await writeFile(join(profileDir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8')
  return { installed: true, updated, listed: !known && !listed }
}
