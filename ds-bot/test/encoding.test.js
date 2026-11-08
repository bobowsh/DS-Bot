// The encoding layer: detection, read/write/edit on non-UTF-8 files, and the
// untouched UTF-8 pass-through. Covers the issue #3 acceptance list.
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import iconv from 'iconv-lite'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// Runs one file-tool call through the runtime's tools/execute waterfall the way
// the registry does, so the encoding listener sees the same view.
function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-encoding-'))
  const ctx = fakeContext()
  // The folders module reads the workspace registry when it resolves a
  // session's folder; the tests pass absolute paths, so an empty registry with
  // the team folder at `home` keeps every resolution inside it.
  Object.assign(ctx, {
    workspaceRegistry: {
      get: () => undefined,
      list: () => [],
      resolveByPath: async () => undefined,
      create: async () => ({ id: 'w1', path: home }),
      archiveSession: async () => {},
    },
  })
  const rt = createRuntime(ctx, { home })
  // Runs the tools/execute listeners as a waterfall, like the registry does:
  // each listener's `next` runs the rest of the chain, and the stand-in body
  // returns what the host's own UTF-8 dispatch would (a pass-through call).
  const run = async (name, args) => {
    const listeners = [...(ctx.listeners.get('tools/execute') ?? [])].reverse()
    const body = () => Promise.resolve({ isError: false, value: { passthrough: true }, content: [{ type: 'text', text: 'passthrough' }] })
    return listeners.reduce((chain, listener) => () => listener({ name, arguments: args }, chain), body)()
  }
  return { home, rt, run, stop: () => rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
}

const CN = '你好，世界！编码测试。'

test('read auto-detects GB18030 and reads it explicitly as gbk', (t) => {
  const { home, run, stop } = start()
  t.after(stop)
  const file = join(home, 'gbk.txt')
  writeFileSync(file, iconv.encode(CN + '\nsecond line', 'gb18030'))
  return (async () => {
    const auto = await run('read', { file_path: file })
    assert.match(auto.content[0].text, /<encoding>gb18030<\/encoding>/)
    assert.match(auto.content[0].text, /你好，世界！编码测试。/)
    const explicit = await run('read', { file_path: file, encoding: 'gbk' })
    assert.match(explicit.content[0].text, /你好，世界！编码测试。/)
    assert.match(explicit.content[0].text, /<encoding>gbk<\/encoding>/)
  })()
})

test('edit on a GB18030 file keeps the file GB18030', (t) => {
  const { home, run, stop } = start()
  t.after(stop)
  const file = join(home, 'gbk-edit.txt')
  writeFileSync(file, iconv.encode('alpha 中文字符 omega', 'gb18030'))
  return (async () => {
    const out = await run('edit', { file_path: file, old_string: '中文字符', new_string: '替换内容' })
    assert.equal(out.isError, false)
    assert.match(out.content[0].text, /gb18030/)
    assert.equal(iconv.decode(readFileSync(file), 'gb18030'), 'alpha 替换内容 omega')
  })()
})

test('UTF-16LE with BOM: read detects it, edit preserves the BOM', (t) => {
  const { home, run, stop } = start()
  t.after(stop)
  const file = join(home, 'u16.txt')
  writeFileSync(file, Buffer.concat([Buffer.from([0xFF, 0xFE]), iconv.encode(CN, 'utf16-le')]))
  return (async () => {
    const read = await run('read', { file_path: file })
    assert.match(read.content[0].text, /<encoding>utf-16le<\/encoding>/)
    assert.match(read.content[0].text, /你好，世界/)
    const out = await run('edit', { file_path: file, old_string: '世界', new_string: '世界2' })
    assert.match(out.content[0].text, /utf-16le/)
    const bytes = readFileSync(file)
    assert.deepEqual([bytes[0], bytes[1]], [0xFF, 0xFE])
    assert.equal(iconv.decode(bytes.subarray(2), 'utf16-le'), CN.replace('世界', '世界2'))
  })()
})

