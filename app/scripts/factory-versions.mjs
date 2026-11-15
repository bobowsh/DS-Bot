// Resolving the version a factory plugin is packed at.
//
// Two things are needed to ship a plugin the running app can actually load, and neither can be
// guessed from the manifest alone:
//
//   1. WHICH version. The build asks the registry for `dist-tags.latest` rather than trusting a
//      pinned number in `factory.manifest.json` (the product decision of 2026-11-15: every build
//      pulls the newest copy). The manifest is only the fallback for a plugin that is not on the
//      registry at all.
//   2. WHETHER the app can load it. A newer plugin may declare `engines.dsh` — or peer-depend on
//      `@deepseek-ai/dsh` — outside the version this app pins. Installing it would produce a
//      package whose plugin the Host refuses to activate, so such a version is SKIPPED: the
//      plugin stays at the older copy the build can still ship, and the reason is logged. One
//      plugin outside its range must never fail the whole build.
//
// The compatibility question is answered by the SAME function the runtime auto-update uses
// (`satisfiesDshRange` in src/factory-update.mjs), so a package the build accepts is a package
// the update path would accept too. Its comparison ignores prerelease tags and compares the
// three numbers, which is what npm's own resolution does for the ranges these plugins declare.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { satisfiesDshRange } from '../src/factory-update.mjs'

/** The DSH packages whose versions the app pins: the first one names the host version. */
const DSH_PACKAGE = '@deepseek-ai/dsh'

/**
 * The DSH version this app runs, read from the app's own dependencies.
 *
 * It comes from `node_modules` rather than `package.json` so it is the version actually
 * installed; a build whose dependencies are missing fails here instead of packing plugins
 * against a version nobody runs.
 * @param {string} appDir - the app directory
 * @returns {{ version: string, packages: Map<string, string> }} the host version and every pinned
 *   `@deepseek-ai/dsh*` package's version
 */
export function hostDshVersion(appDir) {
  const packages = new Map()
  const read = (name) => {
    try {
      return JSON.parse(readFileSync(join(appDir, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'))
    } catch {
      return undefined
    }
  }
  // Every `@deepseek-ai/dsh*` dependency the app declares, so a plugin's peer range can be
  // checked against the package it actually names.
  const declared = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'))
  for (const name of Object.keys(declared.dependencies ?? {})) {
    if (!name.startsWith('@deepseek-ai/dsh')) continue
    const manifest = read(name)
    if (manifest?.version !== undefined) packages.set(name, manifest.version)
  }
  const host = packages.get(DSH_PACKAGE) ?? read(DSH_PACKAGE)?.version
  if (host === undefined) {
    throw new Error(`The build cannot tell which DSH version ${DSH_PACKAGE} has: app/node_modules is missing it. Install the app's dependencies before packing.`)
  }
  return { version: host, packages }
}

/**
 * Whether a plugin at this version can be loaded by the app.
 *
 * Two declarations decide it:
 *   - `engines.dsh`, the factory's own gate (the one #12 calls the risky step);
 *   - a peer dependency on `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*`, which npm would refuse to
 *     install against a host outside its range.
 *
 * A declaration that names a package this app does not carry is not a failure: the plugin may
 * peer on a package another plugin brings.
 * @param {object} manifest - the plugin's package.json
 * @param {{ version: string, packages: Map<string, string> }} host - from {@link hostDshVersion}
 * @returns {{ compatible: boolean, reason?: string }}
 */
export function compatibilityOf(manifest, host) {
  const engines = manifest?.engines ?? {}
  if (typeof engines.dsh === 'string' && engines.dsh !== '' && !satisfiesDshRange(host.version, engines.dsh)) {
    return { compatible: false, reason: `declares engines.dsh ${engines.dsh}, but this app runs DSH ${host.version}` }
  }
  for (const [name, range] of Object.entries(manifest?.peerDependencies ?? {})) {
    if (!name.startsWith('@deepseek-ai/dsh')) continue
    const installed = host.packages.get(name)
    // Not carried here: nothing to compare, and refusing on it would drop plugins that peer on
    // packages our own composition may mount another way.
    if (installed === undefined) continue
    if (!satisfiesDshRange(installed, String(range))) {
      return { compatible: false, reason: `peer-depends on ${name} ${range}, but this app carries ${installed}` }
    }
  }
  return { compatible: true }
}

/**
 * The newest published version of a package, from the registry's `dist-tags.latest`.
 *
 * One short request per plugin. A registry that cannot answer is reported as such rather than
 * guessed at: the caller falls back to the version the manifest pins and logs why.
 * @param {string} name - the package name
 * @param {string} registry - the registry root
 * @param {number} [timeoutMs]
 * @returns {Promise<{ version: string } | { error: string }>}
 */
export async function latestVersion(name, registry, timeoutMs = 4000) {
  // The registry root may be a git-host npm endpoint that expects the package path appended.
  const base = registry.endsWith('/') ? registry : `${registry}/`
  const url = `${base}${name.replace('/', '%2f')}`
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return { error: `the registry answered ${response.status}` }
    const body = await response.json()
    const version = body?.['dist-tags']?.latest
    if (typeof version !== 'string' || version === '') return { error: 'the registry published no dist-tags.latest' }
    return { version }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Whether `candidate` is a newer version than `pinned`.
 *
 * The registry's `latest` tag is NOT reliably the newest version: a package republished as a
 * placeholder under an older mirror can point `latest` at something far behind what we already
 * ship (measured 2026-11-15: npmmirror serves `dsh-aide` only as `0.0.0-stage` and calls that
 * latest, while npmjs has `0.12.0`). Taking that would silently DOWNGRADE a plugin, which is
 * worse than not updating it. So a candidate is used only when it is strictly newer.
 *
 * Prerelease tags are compared the way {@link satisfiesDshRange} compares them — by the three
 * numbers — because that is the comparison the rest of the factory already uses.
 * @param {string} candidate - the version the registry calls latest
 * @param {string} pinned - the version the manifest promises
 * @returns {boolean}
 */
export function isNewer(candidate, pinned) {
  const parts = (version) => {
    const core = String(version ?? '').replace(/^v/u, '').split(/-(.*)/su)[0]
    const pieces = core.split('.')
    if (pieces.length !== 3 || pieces.some(piece => !/^\d+$/u.test(piece))) return null
    return pieces.map(Number)
  }
  const left = parts(candidate)
  const right = parts(pinned)
  if (left === null || right === null) return false
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index]
  }
  return false
}

/**
 * The versions to try for one manifest entry, newest first.
 *
 * `latest` is the answer when the registry publishes one that is actually newer; the pinned
 * version follows so a plugin whose newest copy is incompatible still ships at the version the
 * manifest promises. A `latest` that is not newer is ignored outright — see {@link isNewer}.
 * @param {string} pinned - the version `factory.manifest.json` names
 * @param {string | undefined} latest - what the registry published, when it answered
 * @returns {string[]}
 */
export function candidatesFor(pinned, latest) {
  if (latest === undefined || latest === pinned || !isNewer(latest, pinned)) return [pinned]
  return [latest, pinned]
}
