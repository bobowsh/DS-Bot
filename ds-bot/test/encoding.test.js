// The encoding layer: the pure helpers that detect, decode and encode.
//
// The layer used to sit in a `tools/execute` hook that read and wrote files
// through Node's `fs`, straight past the host's filesystem service — so a Bot
// with the read-only permission preset could still write. That hook is gone;
// reading now goes through the Bot's own `read` (fs-read-tool.js), which reads
// the bytes through `ctx.fs` and decodes them here.
//
// Writing a file back in its own encoding needs a `writeBytes` the filesystem
// service does not have, so those cases are skipped: see
// docs/plans/2026-11-10-fs-encoding-sandbox.md.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import iconv from 'iconv-lite'
import { decodeBytes, detectEncodingFromBytes, encodeText, namedEncoding, SUPPORTED_ENCODINGS } from '../src/host/encoding.js'

const CN = '你好，世界！编码测试。'

test('a BOM names the encoding outright', () => {
  assert.equal(detectEncodingFromBytes(Buffer.concat([Buffer.from([0xFF, 0xFE]), iconv.encode(CN, 'utf16-le')])), 'utf-16le')
  assert.equal(detectEncodingFromBytes(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(CN, 'utf8')])), 'utf-8-bom')
  assert.equal(detectEncodingFromBytes(Buffer.concat([Buffer.from([0xFE, 0xFF]), iconv.encode(CN, 'utf16-be')])), 'utf-16be')
})

test('strict UTF-8 decides a file with no BOM', () => {
  assert.equal(detectEncodingFromBytes(Buffer.from(CN, 'utf8')), 'utf-8')
})

test('GB18030 and Big5 are found by the fallback probe', () => {
  assert.equal(detectEncodingFromBytes(iconv.encode(CN + '再长一点的中文样本', 'gb18030')), 'gb18030')
  assert.equal(detectEncodingFromBytes(iconv.encode('繁體中文測試檔案內容，繁體中文測試檔案內容', 'big5')), 'big5')
})

test('binary bytes are not text', () => {
  assert.equal(detectEncodingFromBytes(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0x01, 0x02])), undefined)
})

test('decoding strips the BOM and gives the text', () => {
  const bytes = Buffer.concat([Buffer.from([0xFF, 0xFE]), iconv.encode(CN, 'utf16-le')])
  assert.equal(decodeBytes(bytes, 'utf-16le'), CN)
})

test('an unsupported encoding is refused by name', () => {
  assert.throws(() => decodeBytes(Buffer.from('x'), 'shift_jis'), /unsupported encoding/)
  assert.throws(() => encodeText('x', 'shift_jis'), /unsupported encoding/)
})

test('a named encoding is normalized, and an unknown one is refused', () => {
  assert.equal(namedEncoding('GBK'), 'gbk')
  assert.equal(namedEncoding('utf-16-le'), 'utf-16le')
  assert.equal(namedEncoding(undefined), undefined)
  assert.throws(() => namedEncoding('shift_jis'), /unsupported encoding/)
  assert.ok(SUPPORTED_ENCODINGS.includes('gb18030'))
})

test('encoding back gives the bytes the encoding carries', () => {
  assert.deepEqual([...encodeText(CN, 'utf-16le').subarray(0, 2)], [0xFF, 0xFE])
  assert.equal(iconv.decode(encodeText(CN, 'gb18030'), 'gb18030'), CN)
})

// Writing a file back in its own encoding needs `FileSystem.writeBytes(target,
// bytes)` from the host. Until the host has it, the write path stays the
// host's UTF-8 one and the original encoding is not preserved.
test('writing a file back in its own encoding keeps the encoding', { skip: 'needs the host FileSystem.writeBytes(target, bytes)' }, () => {
  assert.equal(iconv.decode(encodeText(CN, 'gb18030'), 'gb18030'), CN)
})
