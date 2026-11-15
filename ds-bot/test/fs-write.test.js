// The Bot's own write and edit: they shadow the host's UTF-8 ones, delegate to them
// first, and save a file that carries another encoding back in that same encoding —
// through the host's filesystem service, so the sandbox fence still holds.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import iconv from 'iconv-lite'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const CN = '你好，世界！编码测试。'

// A filesystem service that answers the calls the shadow write and edit make. Writes
// land on disk so the bytes can be compared; `withBytes: false` models a host without
// the writeBytes patch.
function fakeFs({ withBytes = true } = {}) {
  const calls = []
  const fs = {
    calls,
    async resolve(path) {
      calls.push(['resolve', path])
      return { targetKey: path, displayPath: path }
    },
    async readBytes(target) {
      calls.push(['readBytes', target.targetKey])
      try {
        return readFileSync(target.targetKey)
      } catch (error) {
        // The real service answers a typed error, never a raw OS one.
        if (error.code === 'ENOENT') {
          const missing = new Error(`FS_NOT_FOUND: cannot read "${target.displayPath}"`)
          missing.code = 'FS_NOT_FOUND'
          throw missing
        }
        throw error
      }
    },
    processPath(target) { return target.displayPath },
  }
  if (withBytes) {
    fs.writeBytes = async (target, bytes, expected, signal, policy) => {
      calls.push(['writeBytes', target.targetKey, policy?.mode])
      writeFileSync(target.targetKey, Buffer.from(bytes))
      return { operation: 'update' }
    }
  }
  return fs
}

function start({ withBytes = true, hostWrites } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-fswrite-'))
  const ctx = fakeContext()
  const fs = fakeFs({ withBytes })
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
  // The host's own tools, registered globally the way the composition has them.
  ctx.tools.register(hostWrites?.write ?? {
    name: 'write',
    description: 'Create or fully replace a UTF-8 text file.',
    parameters: { file_path: { type: 'string', required: true }, content: { type: 'string', required: true } },
    output: { schema: { type: 'string' } },
    async execute(args) {
      writeFileSync(args.file_path, String(args.content), 'utf8')
      return { isError: false, value: { path: args.file_path, operation: 'update', before: null, after: String(args.content) } }
    },
  })
  ctx.tools.register(hostWrites?.edit ?? {
    name: 'edit',
    description: 'Edit an existing UTF-8 text file by replacing literal text.',
    parameters: { file_path: { type: 'string', required: true }, old_string: { type: 'string', required: true }, new_string: { type: 'string', required: true } },
    output: { schema: { type: 'string' } },
    async execute(args) {
      const bytes = readFileSync(args.file_path)
      try { new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch {
        const error = new Error('FS_NOT_TEXT: cannot read')
        error.code = 'FS_NOT_TEXT'
        throw error
      }
      const text = bytes.toString('utf8')
      writeFileSync(args.file_path, text.replace(args.old_string, () => args.new_string), 'utf8')
      return { isError: false, value: { path: args.file_path, before: text, after: text } }
    },
  })
  const shadow = name => [...rt.teamTools, ...(rt.scopeShadows ?? [])].find(tool => tool.name === name)
  const exec = { agent: { id: 'writer', session: { id: 'writer' } }, signal: undefined }
  const run = async (name, args) => shadow(name).execute(args, exec)
  return { home, rt, fs, run, stop: () => rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
}

test('the Bot scope carries its own write and edit', (t) => {
  const { rt, stop } = start()
  t.after(stop)
  for (const name of ['read', 'write', 'edit']) {
    assert.ok((rt.scopeShadows ?? []).some(tool => tool.name === name), `the shadow ${name} is scoped onto the Bot`)
    assert.ok(!rt.teamTools.some(tool => tool.name === name), `${name} is not a team tool: it shadows a host one`)
  }
})

test('a plain UTF-8 file is written by the host, unchanged', (t) => {
  const { home, fs, run, stop } = start()
  t.after(stop)
  const file = join(home, 'plain.txt')
  writeFileSync(file, 'first\n')
  return (async () => {
    await run('write', { file_path: file, content: 'second\n' })
    assert.equal(readFileSync(file, 'utf8'), 'second\n', 'the host served it')
    assert.deepEqual(fs.calls.filter(call => call[0] === 'writeBytes'), [], 'the shadow did not write bytes itself')
  })()
})

test('a new file without an encoding is created by the host as UTF-8', (t) => {
  const { home, fs, run, stop } = start()
  t.after(stop)
  const file = join(home, 'fresh.txt')
  return (async () => {
    await run('write', { file_path: file, content: 'hello\n' })
    assert.equal(readFileSync(file, 'utf8'), 'hello\n')
    assert.deepEqual(fs.calls.filter(call => call[0] === 'writeBytes'), [])
  })()
})

test('a GB18030 file is written back as GB18030, through the filesystem service', (t) => {
  const { home, fs, run, stop } = start()
  t.after(stop)
  const file = join(home, 'gbk.txt')
  writeFileSync(file, iconv.encode(CN, 'gb18030'))
  const replacement = '改过的内容，仍然是 GB18030。'
  return (async () => {
    const out = await run('write', { file_path: file, content: replacement })
    assert.equal(out.encoding, 'gb18030')
    const bytes = readFileSync(file)
    assert.deepEqual(bytes, iconv.encode(replacement, 'gb18030'), 'the bytes are GB18030 again')
    assert.equal(iconv.decode(bytes, 'gb18030'), replacement)
    // Round trip through a strict UTF-8 decoder must fail: proof it is not UTF-8 now.
    assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    assert.deepEqual(fs.calls.filter(call => call[0] === 'writeBytes').length, 1)
  })()
})

test('a GB18030 file is edited in place and stays GB18030', (t) => {
  const { home, fs, run, stop } = start()
  t.after(stop)
  const file = join(home, 'edit.txt')
  writeFileSync(file, iconv.encode(`${CN}\n第二行\n`, 'gb18030'))
  return (async () => {
    await run('edit', { file_path: file, old_string: '第二行', new_string: '改后的第二行' })
    const bytes = readFileSync(file)
    assert.equal(iconv.decode(bytes, 'gb18030'), `${CN}\n改后的第二行\n`)
    assert.deepEqual(bytes, iconv.encode(`${CN}\n改后的第二行\n`, 'gb18030'))
    assert.deepEqual(fs.calls.filter(call => call[0] === 'writeBytes').length, 1)
  })()
})

test('a UTF-16LE file keeps its BOM when edited', (t) => {
  const { home, run, stop } = start()
  t.after(stop)
  const file = join(home, 'u16.txt')
  writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(`${CN}\n`, 'utf16-le')]))
  return (async () => {
    await run('edit', { file_path: file, old_string: '世界', new_string: '世界啊' })
    const bytes = readFileSync(file)
    assert.equal(bytes[0], 0xff)
    assert.equal(bytes[1], 0xfe)
    assert.equal(iconv.decode(bytes.subarray(2), 'utf16-le'), `${CN.replace('世界', '世界啊')}\n`)
  })()
})

