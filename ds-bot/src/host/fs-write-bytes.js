// Writing a file's bytes back through the host's filesystem service.
//
// The service is the only way into a file: the sandbox backend fences every call, so a
// Bot with the read-only preset still cannot write. Raw bytes go through `writeBytes`,
// which DSH does not ship — app/scripts/fs-writebytes-patch.mjs adds it, reusing the
// host's own atomic publication, its per-target lock and its Windows DACL. This file
// never opens a file itself, so there is no second atomic write to race the host's.
//
// The encoding helpers are in encoding.js; the tools that use them are in
// fs-write-tool.js.

/** The failure code for a write refused because the host cannot carry bytes. */
export const ENCODING_UNSUPPORTED = 'FS_ENCODING_UNSUPPORTED'

/**
 * The per-call sandbox policy, resolved the way the host's own write/edit resolve it.
 *
 * Passing it through matters: the policy carries the Session's standing mode (and any
 * approved escalation), and without it the sandbox backend would fall back to the
 * deployment default — wider than a read-only Session is entitled to.
 *
 * @param {object} ctx the plugin context
 * @param {object} [exec] the tool-execution context
 * @returns {object | undefined} the policy, or undefined when nothing confines
 */
export function sandboxPolicyOf(ctx, exec) {
  // No confining backend: the host's tools pass nothing either.
  if (ctx?.fs?.sandboxMode === undefined) return undefined
  const policy = ctx.get?.('sandboxPolicy')
  if (policy === undefined) return undefined
  return policy.resolve({ ...(exec?.agent ? { session: exec.agent.session } : {}) })
}

/**
 * Whether the host's filesystem service can write raw bytes at all.
 *
 * @param {object} fs the host's filesystem service
 * @returns {boolean}
 */
export function canWriteBytes(fs) {
  return typeof fs?.writeBytes === 'function'
}

/**
 * Write bytes to a path through the host's filesystem service.
 *
 * @param {object} fs the host's filesystem service
 * @param {string} path the path to write
 * @param {Uint8Array} bytes the exact bytes to publish
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {object} [options.sandboxPolicy] the per-call policy from {@link sandboxPolicyOf}
 * @returns {Promise<{ target: object, outcome: object }>}
 */
export async function writeBytesThrough(fs, path, bytes, { signal, sandboxPolicy } = {}) {
  if (!canWriteBytes(fs)) {
    const error = new Error(`${ENCODING_UNSUPPORTED}: this host cannot write file bytes, so a non-UTF-8 file cannot be saved in its own encoding. Convert the file to UTF-8, or install a build carrying the writeBytes patch.`)
    error.code = ENCODING_UNSUPPORTED
    throw error
  }
  const target = await fs.resolve(path, { signal })
  // The expected intent is left out: this tool replaces the whole file, as the host's
  // write does without a guard.
  const outcome = await fs.writeBytes(target, bytes, undefined, signal, sandboxPolicy)
  return { target, outcome }
}
