// The import plugin's target session format.
//
// The plugin writes a tool result's role the way the target format asks: V4 says "tool", the
// older generation says "user". The host's own rule is "tool" for every generation, so a
// session that goes out in the older shape is refused whole ("message must have role \"tool\"").
//
// Which shape the plugin picks depends on the host's session format version, and the plugin
// infers that from the sessions the profile already holds. A fresh profile holds none, so the
// inference finds nothing and the plugin falls back to its own default of 3 — while the host
// this app runs on writes version 4. The result is that every imported session that carries a
// tool message is refused.
//
// So the app states the version itself: the host's current one. That is not a workaround but
// the fact the plugin could not infer.
//
// The plugin remembers the version per context, so it has to be stated on the context the
// import runs on — which is why the import is run here rather than through the plugin's
// service: the service runs on the plugin's own context, and a version stated on another
// context is not seen.
//
// The plugin keeps these in modules of its own, and the package's "exports" does not name
// them, so they are reached by their path inside the package. A plugin release that moves them
// breaks this: the import then runs without a stated version and fails as it did before,
// which is logged. Nothing here may stop the start.
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// The host's session format version this app writes. The catalog says 4.
export const HOST_SESSION_VERSION = 4

/**
 * The plugin's own pieces for running one import with a stated target format version.
 *
 * @param {string} profileDir - the profile directory the plugin was installed into
 * @returns {Promise<{ importOne: Function, withVersion: Function } | undefined>}
 */
export async function loadImporter(profileDir) {
  try {
    const require = createRequire(join(profileDir, 'package.json'))
    const dir = dirname(require.resolve('dsh-chat-import/package.json'))
    const core = join(dir, 'lib', 'import-core.mjs')
    const toolkit = join(dir, 'lib', 'toolkit.mjs')
    if (!existsSync(core) || !existsSync(toolkit)) return undefined
    const [coreModule, toolkitModule] = await Promise.all([
      import(pathToFileURL(core).href),
      import(pathToFileURL(toolkit).href),
    ])
    if (typeof coreModule.withHostFormatVersion !== 'function') return undefined
    if (typeof toolkitModule.importDiscoveryItem !== 'function') return undefined
    return {
      importOne: toolkitModule.importDiscoveryItem,
      withVersion: coreModule.withHostFormatVersion,
    }
  } catch {
    // The plugin is not there, or it moved its files: the import runs without a stated version.
    return undefined
  }
}
