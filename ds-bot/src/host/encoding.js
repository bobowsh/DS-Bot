// Encoding support for the read/write/edit tools. The host tools are UTF-8 only
// (dsh-tool-fs), so this module wraps their dispatch: a call on a plain UTF-8
// file goes through untouched, and a call that names another encoding — or
// lands on a file that is not UTF-8 — is served here with iconv-lite, without
// patching any @deepseek-ai/* package.
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, renameSync, statSync, existsSync, unlinkSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { READ_LINE_MAX } from './constants.js'

const require = createRequire(import.meta.url)

// Lazy requires: the two packages are runtime dependencies of the plugin.
let iconv, chardet
const iconvOf = () => (iconv ??= require('iconv-lite'))
const chardetOf = () => (chardet ??= require('chardet'))

// The encodings the tools accept. Everything else is refused by name, never
// silently treated as UTF-8.
export const SUPPORTED_ENCODINGS = ['utf-8', 'utf-8-bom', 'utf-16le', 'utf-16be', 'gb18030', 'gbk', 'big5']

const BOM_UTF8 = [0xEF, 0xBB, 0xBF]
const BOM_UTF16LE = [0xFF, 0xFE]
const BOM_UTF16BE = [0xFE, 0xFF]
const BOMS = [
  ['utf-8-bom', BOM_UTF8],
  ['utf-16le', BOM_UTF16LE],
  ['utf-16be', BOM_UTF16BE],
]

const hasBom = (bytes, bom) => bom.every((byte, i) => bytes[i] === byte)
const bomOf = (bytes) => BOMS.find(([, bom]) => hasBom(bytes, bom))?.[0]

const DECODE_NAME = { 'utf-8': 'utf-8', 'utf-8-bom': 'utf-8', 'utf-16le': 'utf-16-le', 'utf-16be': 'utf-16-be', gb18030: 'gb18030', gbk: 'gbk', big5: 'big5' }
// gbk is a subset spelling of gb18030 for writing; iconv treats them apart.
const ENCODE_NAME = { ...DECODE_NAME, gbk: 'gbk' }

const fail = (code, message) => { const e = new Error(`${code}: ${message}`); e.code = code; throw e }

// Whether the bytes look binary: a NUL byte in the head is the cheapest solid
// signal, and text encodings never carry one in prose files.
const looksBinary = (bytes) => bytes.subarray(0, 8000).includes(0)

// chardet needs enough prose to score a CJK encoding; short strings confuse it
// into Latin guesses, so detection samples up to this many bytes.
const DETECT_SAMPLE_BYTES = 64 * 1024

// Detect the encoding of a whole file's bytes: BOM first, then strict UTF-8,
// then the chardet fallback for GB18030/Big5-style files. Returns
// `undefined` when the file is not text at all.
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
      const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length
      const hasControl = [...text].some(ch => {
        const unit = ch.codePointAt(0)
        return (unit <= 0x08 || unit === 0x0b || unit === 0x0c || (unit >= 0x0e && unit <= 0x1f))
      })
      if (cjk > 0 && !text.includes('\ufffd') && !hasControl) return 'gb18030'
    } catch { /* not GB18030 either */ }
  }
  return undefined
}

// Decode whole file bytes to text, stripping a BOM when present.
export function decodeBytes(bytes, encoding) {
  const name = DECODE_NAME[encoding]
  if (name === undefined) fail('FS_NOT_TEXT', `unsupported encoding "${encoding}"`)
  const bom = bomOf(bytes)
  const body = bom !== undefined && hasBom(bytes, BOMS.find(([label]) => label === bom)[1]) ? bytes.subarray(BOMS.find(([label]) => label === bom)[1].length) : bytes
  return iconvOf().decode(body, name)
}

// Encode text back to bytes in the given encoding, adding the BOM that
// encoding keeps (UTF-8 BOM only when the caller says the file had one or the
// caller asked for `utf-8-bom`; UTF-16 always carries its BOM).
export function encodeText(text, encoding, { keepBom } = {}) {
  const name = ENCODE_NAME[encoding]
  if (name === undefined) fail('FS_NOT_TEXT', `unsupported encoding "${encoding}"`)
  const body = name === 'utf-8' ? Buffer.from(text, 'utf8') : iconvOf().encode(text, name)
  if (encoding === 'utf-16le') return Buffer.concat([Buffer.from(BOM_UTF16LE), body])
  if (encoding === 'utf-16be') return Buffer.concat([Buffer.from(BOM_UTF16BE), body])
  if (encoding === 'utf-8-bom' || (encoding === 'utf-8' && keepBom)) return Buffer.concat([Buffer.from(BOM_UTF8), body])
  return body
}

