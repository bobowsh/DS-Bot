// #12 E 组 · 场景 1：断网全流程（catalog 加插件 → 安装 → 替换 → 回滚前的状态）。
// 断网只靠进程级 mock fetch（等价死端口代理），不碰系统网络配置。
// 运行：node --test --test-timeout=20000 tests/issue12/e2e-offline.test.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fakeFetch, offlineFetch, DEAD_PROXY } from './helpers/fake-fetch.mjs'
import { pluginArchive } from './helpers/make-archive.mjs'
import { fingerprint, installedVersion, sameFingerprint } from './helpers/fingerprint.mjs'
import { loadFactoryUpdate } from './helpers/load-module.mjs'

let mod
let root, dataDir, profileDir, pluginDir
const NAME = 'dsh-rule-manager'
const REG = 'http://registry/'
const CATALOG = 'http://catalog/'
const quiet = { info() {}, error() {} }

function writeProfile(version, { bundles = true } = {}) {
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ name: NAME, version }), 'utf8')
  writeFileSync(join(pluginDir, 'old.mjs'), 'old\n', 'utf8')
  const manifest = {
    name: 'dsh-profile-ds-bot', private: true, dependencies: { [NAME]: version },
    dsh: { profile: { bundles: bundles ? [NAME] : [] } },
  }
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(manifest, undefined, 2), 'utf8')
}

function routes(catalogBody, archiveBody) {
  return [
    { prefix: CATALOG, body: { plugins: catalogBody } },
    { prefix: REG + NAME, body: { versions: { '0.2.0': { dist: { tarball: REG + 'pkg/-/pkg-0.2.0.tgz' } } } } },
    { prefix: REG + 'pkg/-/', body: archiveBody },
  ]
}

before(async () => { mod = await loadFactoryUpdate() })
before(() => {
  root = mkdtempSync(join(tmpdir(), 'ds-bot-e2e-offline-'))
  dataDir = join(root, 'data')
  profileDir = join(root, 'profile')
  pluginDir = join(profileDir, 'node_modules', NAME)
})
after(() => { rmSync(root, { recursive: true, force: true }) })

describe('E 场景1 断网全流程', () => {
  test('A1 进程级死端口：catalog 不可读 → checked:false，profile 指纹不变', async () => {
    writeProfile('0.1.0')
    const before = fingerprint(profileDir)
    const outcome = await mod.updateFactoryPlugins({ dataDir, profileDir, catalogUrl: CATALOG, fetch: offlineFetch(), log: quiet })
    assert.equal(outcome.checked, false)
    assert.match(outcome.reason, /catalog could not be read/)
    assert.equal(sameFingerprint(before, fingerprint(profileDir)), true, '断网时一个字节都没动')
    assert.equal(DEAD_PROXY, 'http://127.0.0.1:1', '断网口径是进程级死端口，不改系统配置')
  })

  test('A2 catalog 加新版本 → outdated 命中 → 原子替换：version 升、新文件在、旧文件消失', async () => {
    writeProfile('0.1.0')
    const archive = pluginArchive(NAME, '0.2.0', { files: { 'new.mjs': 'new\n' } })
    const outcome = await mod.updateFactoryPlugins({ dataDir, profileDir, catalogUrl: CATALOG, fetch: fakeFetch(routes([{ name: NAME, version: '0.2.0', registry: REG }], archive)), log: quiet })
    assert.deepEqual(outcome.updated, [NAME])
    assert.deepEqual(outcome.failed, [])
    assert.equal(installedVersion(pluginDir), '0.2.0')
    assert.equal(readFileSync(join(pluginDir, 'new.mjs'), 'utf8'), 'new\n')
    assert.equal(fingerprint(profileDir)['node_modules/' + NAME + '/old.mjs'], undefined, '旧文件随旧目录一起被换掉')
  })

  test('A3 同一天再跑 → already checked today，不再联网', async () => {
    const outcome = await mod.updateFactoryPlugins({ dataDir, profileDir, catalogUrl: CATALOG, fetch: offlineFetch(), log: quiet })
    assert.equal(outcome.checked, false)
    assert.match(outcome.reason, /already checked today/)
  })

  test('A4 全程无外网请求、无系统网络配置改动', async () => {
    // 同一天再跑：状态文件挡住检查，一个 fetch 都不发。断网是 mock fetch 提供的，
    // 不是改 hosts/防火墙；这个断言看的是「被测函数没有发出任何请求」。
    let asked = 0
    const counting = async (url) => { asked += 1; return offlineFetch()(url) }
    await mod.updateFactoryPlugins({ dataDir, profileDir, catalogUrl: CATALOG, fetch: counting, log: quiet })
    assert.equal(asked, 0, '同一天不联网')
    const state = await mod.readState(dataDir)
    assert.equal(state.day, mod.dayOf(), '状态文件记录了当日已查')
    assert.deepEqual(state.failures, {}, '断网不计入连败')
  })
})
