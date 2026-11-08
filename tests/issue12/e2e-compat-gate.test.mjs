// #12 E 组 · 场景 5：兼容熔断 / 版本门（Q6 / discovery-compatibility）。
//
// issue 原文：「装前过 discovery-compatibility（engines.dsh 匹配检查），不兼容跳过次日再看」。
// 现状（2026-11-08 复核）：小柚子已在 installUpdate 里实现 satisfiesDshRange + engines.dsh
// 门（解包后、替换前，与 dsh 清单门同源，即队长倾向的 (c) 方案）；但 updateFactoryPlugins
// 调用 installUpdate 时还没透传 hostVersion，且不兼容会被当成普通失败累计 failures。
//
// 因此本用例分两层：
//   - V1/V2/V3 直接调 installUpdate 验证「门本身」的行为契约（能真跑、要真过）；
//   - V5 验证主链路透传与「次日再看」语义，透传未落地就 BLOCKED skip，不算通过。
//
// 运行：node --test --test-timeout=20000 tests/issue12/e2e-compat-gate.test.mjs
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
let root, dataDir, profileDir, pluginDir
const NAME = 'dsh-rule-manager'
const REG = 'http://registry/'
const CATALOG = 'http://catalog/'
const HOST = '0.2.2-rc.1'
const quiet = { info() {}, error() {} }

before(async () => { mod = await loadFactoryUpdate() })
before(() => {
  root = mkdtempSync(join(tmpdir(), 'ds-bot-e2e-compat-'))
  dataDir = join(root, 'data')
  profileDir = join(root, 'profile')
  pluginDir = join(profileDir, 'node_modules', NAME)
})
after(() => { rmSync(root, { recursive: true, force: true }) })

function seed(version = '0.1.0') {
  rmSync(dataDir, { recursive: true, force: true })
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ name: NAME, version }), 'utf8')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-ds-bot', private: true, dependencies: { [NAME]: version }, dsh: { profile: { bundles: [NAME] } },
  }, undefined, 2), 'utf8')
}

function moduleSource() {
  return readFileSync(process.env.FACTORY_UPDATE_MODULE || join(process.cwd(), 'app/src/factory-update.mjs'), 'utf8')
}
// 精确判断：updateFactoryPlugins 里的 installUpdate 调用点是否带 hostVersion。
// 只看「调用参数对象」这一处，避免被 installUpdate 自己的形参/文档注释里的 hostVersion 误导。
function hostVersionWired() {
  const code = moduleSource().replace(/^\s*\/\/.*$/gmu, '')
  const fn = code.indexOf('export async function updateFactoryPlugins')
  if (fn < 0) return false
  const body = code.slice(fn, code.indexOf('\n}', fn) + 2)
  const call = body.match(/installUpdate\s*\(\s*\{([^}]*)\}\s*\)/u)
  return !!call && /hostVersion/u.test(call[1])
}

describe('E 场景5 兼容熔断 / 版本门（Q6）', () => {
  test('V1 门本身：归档 engines.dsh 与宿主版本不符 → 拒装、旧版原样', async (t) => {
    if (typeof mod.installUpdate !== 'function') { t.skip('installUpdate 未导出'); return }
    seed()
    const before = installedVersion(pluginDir)
    const archive = pluginArchive(NAME, '0.2.0', { manifest: { engines: { dsh: '>=99.0.0' } } })
    const outcome = await mod.installUpdate({ dataDir, profileDir, name: NAME, version: '0.2.0', archive, hostVersion: HOST })
    assert.equal(outcome.updated, false, '不兼容不装')
    assert.equal(outcome.incompatible, true, '明确标记为不兼容，不是普通失败')
    assert.match(outcome.reason || '', /engines\.dsh/u)
    assert.equal(installedVersion(pluginDir), before, '旧版原样')
  })

  test('V2 门本身：engines.dsh 满足 → 正常替换，不误伤', async (t) => {
    if (typeof mod.installUpdate !== 'function') { t.skip('installUpdate 未导出'); return }
    seed()
    const archive = pluginArchive(NAME, '0.2.0', { manifest: { engines: { dsh: '>=0.2.0' } } })
    const outcome = await mod.installUpdate({ dataDir, profileDir, name: NAME, version: '0.2.0', archive, hostVersion: HOST })
    assert.equal(outcome.updated, true, '兼容的照常更新')
    assert.equal(installedVersion(pluginDir), '0.2.0')
  })

  test('V3 门本身：未声明 engines.dsh 的包不受影响', async (t) => {
    if (typeof mod.installUpdate !== 'function') { t.skip('installUpdate 未导出'); return }
    seed()
    const archive = pluginArchive(NAME, '0.2.0')
    const outcome = await mod.installUpdate({ dataDir, profileDir, name: NAME, version: '0.2.0', archive, hostVersion: HOST })
    assert.equal(outcome.updated, true)
  })

  test('V4 现场证据：catalog 无宿主版本字段，installedVersion 是插件版本', () => {
    const intranetCatalogFields = ['added', 'category', 'description', 'installedVersion', 'name', 'npm', 'owner', 'page', 'registry', 'source', 'status', 'tag', 'upstream', 'url']
    assert.ok(!intranetCatalogFields.some(f => /engine|host|compat|dshversion/iu.test(f)))
    assert.ok(intranetCatalogFields.includes('installedVersion'))
  })

  test('V5 主链路：不兼容条目被跳过、次日再看、不计连败', async (t) => {
    if (!hostVersionWired()) {
      t.diagnostic('BLOCKED: updateFactoryPlugins 调用 installUpdate 时未透传 hostVersion，版本门在主链路不生效')
      t.diagnostic('解除条件：补上 hostVersion 透传，并把 incompatible 归入 skipped 而非 failures')
      t.skip('主链路未透传 hostVersion，不算通过')
      return
    }
    seed()
    const archive = pluginArchive(NAME, '0.2.0', { manifest: { engines: { dsh: '>=99.0.0' } } })
    const routes = [
      { prefix: CATALOG, body: { plugins: [{ name: NAME, version: '0.2.0', registry: REG }] } },
      { prefix: REG + NAME, body: { versions: { '0.2.0': { dist: { tarball: `${REG}pkg/-/pkg-0.2.0.tgz` } } } } },
      { prefix: `${REG}pkg/-/`, body: archive },
    ]
    const outcome = await mod.updateFactoryPlugins({ dataDir, profileDir, catalogUrl: CATALOG, fetch: fakeFetch(routes), log: quiet, hostVersion: HOST })
    assert.deepEqual(outcome.updated, [], '不兼容不更新')
    assert.ok(outcome.skipped.includes(NAME), '归入 skipped（次日再看）')
    assert.equal((await mod.readState(dataDir)).failures[NAME], undefined, '不兼容不计连败')
    assert.equal(installedVersion(pluginDir), '0.1.0')
    assert.equal(existsSync(join(profileDir, 'package.json')), true)
  })
})