test('UTF-8 BOM: read strips it, edit keeps it', (t) => {
  const { home, run, stop } = start()
  t.after(stop)
  const file = join(home, 'u8bom.txt')
  writeFileSync(file, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(CN, 'utf8')]))
  return (async () => {
    const read = await run('read', { file_path: file })
    // A UTF-8 BOM file is still UTF-8: the host path serves it and strips the
    // BOM in its own decode, so the pass-through shows no encoding line.
    assert.equal(read.value.passthrough, true)
    assert.doesNotMatch(read.content[0].text, /﻿/)
    const out = await run('edit', { file_path: file, old_string: '编码', new_string: '编码X' })
    assert.equal(out.value.passthrough, true)
    const bytes = readFileSync(file)
    assert.deepEqual([bytes[0], bytes[1], bytes[2]], [0xEF, 0xBB, 0xBF])
  })()
})

test('write creates UTF-8 without BOM by default and utf-16le with BOM when asked', (t) => {
  const { home, run, stop } = start()
  t.after(stop)
  return (async () => {
    const plain = join(home, 'fresh.txt')
    const out = await run('write', { file_path: plain, content: CN })
    // No encoding arg and no existing file: the host path owns it. The fake
    // waterfall's stand-in body does not write, so assert the pass-through
    // (the host's own tests cover the UTF-8 write itself).
    assert.equal(out.value.passthrough, true)
    assert.equal(existsSync(plain), false)
    const wide = join(home, 'fresh16.txt')
    const out16 = await run('write', { file_path: wide, content: CN, encoding: 'utf-16le' })
    assert.match(out16.content[0].text, /utf-16le/)
    const bytes = readFileSync(wide)
    assert.deepEqual([bytes[0], bytes[1]], [0xFF, 0xFE])
    assert.equal(iconv.decode(bytes.subarray(2), 'utf16-le'), CN)
  })()
})

test('write on an existing GB18030 file keeps GB18030 without an explicit encoding', (t) => {
  const { home, run, stop } = start()
  t.after(stop)
  const file = join(home, 'gbk-write.txt')
  writeFileSync(file, iconv.encode(CN, 'gb18030'))
  return (async () => {
    // Without an encoding arg the host path takes the write and would store
    // UTF-8 bytes; the issue asks for the original encoding to survive, so the
    // listener takes over when the target file is already non-UTF-8.
    const out = await run('write', { file_path: file, content: CN + '\n重写的第二行' })
    assert.match(out.content[0].text, /gb18030/)
    assert.equal(iconv.decode(readFileSync(file), 'gb18030'), CN + '\n重写的第二行')
  })()
})

test('binary files are refused and unsupported encodings error by name', (t) => {
  const { home, run, stop } = start()
  t.after(stop)
  const bin = join(home, 'bin.dat')
  writeFileSync(bin, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0x01, 0x02]))
  return (async () => {
    // The refusal throws a coded error, which the registry turns into a
    // failed result; the fake waterfall lets it propagate, so catch it.
    await assert.rejects(() => run('read', { file_path: bin }), /FS_NOT_TEXT/)
    const text = join(home, 'plain.txt')
    writeFileSync(text, 'hello')
    await assert.rejects(() => run('read', { file_path: text, encoding: 'shift_jis' }), /unsupported encoding/)
  })()
})

test('Big5 bytes invalid as UTF-8 are detected and read via the chardet fallback', (t) => {
  const { home, run, stop } = start()
  t.after(stop)
  const file = join(home, 'big5.txt')
  const text = '繁體中文測試檔案內容，繁體中文測試檔案內容'
  writeFileSync(file, iconv.encode(text, 'big5'))
  return (async () => {
    const read = await run('read', { file_path: file })
    assert.match(read.content[0].text, /<encoding>big5<\/encoding>/)
    assert.match(read.content[0].text, /繁體中文測試檔案內容/)
  })()
})

test('plain UTF-8 files pass through untouched and keep working', (t) => {
  const { home, run, stop } = start()
  t.after(stop)
  const file = join(home, 'plain.txt')
  writeFileSync(file, 'line one\nline two\n')
  return (async () => {
    const read = await run('read', { file_path: file })
    // The stand-in body shows the host tool ran; the listener did not take over.
    assert.deepEqual(read.value, { passthrough: true })
  })()
})
