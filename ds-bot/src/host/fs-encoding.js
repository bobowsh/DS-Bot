// Reading a file's bytes through the host's filesystem service.
//
// The service is the only way into a file: the sandbox backend fences every
// call, so a Bot with the read-only permission preset still cannot read outside
// its workspace. `readBytes` hands the bytes over without decoding, which is
// what the encoding layer needs.
//
// The encoding helpers themselves are in encoding.js; the tool that uses them
// is in fs-read-tool.js.

import { detectEncodingFromBytes, decodeBytes } from './encoding.js'

/** How many bytes of a file the detection reads. A text file's head is enough. */
const DETECT_BYTES = 64 * 1024
/** The most bytes one read serves. */
const MAX_READ_BYTES = 4 * 1024 * 1024

/**
 * Read a file's bytes through the host's filesystem service.
 *
 * @param {object} fs the host's filesystem service
 * @param {string} path the path to read
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ target: object, bytes: Uint8Array }>}
 */
export async function readBytesThrough(fs, path, { signal } = {}) {
  const target = await fs.resolve(path, { signal })
  const bytes = await fs.readBytes(target, signal, MAX_READ_BYTES)
  return { target, bytes }
}

/**
 * The encoding of a file's bytes, or undefined when it is not text at all.
 *
 * @param {Uint8Array} bytes
 * @returns {string | undefined}
 */
export function encodingOf(bytes) {
  return detectEncodingFromBytes(bytes.subarray(0, DETECT_BYTES))
}

/**
 * Decode a file's bytes with the given encoding.
 *
 * @param {Uint8Array} bytes
 * @param {string} encoding
 * @returns {string}
 */
export function textOf(bytes, encoding) {
  return decodeBytes(bytes, encoding)
}