test('a UTF-8 file with a BOM keeps its BOM when edited', (t) => {
  const { home, run, stop } = start()
  t.after(stop)
  const file = join(home, 'bom.txt')
  writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${CN}\n`, 'utf8')]))
  return (async () => {
    // The host's edit refuses a BOM file's non-ASCII? It accepts UTF-8, so the host
    // takes it; either way the BOM must survive.
    await run('edit', { file_path: file, old_string: '世界', new_string: '世界啊' })
    const bytes = readFileSync(file)
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM kept')
    assert.equal(bytes.subarray(3).toString('utf8'), `${CN.replace('世界', '世界啊')}\n`)
  })()
})

test('a new file asked for in GB18030 is created in that encoding', (t) => {
  const { home, run, stop } = start()
  t.after(stop)
  const file = join(home, 'created.txt')
  return (async () => {
    const out = await run('write', { file_path: file, content: CN, encoding: 'gb18030' })
    assert.equal(out.encoding, 'gb18030')
    assert.deepEqual(readFileSync(file), iconv.encode(CN, 'gb18030'))
  })()
})

test('without the writeBytes patch a non-UTF-8 write is refused by name, not written', (t) => {
  const { home, run, stop } = start({ withBytes: false })
  t.after(stop)
  const file = join(home, 'gbk.txt')
  const original = iconv.encode(CN, 'gb18030')
  writeFileSync(file, original)
  return (async () => {
    await assert.rejects(
      run('write', { file_path: file, content: '不能被写坏' }),
      error => error.code === 'FS_ENCODING_UNSUPPORTED' && /GB18030|gb18030/.test(error.message),
    )
    assert.deepEqual(readFileSync(file), original, 'the file is untouched')
  })()
})

test('an ambiguous edit is refused unless replace_all is asked for', (t) => {
  const { home, run, stop } = start()
  t.after(stop)
  const file = join(home, 'twice.txt')
  writeFileSync(file, iconv.encode('重复\n重复\n', 'gb18030'))
  return (async () => {
    await assert.rejects(run('edit', { file_path: file, old_string: '重复', new_string: '一' }), error => error.code === 'FS_AMBIGUOUS_EDIT')
    await run('edit', { file_path: file, old_string: '重复', new_string: '一', replace_all: true })
    assert.equal(iconv.decode(readFileSync(file), 'gb18030'), '一\n一\n')
  })()
})

test('a missing match is refused and the file is untouched', (t) => {
  const { home, run, stop } = start()
  t.after(stop)
  const file = join(home, 'nomatch.txt')
  const original = iconv.encode(CN, 'gb18030')
  writeFileSync(file, original)
  return (async () => {
    await assert.rejects(run('edit', { file_path: file, old_string: '不存在', new_string: 'x' }), error => error.code === 'FS_EDIT_NOT_FOUND')
    assert.deepEqual(readFileSync(file), original)
  })()
})

test('the write sends the sandbox policy the call runs under', (t) => {
  const { home, fs, run, stop } = start()
  t.after(stop)
  const file = join(home, 'policied.txt')
  writeFileSync(file, iconv.encode(CN, 'gb18030'))
  return (async () => {
    await run('write', { file_path: file, content: '带策略的写' })
    const call = fs.calls.find(entry => entry[0] === 'writeBytes')
    assert.ok(call !== undefined, 'went through writeBytes')
    // The fake context carries no sandboxPolicy service, so no policy is stamped —
    // exactly what the host's own tools do under an unsandboxed backend.
    assert.equal(call[2], undefined)
  })()
})

test('neither tool touches the disk itself: every byte goes through the service', () => {
  // The rule PR #33 set: no Node fs in the encoding path, or the sandbox fence is gone.
  for (const name of ['fs-write-bytes.js', 'fs-write-tool.js']) {
    const source = readFileSync(new URL(`../src/host/${name}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /from 'node:fs'|require\('node:fs'\)|from "node:fs"/u, `${name} must not open files itself`)
    assert.doesNotMatch(source, /\bwriteFileSync\b|\breadFileSync\b/u, `${name} must not read or write files itself`)
  }
})
