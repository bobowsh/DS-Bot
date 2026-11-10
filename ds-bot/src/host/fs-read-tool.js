// The Bot's own `read`: the host's UTF-8 one first, and when the host cannot decode
// the file, this one serves it in the encoding it actually carries.
//
// The host's read is registered globally; this one is registered in each Bot's
// scope, where it shadows the global one (dsh-tools: "Scoped tools shadow global
// registrations"). The shadow delegates first: `ctx.tools.get('read')` without a
// scope gives the host's own implementation, so a plain UTF-8 file keeps the
// host's behaviour exactly — its sandbox fence, its line numbering, its limits,
// its refusal of binaries. Only when the host refuses with FS_NOT_TEXT does the
// shadow take over, reading the bytes through the same `ctx.fs` service and
// decoding them here.
//
// Writing a non-UTF-8 file back in its own encoding needs a `writeBytes` the
// filesystem service does not have: see docs/plans/2026-11-10-fs-encoding-sandbox.md.
import { defineTool } from '@deepseek-ai/dsh-tools'
import { namedEncoding } from './encoding.js'
import { encodingOf, readBytesThrough, textOf } from './fs-encoding.js'

/** The host's read limits, mirrored so the shadow serves the same window. */
const DEFAULT_LIMIT = 2000
/** The longest single line the host shows; longer ones are cut. */
const READ_LINE_MAX = 2000

const fail = (code, message) => {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  throw error
}

/**
 * The lines of the text, numbered and cut to the host's line length.
 *
 * @param {string} text
 * @param {number} offset
 * @param {number} limit
 * @returns {{ lines: {number: number, text: string}[], totalLines: number, truncatedByBytes: boolean }}
 */
export function windowOf(text, offset, limit) {
  const all = text.split('\n')
  const totalLines = all.length
  const lines = []
  let truncatedByBytes = false
  for (let at = offset - 1; at < totalLines && lines.length < limit; at += 1) {
    const line = all[at].endsWith('\r') ? all[at].slice(0, -1) : all[at]
    if (line.length > READ_LINE_MAX) {
      lines.push({ number: at + 1, text: line.slice(0, READ_LINE_MAX) })
      truncatedByBytes = true
      continue
    }
    lines.push({ number: at + 1, text: line })
  }
  return { lines, totalLines, truncatedByBytes }
}

/**
 * The envelope the host's read renders.
 *
 * @param {string} path
 * @param {string} encoding
 * @param {{lines: {number: number, text: string}[], totalLines: number, truncatedByBytes: boolean}} window
 * @returns {string}
 */
export function readEnvelope(path, encoding, window) {
  const endLine = window.lines.at(-1)?.number ?? Math.max(0, 0)
  const footer = window.truncatedByBytes
    ? `(Output capped. Showing lines ${window.lines[0]?.number ?? 1}-${endLine}. Use offset=${endLine + 1} to continue.)`
    : endLine < window.totalLines
      ? `(Showing lines ${window.lines[0]?.number ?? 1}-${endLine} of ${window.totalLines}. Use offset=${endLine + 1} to continue.)`
      : `(End of file - total ${window.totalLines} lines)`
  const body = window.lines.length > 0 ? `${window.lines.map(line => `${line.number}: ${line.text}`).join('\n')}\n\n${footer}` : footer
  return `<path>${path}</path>\n<type>file</type>\n<encoding>${encoding}</encoding>\n<content>\n${body}\n</content>`
}

/**
 * The Bot's read tool.
 *
 * @param {object} rt the runtime
 * @returns {import('@deepseek-ai/dsh-tools').ToolDefinition}
 */
export function readTool(rt) {
  const { ctx } = rt
  return defineTool({
    name: 'read',
    description: 'Read a text file and return line-numbered content. UTF-8, GB18030/GBK, UTF-16 and Big5 files are read in the encoding they carry.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to read, resolved by the filesystem backend.' },
      offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
      limit: { type: 'number', description: `Maximum number of lines to return. Defaults to ${DEFAULT_LIMIT}.` },
      encoding: { type: 'string', description: 'The file encoding, when it should not be detected: utf-8, utf-8-bom, utf-16le, utf-16be, gb18030, gbk or big5.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          offset: { type: 'integer', required: true },
          encoding: { type: 'string', required: true },
          lines: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                number: { type: 'integer', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          totalLines: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: readEnvelope(value.path, value.encoding, {
          lines: value.lines,
          totalLines: value.totalLines,
          truncatedByBytes: value.lines.length < value.limit && (value.lines.at(-1)?.number ?? 0) < value.totalLines,
        }),
      }],
    },
    async execute(args, exec) {
      const explicit = namedEncoding(args.encoding)
      // The host's own read: without a scope it is the global one, not this shadow.
      const host = ctx.tools?.get?.('read')
      if (host !== undefined && explicit === undefined) {
        try {
          return await host.execute(args, exec)
        } catch (error) {
          // Only a decoding refusal is ours to answer; anything else is the host's.
          if (error?.code !== 'FS_NOT_TEXT') throw error
        }
      }
      const fs = ctx.get?.('fs')
      if (fs === undefined) fail('FS_IO_ERROR', 'this host has no filesystem service')
      const offset = args.offset === undefined ? 1 : Number(args.offset)
      const limit = args.limit === undefined ? DEFAULT_LIMIT : Number(args.limit)
      if (!Number.isInteger(offset) || offset < 1) fail('FS_NOT_TEXT', 'offset must be a positive integer')
      if (!Number.isInteger(limit) || limit < 1) fail('FS_NOT_TEXT', 'limit must be a positive integer')
      const { target, bytes } = await readBytesThrough(fs, String(args.file_path ?? ''), { signal: exec.signal })
      const detected = encodingOf(bytes)
      if (detected === undefined) fail('FS_NOT_TEXT', `cannot read "${target.displayPath}": not text in a supported encoding`)
      const encoding = explicit ?? detected
      const text = textOf(bytes, encoding)
      const window = windowOf(text, offset, limit)
      return {
        path: fs.processPath(target),
        offset,
        encoding,
        lines: window.lines,
        totalLines: window.totalLines,
      }
    },
  })
}
