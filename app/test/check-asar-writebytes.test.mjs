// check-asar-writebytes 的判据：从 asar 索引里认每个宿主包带不带 writeBytes 补丁。
//
// checkWriteBytesPatched 是纯函数，喂一个伪造的 index（entries + base + raw）就能验，
// 不需要真打一个 asar——真打 asar 的那条由打包后的产物验证承担。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkWriteBytesPatched, HOST_PACKAGES } from '../scripts/check-asar-writebytes.mjs'

// 把若干段文本拼成一个假 asar 数据区，entries 按 offset 指过去。
function fakeIndex(bodies) {
  const raw = Buffer.concat(bodies.map(b => Buffer.from(b, 'utf8')))
  let at = 0
  const entries = bodies.map((b, i) => {
    const entry = { path: HOST_PACKAGES[i], size: Buffer.byteLength(b, 'utf8'), offset: at }
    at += Buffer.byteLength(b, 'utf8')
    return entry
  })
  return { entries, base: 0, raw }
}

const PATCHED_BODY = 'class FileSystem {\n\tasync writeBytes(target, bytes, expected, signal) { return 1 }\n}\n'
const CLEAN_BODY = 'class FileSystem {\n\tasync writeText(target, content) { return 1 }\n}\n'

test('every host package that carries the method counts as patched', () => {
  const rows = checkWriteBytesPatched(fakeIndex([PATCHED_BODY, PATCHED_BODY, PATCHED_BODY]))
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map(r => r.patched), [true, true, true])
  assert.deepEqual(rows.map(r => r.present), [true, true, true])
})

test('a host package without the method is reported unpatched', () => {
  const rows = checkWriteBytesPatched(fakeIndex([PATCHED_BODY, CLEAN_BODY, PATCHED_BODY]))
  assert.deepEqual(rows.map(r => r.patched), [true, false, true])
})

test('a host package missing from the asar is reported absent and unpatched', () => {
  // 只放两段：第三个宿主包在索引里找不到。
  const rows = checkWriteBytesPatched(fakeIndex([PATCHED_BODY, PATCHED_BODY]))
  assert.equal(rows[2].present, false)
  assert.equal(rows[2].patched, false)
})

test('the patched marker is the method definition, not a passing mention', () => {
  // 一处只把 writeBytes 当字符串提，不是 async writeBytes(target, 的方法定义。
  const mentionOnly = 'const note = "writeBytes";\n'
  const rows = checkWriteBytesPatched(fakeIndex([mentionOnly, PATCHED_BODY, PATCHED_BODY]))
  assert.equal(rows[0].patched, false, 'a bare mention is not the patch')
})
