// The Bot's own read: it shadows the host's UTF-8 one, delegates to it first, and
// serves the encodings the host cannot decode — reading through the host's
// filesystem service, so the sandbox fence still holds.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import iconv from 'iconv-lite'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const CN = '你好，世界！编码测试。'

// A filesystem service that answers the two calls the shadow read makes. It
// records them, so a test can prove the read went through the service and not
// straight to the disk.
function fakeFs(home, { refuseAsText = false } = {}) {
  const calls = []
  return {
    calls,
    async resolve(path) {
      calls.push(['resolve', path])
      return { targetKey: path, displayPath: path }
    },
    async readBytes(target, _signal, maxBytes) {
      calls.push(['readBytes', target.targetKey, maxBytes])
      const bytes = readFileSync(target.targetKey)
      if (refuseAsText) {
        const error = new Error('FS_NOT_TEXT: cannot read')
        error.code = 'FS_NOT_TEXT'
        throw error
      }
      return bytes
    },
    processPath(target) { return target.displayPath },
  }
}

function start({ refuseAsText = false, hostRead } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-fsread-'))
  const ctx = fakeContext()
  const fs = fakeFs(home, { refuseAsText })
  Object.assign(ctx, {
    workspaceRegistry: {
      get: () => undefined,
      list: () => [],
      resolveByPath: async () => undefined,
      create: async () => ({ id: 'w1', path: home }),
      archiveSession: async () => {},
    },
    get: name => (name === 'fs' ? fs : undefined),
  })
  const rt = createRuntime(ctx, { home })
  // The host's own read, the way the registry holds it: a global registration the
  // shadow finds without a scope.
  ctx.tools.register(hostRead ?? {
    name: 'read',
    description: 'Read a UTF-8 text file and return line-numbered content.',
    parameters: { file_path: { type: 'string', required: true } },
    output: { schema: { type: 'string' } },
    async execute(args) {
      // The host refuses anything that is not strict UTF-8.
      const bytes = readFileSync(args.file_path)
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        const error = new Error('FS_NOT_TEXT: cannot read')
        error.code = 'FS_NOT_TEXT'
        throw error
      }
      return { isError: false, value: { path: args.file_path }, content: [{ type: 'text', text: 'host read' }] }
    },
  })
  const read = [...rt.teamTools, ...(rt.scopeShadows ?? [])].find(tool => tool.name === 'read')
  // The tool returns its value; the envelope the model sees comes from the
  // declared output's render. The host's own read answers with an envelope, so
  // both shapes are read the same way here.
  const run = async (args) => {
    const raw = await read.execute(args, { agent: { id: 'writer', session: { id: 'writer' } }, signal: undefined })
    if (raw?.content !== undefined) return { ...raw, text: raw.content[0]?.text }
    const text = read.output.render(args, raw)[0].text
    return { ...raw, text }
  }
  return { home, rt, fs, run, stop: () => rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
}

test('the Bot scope carries its own read', (t) => {
  const { rt, stop } = start()
  t.after(stop)
  assert.ok((rt.scopeShadows ?? []).some(tool => tool.name === 'read'), 'the shadow read is scoped onto the Bot')
  assert.ok(!rt.teamTools.some(tool => tool.name === 'read'), 'it is not a team tool: it shadows a host one')
})

test('a plain UTF-8 file is served by the host, unchanged', (t) => {
  const { home, fs, run, stop } = start()
  t.after(stop)
  const file = join(home, 'plain.txt')
  writeFileSync(file, 'line one\nline two\n')
  return (async () => {
    const out = await run({ file_path: file })
    assert.equal(out.text, 'host read', 'the host served it')
    assert.deepEqual(fs.calls, [], 'the shadow did not read the file itself')
  })()
})

test('a GB18030 file is read in its own encoding, through the filesystem service', (t) => {
  const { home, fs, run, stop } = start()
  t.after(stop)
  const file = join(home, 'gbk.txt')
  writeFileSync(file, iconv.encode(CN + '\nsecond line', 'gb18030'))
  return (async () => {
    const out = await run({ file_path: file })
    assert.equal(out.encoding, 'gb18030')
    assert.match(out.text, /你好，世界！编码测试。/)
    assert.deepEqual(fs.calls.map(call => call[0]), ['resolve', 'readBytes'], 'the bytes came through the service')
  })()
})