const normEncoding = (value) => {
  if (value === undefined) return undefined
  if (typeof value !== 'string') fail('FS_NOT_TEXT', 'encoding must be a string')
  const name = value.trim().toLowerCase().replace(/_/g, '-')
  const aliases = { 'utf8': 'utf-8', 'utf8bom': 'utf-8-bom', 'utf-8bom': 'utf-8-bom', 'utf16le': 'utf-16le', 'utf-16-le': 'utf-16le', 'utf16be': 'utf-16be', 'utf-16-be': 'utf-16be', 'gb2312': 'gb18030', 'cp936': 'gbk' }
  const picked = aliases[name] ?? name
  if (!SUPPORTED_ENCODINGS.includes(picked)) fail('FS_NOT_TEXT', `unsupported encoding "${value}" (supported: ${SUPPORTED_ENCODINGS.join(', ')})`)
  return picked
}

// The path a file tool names, resolved the way the tools resolve it: relative
// paths start at the caller's working folder.
const targetPath = (rt, exec, raw) => {
  if (typeof raw !== 'string' || raw === '') fail('FS_NOT_FOUND', 'file_path must be a non-empty string')
  const base = rt.sessionFolder?.(exec.agent?.session ?? exec.agent)
  const full = isAbsolute(raw) ? raw : resolve(base ?? process.cwd(), raw.replace(/^~(?=\/|\\|$)/, require('node:os').homedir()))
  return resolve(full)
}

const readBytes = (path) => {
  if (!existsSync(path)) fail('FS_NOT_FOUND', `cannot read "${path}": not found`)
  const info = statSync(path)
  if (!info.isFile()) fail('FS_NOT_REGULAR_FILE', `cannot read "${path}": not a regular file`)
  return readFileSync(path)
}

// Read tool serving: the same numbered-line envelope the host renders, with an
// encoding line appended so the caller can confirm what was used.
const READ_DEFAULT_LIMIT = 2000
function serveRead(path, bytes, encoding, { offset = 1, limit = READ_DEFAULT_LIMIT } = {}) {
  if (!Number.isInteger(offset) || offset < 1) fail('FS_NOT_TEXT', 'offset must be a positive integer')
  if (!Number.isInteger(limit) || limit < 1) fail('FS_NOT_TEXT', 'limit must be a positive integer')
  const text = decodeBytes(bytes, encoding)
  const all = text.split('\n')
  const totalLines = all.length
  if (offset > totalLines && !(totalLines === 0 && offset === 1)) fail('FS_NOT_FOUND', `offset ${offset} is out of range for "${path}" (${totalLines} lines)`)
  const lines = []
  let truncatedByBytes = false
  for (let i = offset - 1; i < totalLines && lines.length < limit; i++) {
    const line = all[i].endsWith('\r') ? all[i].slice(0, -1) : all[i]
    if (line.length > READ_LINE_MAX) { lines.push({ number: i + 1, text: line.slice(0, READ_LINE_MAX) }); truncatedByBytes = true; continue }
    lines.push({ number: i + 1, text: line })
  }
  const endLine = lines.at(-1)?.number ?? Math.max(0, offset - 1)
  const footer = truncatedByBytes
    ? `(Output capped. Showing lines ${offset}-${endLine}. Use offset=${endLine + 1} to continue.)`
    : endLine < totalLines
      ? `(Showing lines ${offset}-${endLine} of ${totalLines}. Use offset=${endLine + 1} to continue.)`
      : `(End of file - total ${totalLines} lines)`
  const body = lines.length > 0 ? `${lines.map(line => `${line.number}: ${line.text}`).join('\n')}\n\n${footer}` : footer
  return `<path>${path}</path>\n<type>file</type>\n<encoding>${encoding}</encoding>\n<content>\n${body}\n</content>`
}

// Atomic write: temp file next to the target, then rename over it.
function writeAtomic(path, bytes) {
  const temp = `${path}.tmp-encoding-${process.pid}-${Date.now()}`
  try {
    writeFileSync(temp, bytes)
    renameSync(temp, path)
  } catch (error) {
    try { unlinkSync(temp) } catch { /* best effort */ }
    throw error
  }
}

const updateReport = (path, encoding, operation) =>
  `<path>${path}</path>\n<type>file</type>\n<content>\n${operation === 'create' ? 'Created' : 'Updated'} file (encoding: ${encoding})\n</content>`

