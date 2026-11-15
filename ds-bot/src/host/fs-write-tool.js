// The Bot's own `write` and `edit`: the host's UTF-8 ones first, and a file that
// carries another encoding saved back in that same encoding.
//
// Same shape as the shadow `read` in fs-read-tool.js: registered in each Bot's scope,
// where it shadows the host's global tool. The shadow delegates first, so a UTF-8 file
// keeps the host's behaviour exactly — its sandbox fence, its atomic write, its
// observation and version guards, its refusals, its diff card.
//
// Only a file that is not UTF-8 (so the host could not have written it faithfully) is
// handled here: the bytes are decoded in the encoding they carry, the caller's text is
// substituted, and the result is encoded back the same way — BOM included — and written
// through `ctx.fs.writeBytes`. Without the host patch that channel is absent, and the
// write is refused by name instead of silently writing UTF-8 into a GBK file.
import { defineTool } from '@deepseek-ai/dsh-tools'
import { encodeText, namedEncoding } from './encoding.js'
import { encodingOf, textOf } from './fs-encoding.js'
import { ENCODING_UNSUPPORTED, canWriteBytes, sandboxPolicyOf, writeBytesThrough } from './fs-write-bytes.js'

const fail = (code, message) => {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  throw error
}

/** The codes that mean "there is no file here yet", so creating one is the answer. */
const MISSING = new Set(['FS_NOT_FOUND', 'FS_NOT_DIRECTORY', 'ENOENT', 'ENOTDIR'])

/**
 * The bytes a file of this encoding keeps its BOM as: UTF-8 only when the file had one.
 *
 * @param {string} encoding the detected or named encoding
 * @returns {boolean} whether a UTF-8 BOM belongs in the output
 */
const keepBom = encoding => encoding === 'utf-8-bom'

/**
 * Read the file's bytes and its encoding, or undefined when there is no file yet.
 *
 * @param {object} fs the host's filesystem service
 * @param {string} path the path to look at
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ bytes: Uint8Array, encoding: string } | undefined>}
 */
async function readExisting(fs, path, signal) {
  let target
  try {
    target = await fs.resolve(path, { signal })
  } catch {
    return undefined
  }
  let bytes
  try {
    bytes = await fs.readBytes(target, signal)
  } catch (error) {
    // A missing file is the host's to create; a refusal is the host's to report. The
    // service answers FS_NOT_FOUND, and a backend that lets the OS error through says
    // ENOENT — both mean "nothing there yet".
    if (MISSING.has(error?.code)) return undefined
    throw error
  }
  const encoding = encodingOf(bytes)
  return encoding === undefined ? undefined : { bytes, encoding }
}

/**
 * What to tell the caller about a file this host cannot save in its own encoding.
 *
 * @param {string} path the path that was refused
 * @param {string} encoding the file's encoding
 * @returns {string}
 */
const unsupportedText = (path, encoding) =>
  `"${path}" is ${encoding}, and this host cannot write bytes back, so it cannot be saved in its own encoding. Convert it to UTF-8 first, or install a build that carries the writeBytes patch.`

/**
 * The Bot's write tool.
 *
 * @param {object} rt the runtime
 * @returns {import('@deepseek-ai/dsh-tools').ToolDefinition}
 */
export function writeTool(rt) {
  const { ctx } = rt
  return defineTool({
    name: 'write',
    description: 'Create or fully replace a text file. UTF-8, GB18030/GBK, Big5 and UTF-16 files are written back in the encoding they carry; a new file is UTF-8 unless encoding names another.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to write, resolved by the filesystem backend. Provide `file_path` before `content` in the arguments.' },
      content: { type: 'string', required: true, description: 'Full text content to write.' },
      encoding: { type: 'string', description: 'The encoding for a new file, when it should not be UTF-8: utf-8, utf-8-bom, utf-16le, utf-16be, gb18030, gbk or big5. An existing file keeps its own encoding.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          operation: { type: 'string', required: true, enum: ['create', 'update'] },
          encoding: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{ type: 'text', text: `Wrote ${value.path} (${value.encoding}, ${value.operation})` }],
    },
    async execute(args, exec) {
      const explicit = namedEncoding(args.encoding)
      const fs = ctx.get?.('fs')
      if (fs === undefined) fail('FS_IO_ERROR', 'this host has no filesystem service')
      const path = String(args.file_path ?? '')
      const content = String(args.content ?? '')
      const host = ctx.tools?.get?.('write')
      const existing = await readExisting(fs, path, exec.signal)
      // No file, or a UTF-8 one: the host's own write, behaviour untouched. A new file
      // asked for in another encoding is ours to create.
      const plain = existing === undefined ? explicit === undefined || explicit === 'utf-8' || explicit === 'utf-8-bom' : existing.encoding === 'utf-8' || existing.encoding === 'utf-8-bom'
      if (plain && host !== undefined) {
        const result = await host.execute(args, exec)
        return { path: String(result?.path ?? path), operation: String(result?.operation ?? 'update'), encoding: existing?.encoding ?? explicit ?? 'utf-8' }
      }
      const encoding = existing?.encoding ?? explicit ?? 'utf-8'
      if (!canWriteBytes(fs)) fail(ENCODING_UNSUPPORTED, unsupportedText(path, encoding))
      const bytes = encodeText(content, encoding, { keepBom: keepBom(encoding) })
      const policy = sandboxPolicyOf(ctx, exec)
      const { target } = await writeBytesThrough(fs, path, bytes, { signal: exec.signal, sandboxPolicy: policy })
      return { path: fs.processPath?.(target) ?? path, operation: existing === undefined ? 'create' : 'update', encoding }
    },
  })
}

