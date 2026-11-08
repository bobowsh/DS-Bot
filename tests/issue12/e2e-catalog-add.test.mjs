// #12 E 组 · 场景 2：catalog 条目增删语义（Q2/Q3 + 需求九「禁用过的不写回 bundles」）。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fakeFetch } from './helpers/fake-fetch.mjs'
import { pluginArchive } from './helpers/make-archive.mjs'
import { installedVersion } from './helpers/fingerprint.mjs'
import { loadFactoryUpdate } from './helpers/load-module.mjs'

let mod
let root, dataDir, profileDir
const REG = 'http://registry/'
const CATALOG = 'http://catalog/'
const quiet = { info() {}, error() {} }

function manifest() {
  return JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
}
function writeManifest(dependencies, bundles) {
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-ds-bot', private: true, dependencies,
    dsh: { profile: { bundles } },
  }, undefined, 2), 'utf8')
}
function seed(name, version) {
  const dir = join(profileDir, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }), 'utf8')
}
function routes(plugins, versions) {
  const versionMap = Object.fromEntries(Object.entries(versions).map(([n, v]) => [n, { dist: { tarball: `${REG}pkg/-/${n}-${v}.tgz` } }]))
  return [
    { prefix: CATALOG, body: { plugins } },
    ...Object.keys(versions).map(name => ({ prefix: REG + name, body: { versions: { [versions[name]]: versionMap[name] } } })),
    ...Object.entries(versions).map(([name, v]) => ({ prefix: `${REG}pkg/-/${name}-${v}.tgz`, body: pluginArchive(name, v) })),
  ]
}

before(async () => { mod = await loadFactoryUpdate() })
before(() => {
  root = mkdtempSync(join(tmpdir(), 'ds-bot-e2e-catalog-'))
  dataDir = join(root, 'data')
  profileDir = join(root, 'profile')
})
after(() => { rmSync(root, { recursive: true, force: true }) })

describe('E 场景2 catalog 增删语义', () => {
  test('B1 catalog 新增条目 → 自动装，dependencies 与 bundles 都写入', async () => {
    rmSync(dataDir, { recursive: true, force: true })
    writeManifest({}, [])
    const outcome = await mod.updateFactoryPlugins({
      dataDir, profileDir, catalogUrl: CATALOG,
      fetch: fakeFetch(routes([{ name: 'brand-new', version: '1.0.0', registry: REG }], { 'brand-new': '1.0.0' })),
      log: quiet,
    })
    assert.equal(outcome.checked, true)
    assert.deepEqual(outcome.installed, ['brand-new'], '新条目走 installed 而不是 updated')
    assert.equal(installedVersion(join(profileDir, 'node_modules', 'brand-new')), '1.0.0')
    assert.equal(manifest().dependencies['brand-new'], '1.0.0')
    assert.ok(manifest().dsh.profile.bundles.includes('brand-new'), '自动写进 bundles 启用')
  })

  test('B2 禁用过的插件（bundles 无条目）只升文件，绝不写回 bundles', async () => {
    rmSync(dataDir, { recursive: true, force: true })
    seed('turned-off', '0.1.0')
    writeManifest({ 'turned-off': '0.1.0' }, [])
    const outcome = await mod.updateFactoryPlugins({
      dataDir, profileDir, catalogUrl: CATALOG,
      fetch: fakeFetch(routes([{ name: 'turned-off', version: '0.2.0', registry: REG }], { 'turned-off': '0.2.0' })),
      log: quiet,
    })
    assert.deepEqual(outcome.updated, ['turned-off'])
    assert.equal(installedVersion(join(profileDir, 'node_modules', 'turned-off')), '0.2.0')
    assert.equal(manifest().dsh.profile.bundles.includes('turned-off'), false, '用户禁用状态保持')
  })

  test('B3 catalog 删除条目 → 只停更、不卸载（Q3），leftAlone 报出该插件', async () => {
    rmSync(dataDir, { recursive: true, force: true })
    seed('removed-from-catalog', '0.1.0')
    writeManifest({ 'removed-from-catalog': '0.1.0' }, ['removed-from-catalog'])
    const outcome = await mod.updateFactoryPlugins({
      dataDir, profileDir, catalogUrl: CATALOG,
      fetch: fakeFetch(routes([], {})), log: quiet,
    })
    assert.equal(outcome.checked, true)
    assert.deepEqual(outcome.leftAlone, ['removed-from-catalog'])
    assert.equal(existsSync(join(profileDir, 'node_modules', 'removed-from-catalog', 'package.json')), true, '目录还在')
    assert.ok(manifest().dsh.profile.bundles.includes('removed-from-catalog'), 'bundles 还在')
  })
})