const editReport = (path, encoding, replaceAll) =>
  `${path} updated (encoding: ${encoding}${replaceAll ? ', all occurrences replaced' : ''}).`

export function install(rt) {
  const { ctx } = rt

  ctx.on('tools/execute', async (exec, next) => {
    const name = exec.name
    if (name !== 'read' && name !== 'write' && name !== 'edit') return next()
    const args = exec.arguments ?? {}
    const explicit = normEncoding(args.encoding)

    // Behavior split. A write keeps the host's own path unless an encoding is
    // named — except when the target file already carries a non-UTF-8
    // encoding, which would be destroyed by a UTF-8 overwrite; then the
    // listener writes the new text in the file's own encoding. A read or edit
    // with an explicit encoding is served here; without one, the host path
    // runs for UTF-8 files and this listener serves non-UTF-8 text files
    // (their bytes decode correctly and the result names the encoding).
    if (explicit === undefined) {
      const probePath = targetPath(rt, exec, args.file_path)
      if (!existsSync(probePath)) return next()
      const detected = detectEncodingFromBytes(readBytes(probePath))
      const hostServesIt = name !== 'write' || detected === 'utf-8' || detected === 'utf-8-bom'
      if (detected === undefined || detected === 'utf-8' || detected === 'utf-8-bom') {
        // A binary file must not fall through to a confusing host error for
        // read/edit either; name the refusal the same way the host does.
        if (detected === undefined && name !== 'write') fail('FS_NOT_TEXT', `cannot ${name} "${probePath}": not text in a supported encoding`)
        if (hostServesIt) return next()
      }
    }

    const pathKey = { read: 'file_path', write: 'file_path', edit: 'file_path' }[name]
    const path = targetPath(rt, exec, args[pathKey])
    const exists = existsSync(path)
    const bytes = exists ? readBytes(path) : undefined

    // Which encoding the file itself carries; takesOver() already refused a
    // binary file, so a missing detection here cannot happen for reads.
    let detected
    if (exists) {
      detected = detectEncodingFromBytes(bytes)
      if (detected === undefined) fail('FS_NOT_TEXT', `cannot ${name} "${path}": not text in a supported encoding`)
    }

    if (name === 'read') {
      const encoding = explicit ?? detected
      return {
        isError: false,
        value: { path, encoding },
        content: [{ type: 'text', text: serveRead(path, bytes, encoding, { offset: args.offset, limit: args.limit }) }],
      }
    }

    if (name === 'write') {
      // Explicit encoding on an existing file overrides; otherwise an existing
      // file keeps its own encoding and BOM, a new file is UTF-8 without BOM.
      const encoding = explicit ?? detected ?? 'utf-8'
      const keepBom = explicit === undefined && detected === 'utf-8-bom'
      const outBytes = encodeText(String(args.content ?? ''), encoding === 'utf-8-bom' ? 'utf-8' : encoding, { keepBom: keepBom || detected === 'utf-8-bom' && explicit === undefined })
      writeAtomic(path, outBytes)
      return {
        isError: false,
        value: { path, encoding },
        content: [{ type: 'text', text: updateReport(path, encoding, exists ? 'update' : 'create') }],
      }
    }

    // edit: literal replacement on the decoded text, written back in the
    // file's own encoding with its BOM preserved.
    const oldString = args.old_string
    const newString = args.new_string
    if (typeof oldString !== 'string' || oldString === '') fail('FS_NOT_TEXT', 'old_string must be a non-empty string')
    if (typeof newString !== 'string') fail('FS_NOT_TEXT', 'new_string must be a string')
    if (oldString === newString) fail('FS_NOT_TEXT', 'old_string and new_string must differ')
    const encoding = explicit ?? detected
    if (!exists) fail('FS_NOT_FOUND', `cannot edit "${path}": not found`)
    const text = decodeBytes(bytes, encoding)
    const replaceAll = args.replace_all === true
    const first = text.indexOf(oldString)
    if (first === -1) fail('FS_NOT_FOUND', `old_string not found in ${path}`)
    if (!replaceAll && text.indexOf(oldString, first + 1) !== -1) fail('FS_NOT_FOUND', `old_string appears more than once in ${path}; use replace_all or a longer unique string`)
    const updated = replaceAll ? text.split(oldString).join(newString) : text.slice(0, first) + newString + text.slice(first + oldString.length)
    const outBytes = encodeText(updated, encoding, { keepBom: true })
    writeAtomic(path, outBytes)
    return {
      isError: false,
      value: { path, encoding },
      content: [{ type: 'text', text: editReport(path, encoding, replaceAll) }],
    }
  })
}
