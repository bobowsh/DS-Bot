// #12 E 组脚手架自检：只验证 helpers 本身可用，不实跑任何验收场景。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { fakeFetch, offlineFetch, DEAD_PROXY } from './fake-fetch.mjs'
import { makeArchive, pluginArchive, brokenArchive } from './make-archive.mjs'
import { fingerprint, sameFingerprint, installedVersion, existsWithFiles } from './fingerprint.mjs'

// 1) fakeFetch 最长前缀命中 + 未命中按断网处理
const fetcher = fakeFetch([
  { prefix: 'http://catalog/', body: { plugins: [] } },
  { prefix: 'http://registry/pkg/-/', body: Buffer.from('tgz-bytes') },
])
assert.deepEqual(await (await fetcher('http://catalog/x')).json(), { plugins: [] })
assert.equal((await fetcher('http://registry/pkg/-/a.tgz')).status, 200)
assert.equal((await fetcher('http://elsewhere/')).ok, false)
assert.equal((await fetcher('http://elsewhere/')).status, 0)
assert.equal((await offlineFetch()('http://catalog/')).ok, false)
assert.equal(DEAD_PROXY, 'http://127.0.0.1:1')

// 2) 打包器造出的 tgz 能被 gunzip + 读出 ustar 头（factory-update.readTgz 的输入形状）
const tgz = pluginArchive('dsh-rule-manager', '0.2.0', { 'new.mjs': 'new\n' })
const raw = gunzipSync(tgz)
assert.ok(raw.length > 1024, '解出非空 tar')
assert.ok(raw.subarray(0, 100).toString('utf8').includes('package/package.json'))
assert.ok(tgz.length > 0 && makeArchive([{ path: 'package/a', body: Buffer.from('x') }]).length > 0)
assert.ok(brokenArchive().length > 0)

// 3) 指纹：同内容相同、改文件后不同；version 读取；目录存在判定
const root = mkdtempSync(join(tmpdir(), 'ds-bot-e2e-selfcheck-'))
try {
  const dir = join(root, 'plugin')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }), 'utf8')
  const before = fingerprint(dir)
  assert.equal(installedVersion(dir), '1.0.0')
  assert.equal(existsWithFiles(dir), true)
  assert.equal(sameFingerprint(before, fingerprint(dir)), true)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '2.0.0' }), 'utf8')
  assert.equal(installedVersion(dir), '2.0.0')
  assert.equal(sameFingerprint(before, fingerprint(dir)), false, '改版本号后指纹变化')
} finally { rmSync(root, { recursive: true, force: true }) }

console.log('helpers selfcheck: OK (fakeFetch / makeArchive / fingerprint 全部可用)')
console.log('注意：仅自检 helpers，E 组三个验收场景未实跑')
