// Detecting the encoding of a text file, and decoding it.
//
// The order is fixed:
//   1. A BOM names the encoding outright.
//   2. Without a BOM, strict UTF-8 decoding decides.
//   3. Failing that, the bytes are probed for a Chinese encoding.
//
// The decoder is iconv-lite, which covers the encodings a Chinese-language file
// carries: utf-8, utf-16le, utf-16be, gb18030, gbk, big5.
//
// The tool that uses this is in fs-read-tool.js; it reads the bytes through the
// host's filesystem service, so the sandbox fence still holds.

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// Lazy require: the codec is a runtime dependency of the plugin.
let iconv, chardet
const iconvOf = () => (iconv ??= require('iconv-lite'))
const chardetOf = () => (chardet ??= require('chardet'))

/** The encodings the tools accept. Everything else is refused by name. */
export const SUPPORTED_ENCODINGS = ['utf-8', 'utf-8-bom', 'utf-16le', 'utf-16be', 'gb18030', 'gbk', 'big5']

const BOM_UTF8 = [0xEF, 0xBB, 0xBF]
const BOM_UTF16LE = [0xFF, 0xFE]
const BOM_UTF16BE = [0xFE, 0xFF]
const BOMS = [
  ['utf-8-bom', BOM_UTF8],
  ['utf-16le', BOM_UTF16LE],
  ['utf-16be', BOM_UTF16BE],
]

const hasBom = (bytes, bom) => bom.every((byte, at) => bytes[at] === byte)
const bomOf = (bytes) => BOMS.find(([, bom]) => hasBom(bytes, bom))?.[0]

const DECODE_NAME = { 'utf-8': 'utf-8', 'utf-8-bom': 'utf-8', 'utf-16le': 'utf-16-le', 'utf-16be': 'utf-16-be', gb18030: 'gb18030', gbk: 'gbk', big5: 'big5' }
const ENCODE_NAME = { ...DECODE_NAME, gbk: 'gbk' }

const fail = (code, message) => { const e = new Error(`${code}: ${message}`); e.code = code; throw e }

// Whether the bytes look binary: a NUL byte in the head is the cheapest solid
// signal, and text encodings never carry one in prose files.
const looksBinary = (bytes) => bytes.subarray(0, 8000).includes(0)

// chardet needs enough prose to score a CJK encoding; short strings confuse it
// into Latin guesses, so detection samples up to this many bytes.
const DETECT_SAMPLE_BYTES = 64 * 1024

/**
 * Detect the encoding of a whole file's bytes: BOM first, then strict UTF-8,
 * then the chardet fallback for GB18030/Big5-style files.
 *
 * @param {Uint8Array} bytes
 * @returns {string | undefined} the encoding, or undefined when the file is not text
 */
export function detectEncodingFromBytes(bytes) {
  const bom = bomOf(bytes)
  if (bom !== undefined) return bom
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return 'utf-8'
  } catch { /* not UTF-8; probe below */ }
  if (looksBinary(bytes)) return undefined
  const guessed = chardetOf().detect(bytes.subarray(0, DETECT_SAMPLE_BYTES)) ?? null
  const name = typeof guessed === 'string' ? guessed.toLowerCase().replace(/[^a-z0-9-]/g, '') : ''
  if (name === 'utf-8' || name === 'ascii' || name === 'us-ascii') return 'utf-8'
  if (name.includes('18030') || name === 'gbk' || name === 'gb2312' || name === 'gb231280') return 'gb18030'
  if (name === 'big5') return 'big5'
  if (name === 'utf-16le' || name === 'utf-16-le') return 'utf-16le'
  if (name === 'utf-16be' || name === 'utf-16-be') return 'utf-16be'
  // Short CJK files make chardet guess a Latin single-byte set; when the bytes
  // decode as GB18030 without replacement characters and carry CJK, that is
  // what they are. A Latin single-byte decode of CJK bytes shows mojibake. A
  // control byte (as binary formats carry) rules the file out regardless.
  if (!name.includes('utf-16')) {
    try {
      const text = iconvOf().decode(bytes, 'gb18030')
      const cjk = (text.match(/[㐀-鿿豈-﫿]/g) ?? []).length
      const hasControl = [...text].some(ch => {
        const unit = ch.codePointAt(0)
        return (unit <= 0x08 || unit === 0x0b || unit === 0x0c || (unit >= 0x0e && unit <= 0x1f))
      })
      if (cjk > 0 && !text.includes('�') && !hasControl) return 'gb18030'
    } catch { /* not GB18030 either */ }
  }
  return undefined
}

/**
 * Decode whole file bytes to text, stripping a BOM when present.
 *
 * @param {Uint8Array} bytes
 * @param {string} encoding
 * @returns {string}
 */
export function decodeBytes(bytes, encoding) {
  const name = DECODE_NAME[encoding]
  if (name === undefined) fail('FS_NOT_TEXT', `unsupported encoding "${encoding}"`)
  const bom = bomOf(bytes)
  const body = bom !== undefined ? bytes.subarray(BOMS.find(([label]) => label === bom)[1].length) : bytes
  return iconvOf().decode(body, name)
}

/**
 * Encode text back to bytes in the given encoding, adding the BOM that encoding
 * keeps (UTF-8 BOM only when the caller says the file had one or the caller
 * asked for `utf-8-bom`; UTF-16 always carries its BOM).
 *
 * @param {string} text
 * @param {string} encoding
 * @param {{ keepBom?: boolean }} [options]
 * @returns {Buffer}
 */
export function encodeText(text, encoding, { keepBom } = {}) {
  const name = ENCODE_NAME[encoding]
  if (name === undefined) fail('FS_NOT_TEXT', `unsupported encoding "${encoding}"`)
  const body = name === 'utf-8' ? Buffer.from(text, 'utf8') : iconvOf().encode(text, name)
  if (encoding === 'utf-16le') return Buffer.concat([Buffer.from(BOM_UTF16LE), body])
  if (encoding === 'utf-16be') return Buffer.concat([Buffer.from(BOM_UTF16BE), body])
  if (encoding === 'utf-8-bom' || (encoding === 'utf-8' && keepBom)) return Buffer.concat([Buffer.from(BOM_UTF8), body])
  return body
}

/**
 * The encoding a caller names, or undefined when they named none.
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function namedEncoding(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') fail('FS_NOT_TEXT', 'encoding must be a string')
  const name = value.trim().toLowerCase().replace(/_/g, '-')
  const aliases = { 'utf8': 'utf-8', 'utf8bom': 'utf-8-bom', 'utf-8bom': 'utf-8-bom', 'utf16le': 'utf-16le', 'utf-16-le': 'utf-16le', 'utf16be': 'utf-16be', 'utf-16-be': 'utf-16be', 'utf16': 'utf-16le', 'gb2312': 'gb18030', 'cp936': 'gbk', 'big5-hkscs': 'big5' }
  const picked = aliases[name] ?? name
  if (!SUPPORTED_ENCODINGS.includes(picked)) fail('FS_NOT_TEXT', `unsupported encoding "${value}" (supported: ${SUPPORTED_ENCODINGS.join(', ')})`)
  return picked
}
