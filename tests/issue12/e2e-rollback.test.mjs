// #12 E 组 · 场景 3：失败回滚与 C4 闸门（换到一半失败要退回旧版）。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fakeFetch } from './helpers/fake-fetch.mjs'
import { pluginArchive, brokenArchive } from './helpers/make-archive.mjs'
import { fingerprint, installedVersion, sameFingerprint } from './helpers/fingerprint.mjs'
import { loadFactoryUpdate } from './helpers/load-module.mjs'

let mod
let root, dataDir, profileDir, pluginDir
const NAME = 'dsh-rule-manager'
const REG = 'http://registry/'
const CATALOG = 'http://catalog/'
const quiet = { info() {}, error() {} }

function seed(version = '0.1.0') {
  rmSync(dataDir, { recursive: true, force: true })
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ name: NAME, version }), 'utf8')
  writeFileSync(join(pluginDir, 'old.mjs'), 'old\n', 'utf8')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-ds-bot', private: true, dependencies: { [NAME]: version }, dsh: { profile: { bundles: [NAME] } },
  }, undefined, 2), 'utf8')
}
function catalog(version, registry = REG) {
  return { prefix: CATALOG, body: { plugins: [{ name: NAME, version, registry }] } }
}
function meta(version) {
  return { prefix: REG + NAME, body: { versions: { [version]: { dist: { tarball: `${REG}pkg/-/pkg-${version}.tgz` } } } } }
}
function tgz(version, archive) {
  return { prefix: `${REG}pkg/-/pkg-${version}.tgz`, body: archive }
}
function run(routes) {
  return mod.updateFactoryPlugins({ dataDir, profileDir, catalogUrl: CATALOG, fetch: fakeFetch(routes), log: quiet })
}

before(async () => { mod = await loadFactoryUpdate() })
before(() => {
  root = mkdtempSync(join(tmpdir(), 'ds-bot-e2e-rollback-'))
  dataDir = join(root, 'data')
  profileDir = join(root, 'profile')
  pluginDir = join(profileDir, 'node_modules', NAME)
})
after(() => { rmSync(root, { recursive: true, force: true }) })

describe('E 场景3 失败回滚', () => {
  test('C1 archive 版本与 catalog 不符 → 拒装、旧版与指纹不变', async () => {
    seed()
    const before = fingerprint(profileDir)
    const outcome = await run([catalog('0.2.0'), meta('0.2.0'), tgz('0.2.0', pluginArchive(NAME, '0.9.9'))])
    assert.deepEqual(outcome.updated, [])
    assert.deepEqual(outcome.failed, [NAME])
    assert.equal(installedVersion(pluginDir), '0.1.0')
    assert.equal(sameFingerprint(before, fingerprint(profileDir)), true)
  })

  test('C2 archive 解包失败（非法 gzip）→ 拒装、旧版不变', async () => {
    seed()
    const before = fingerprint(profileDir)
    const outcome = await run([catalog('0.2.0'), meta('0.2.0'), tgz('0.2.0', brokenArchive())])
    assert.deepEqual(outcome.failed, [NAME])
    assert.equal(installedVersion(pluginDir), '0.1.0')
    assert.equal(sameFingerprint(before, fingerprint(profileDir)), true)
  })

  test('C3 archive 无 dsh 清单（C4 门）→ 拒装、旧版不变', async () => {
    seed()
    const before = fingerprint(profileDir)
    const outcome = await run([catalog('0.2.0'), meta('0.2.0'), tgz('0.2.0', pluginArchive(NAME, '0.2.0', { noDsh: true }))])
    assert.deepEqual(outcome.failed, [NAME])
    assert.equal(sameFingerprint(before, fingerprint(profileDir)), true)
  })

  test('C4 带 install scripts 且不在出厂清单 → 拒装；在出厂清单上则放行', async () => {
    seed()
    const withScripts = pluginArchive(NAME, '0.2.0', { manifest: { scripts: { postinstall: 'node x.js' } } })
    const blocked = await run([catalog('0.2.0'), meta('0.2.0'), tgz('0.2.0', withScripts)])
    assert.deepEqual(blocked.failed, [NAME])
    assert.equal(installedVersion(pluginDir), '0.1.0')

    seed()
    mkdirSync(join(dataDir, 'factory'), { recursive: true })
    writeFileSync(join(dataDir, 'factory', 'plugins.json'), JSON.stringify({ plugins: [NAME] }), 'utf8')
    const allowed = await run([catalog('0.2.0'), meta('0.2.0'), tgz('0.2.0', withScripts)])
    assert.deepEqual(allowed.updated, [NAME], '出厂清单上的包允许带 install scripts')
    assert.equal(installedVersion(pluginDir), '0.2.0')
  })

  test('C5 连败 3 次拉黑 → skipped，当日不再尝试', async () => {
    seed()
    const bad = [catalog('0.2.0'), meta('0.2.0'), tgz('0.2.0', brokenArchive())]
    for (let i = 0; i < 3; i++) {
      rmSync(dataDir, { recursive: true, force: true })
      // 保留失败计数，只把「今日已查」清掉，让每次都真的尝试
      const stateFile = join(dataDir, 'factory-update.json')
      await mod.writeState(dataDir, { failures: { [NAME]: i } })
      const outcome = await run(bad)
      assert.deepEqual(outcome.failed, [NAME])
      assert.equal((await mod.readState(dataDir)).failures[NAME], i + 1)
      void stateFile
    }
    rmSync(dataDir, { recursive: true, force: true })
    await mod.writeState(dataDir, { failures: { [NAME]: mod.FAILURE_LIMIT } })
    const outcome = await run(bad)
    assert.deepEqual(outcome.skipped, [NAME])
    assert.deepEqual(outcome.failed, [])
    assert.equal(installedVersion(pluginDir), '0.1.0')
  })

  test('C6 每次失败后 staging / backup 不留半成品', async () => {
    seed()
    await run([catalog('0.2.0'), meta('0.2.0'), tgz('0.2.0', brokenArchive())])
    assert.equal(existsSync(join(dataDir, 'factory-update-staging', NAME)), false)
    assert.equal(existsSync(join(dataDir, 'factory-update-backup', NAME)), false)
  })
})