/**
 * The Bot's edit tool.
 *
 * @param {object} rt the runtime
 * @returns {import('@deepseek-ai/dsh-tools').ToolDefinition}
 */
export function editTool(rt) {
  const { ctx } = rt
  return defineTool({
    name: 'edit',
    description: 'Edit an existing text file by replacing literal text. UTF-8, GB18030/GBK, Big5 and UTF-16 files are edited and saved back in the encoding they carry.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to edit, resolved by the filesystem backend. Provide `file_path` before `old_string` and `new_string` in the arguments.' },
      old_string: { type: 'string', required: true, description: 'Literal text to replace.' },
      new_string: { type: 'string', required: true, description: 'Literal replacement text. Use an empty string to delete the match.' },
      replace_all: { type: 'boolean', description: 'Replace all matches. Defaults to false; when false, old_string must appear exactly once.' },
      encoding: { type: 'string', description: 'The file encoding, when it should not be detected: utf-8, utf-8-bom, utf-16le, utf-16be, gb18030, gbk or big5.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          encoding: { type: 'string', required: true },
          replacements: { type: 'integer', required: true },
        },
      },
      render: (args, value) => [{ type: 'text', text: `Edited ${value.path} (${value.encoding}, ${value.replacements} replacement${value.replacements === 1 ? '' : 's'})` }],
    },
    async execute(args, exec) {
      const explicit = namedEncoding(args.encoding)
      const fs = ctx.get?.('fs')
      if (fs === undefined) fail('FS_IO_ERROR', 'this host has no filesystem service')
      const path = String(args.file_path ?? '')
      const host = ctx.tools?.get?.('edit')
      if (explicit === undefined && host !== undefined) {
        try {
          const result = await host.execute(args, exec)
          return { path: String(result?.path ?? path), encoding: 'utf-8', replacements: 1 }
        } catch (error) {
          // Only a decoding refusal is ours to answer; a stale version or a missing
          // match is the caller's problem and the host already said it well.
          if (error?.code !== 'FS_NOT_TEXT') throw error
        }
      }
      const existing = await readExisting(fs, path, exec.signal)
      if (existing === undefined) fail('FS_NOT_FOUND', `cannot edit "${path}": no such text file`)
      const encoding = explicit ?? existing.encoding
      const text = textOf(existing.bytes, encoding)
      const oldString = String(args.old_string ?? '')
      const newString = String(args.new_string ?? '')
      if (oldString === '') fail('FS_EDIT_NOT_FOUND', `cannot edit "${path}": old_string must not be empty`)
      const occurrences = text.split(oldString).length - 1
      if (occurrences === 0) fail('FS_EDIT_NOT_FOUND', `cannot edit "${path}": old_string does not appear in the file`)
      if (occurrences > 1 && args.replace_all !== true) fail('FS_AMBIGUOUS_EDIT', `cannot edit "${path}": old_string appears ${occurrences} times; use replace_all or a longer old_string`)
      const edited = args.replace_all === true ? text.split(oldString).join(newString) : text.replace(oldString, () => newString)
      if (!canWriteBytes(fs)) fail(ENCODING_UNSUPPORTED, unsupportedText(path, encoding))
      const bytes = encodeText(edited, encoding, { keepBom: keepBom(encoding) })
      const policy = sandboxPolicyOf(ctx, exec)
      const { target } = await writeBytesThrough(fs, path, bytes, { signal: exec.signal, sandboxPolicy: policy })
      return { path: fs.processPath?.(target) ?? path, encoding, replacements: args.replace_all === true ? occurrences : 1 }
    },
  })
}
