// The import plugin's target session format.
//
// The plugin writes a tool result's role the way the target format asks: V4 says "tool", the
// older generation says "user". The host's own rule is "tool" for both, so a session that goes
// out in the older shape is refused whole ("message must have role \"tool\"").
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
// The plugin keeps this helper in a module of its own, and the package's "exports" does not
// name it, so it is reached by its path inside the package. A plugin release that moves it
// breaks this: the import then runs without the stated version and fails as it did before,
// which is logged. Nothing here may stop the start.
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// The host's session format version this app writes. The catalog says 4.
export const HOST_SESSION_VERSION = 4

/**
 * The plugin's helper that runs an import with a stated target format version.
 * @param {string} profileDir - the profile directory the plugin was installed into
 * @returns {Promise<((ctx: unknown, version: number, fn: () => Promise<unknown>) => Promise<unknown>) | undefined>}
 */
export async function loadFormatRunner(profileDir) {
  try {
    const require = createRequire(join(profileDir, 'package.json'))
    const manifest = require.resolve('dsh-chat-import/package.json')
    const module = join(dirname(manifest), 'lib', 'import-core.mjs')
    if (!existsSync(module)) return undefined
    const loaded = await import(pathToFileURL(module).href)
    return typeof loaded.withHostFormatVersion === 'function' ? loaded.withHostFormatVersion : undefined
  } catch {
    // The plugin is not there, or it moved its files: the import runs without a stated version.
    return undefined
  }
}