test('an explicitly named encoding is honoured', (t) => {
  const { home, run, stop } = start()
  t.after(stop)
  const file = join(home, 'gbk2.txt')
  writeFileSync(file, iconv.encode(CN, 'gb18030'))
  return (async () => {
    const out = await run({ file_path: file, encoding: 'gbk' })
    assert.equal(out.encoding, 'gbk')
    assert.match(out.text, /你好，世界！编码测试。/)
  })()
})

test('a UTF-16LE file with a BOM is read as utf-16le', (t) => {
  const { home, run, stop } = start()
  t.after(stop)
  const file = join(home, 'u16.txt')
  writeFileSync(file, Buffer.concat([Buffer.from([0xFF, 0xFE]), iconv.encode(CN, 'utf16-le')]))
  return (async () => {
    const out = await run({ file_path: file })
    assert.equal(out.encoding, 'utf-16le')
    assert.match(out.text, /你好，世界/)
  })()
})

test('a Big5 file is detected through the fallback probe', (t) => {
  const { home, run, stop } = start()
  t.after(stop)
  const file = join(home, 'big5.txt')
  const text = '繁體中文測試檔案內容，繁體中文測試檔案內容'
  writeFileSync(file, iconv.encode(text, 'big5'))
  return (async () => {
    const out = await run({ file_path: file })
    assert.equal(out.encoding, 'big5')
    assert.match(out.text, /繁體中文測試檔案內容/)
  })()
})

test('a binary file is refused with FS_NOT_TEXT', (t) => {
  const { home, run, stop } = start()
  t.after(stop)
  const file = join(home, 'bin.dat')
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0x01, 0x02]))
  return (async () => {
    await assert.rejects(() => run({ file_path: file }), /FS_NOT_TEXT/)
  })()
})

test('an unsupported encoding is refused by name', (t) => {
  const { home, run, stop } = start()
  t.after(stop)
  const file = join(home, 'plain.txt')
  writeFileSync(file, 'hello')
  return (async () => {
    await assert.rejects(() => run({ file_path: file, encoding: 'shift_jis' }), /unsupported encoding/)
  })()
})

test('the read goes through the filesystem service, never straight to the disk', (t) => {
  const { home, fs, run, stop } = start()
  t.after(stop)
  const file = join(home, 'gbk.txt')
  writeFileSync(file, iconv.encode(CN, 'gb18030'))
  return (async () => {
    await run({ file_path: file })
    assert.ok(fs.calls.length > 0, 'the service was used')
    assert.ok(fs.calls.some(call => call[0] === 'readBytes'), 'the bytes came from the service')
  })()
})

test('the host is asked first, and only its FS_NOT_TEXT refusal is ours to answer', (t) => {
  const asked = []
  const hostRead = {
    name: 'read',
    parameters: {},
    output: { schema: { type: 'string' } },
    async execute(args) {
      asked.push(args.file_path)
      const error = new Error('FS_NOT_TEXT: cannot read')
      error.code = 'FS_NOT_TEXT'
      throw error
    },
  }
  const { home, run, stop } = start({ hostRead })
  t.after(stop)
  const file = join(home, 'gbk.txt')
  writeFileSync(file, iconv.encode(CN, 'gb18030'))
  return (async () => {
    const out = await run({ file_path: file })
    assert.deepEqual(asked, [file], 'the host was tried first')
    assert.equal(out.encoding, 'gb18030', 'and the shadow served it')
  })()
})

test('a refusal that is not about decoding is the host\'s to report', (t) => {
  const hostRead = {
    name: 'read',
    parameters: {},
    output: { schema: { type: 'string' } },
    async execute() {
      const error = new Error('FS_NOT_FOUND: no such file')
      error.code = 'FS_NOT_FOUND'
      throw error
    },
  }
  const { home, run, stop } = start({ hostRead })
  t.after(stop)
  const file = join(home, 'gbk.txt')
  writeFileSync(file, iconv.encode(CN, 'gb18030'))
  return (async () => {
    await assert.rejects(() => run({ file_path: file }), /FS_NOT_FOUND/)
  })()
})
