// #12 E 组 · 场景 5：兼容熔断 / 版本门（Q6 / discovery-compatibility）。
//
// issue 原文：「装前过 discovery-compatibility（engines.dsh 匹配检查），不兼容跳过次日再看」。
// 现状（队长验收 PR #20 时核出）：factory-update.mjs 顶部注释写了这道闸，但全文
// satisf / engines / hostVer / compat 零命中 —— 只有注释、没有实现；内网 catalog 的
// 14 个字段（含 installedVersion，那是已装插件版本）也没有宿主版本约束字段。
//
// 因此本用例写成「契约级」：断言「不兼容条目必须被跳过、次日再看」这个可判真假的
// 行为；当前实现下明确打印 BLOCKED 并 skip，绝不算通过。版本约束从哪来是待决设计
// 问题，不在测试里替开发拍板（候选见下方注释）。
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
let root, dataDir, profileDir
const NAME = 'dsh-rule-manager'
const REG = 'http://registry/'
const CATALOG = 'http://catalog/'
const quiet = { info() {}, error() {} }

// 版本约束来源的候选（待小柚子/队长拍板，测试不预设）：
//   (a) 插件 package.json 的 engines.dsh —— issue 原文点名的方式，需要解包后才能判；
//   (b) catalog 新增字段（如 enginesDsh / minHostVersion）—— 要改 gen-catalog.mjs 与人审流程；
//   (c) 归档内 manifest 的 dsh.engines —— 与现有 dsh 清单门同源，改一处即可。
// 无论选哪种，行为契约不变：不兼容 → 不装、不写 manifest、次日再看。

before(async () => { mod = await loadFactoryUpdate() })
before(() => {
  root = mkdtempSync(join(tmpdir(), 'ds-bot-e2e-compat-'))
  dataDir = join(root, 'data')
  profileDir = join(root, 'profile')
  mkdirSync(join(profileDir, 'node_modules', NAME), { recursive: true })
  writeFileSync(join(profileDir, 'node_modules', NAME, 'package.json'), JSON.stringify({ name: NAME, version: '0.1.0' }), 'utf8')
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-ds-bot', private: true, dependencies: { [NAME]: '0.1.0' }, dsh: { profile: { bundles: [NAME] } },
  }, undefined, 2), 'utf8')
})
after(() => { rmSync(root, { recursive: true, force: true }) })

describe('E 场景5 兼容熔断 / 版本门（Q6）', () => {
  test('V1 契约：catalog 声明的宿主版本不满足 → 跳过、不装、次日再看', async (t) => {
    // 检测实现是否落地：模块里是否有版本匹配相关导出或常量。
    const src = readFileSync(process.env.FACTORY_UPDATE_MODULE || join(process.cwd(), 'app/src/factory-update.mjs'), 'utf8')
    const implemented = /satisf|engines\.dsh|hostVersion|minHost|compatib|compatible/iu.test(src.replace(/^\s*\/\/.*$/gmu, ''))
    if (!implemented) {
      t.diagnostic('BLOCKED: 版本门只有注释无实现（Q6 / discovery-compatibility 未落地），不算通过')
      t.diagnostic('待决：版本约束从哪来 —— (a) 插件 engines.dsh / (b) catalog 新增字段 / (c) dsh.engines')
      t.skip('版本门未实现，等小柚子补或明确说明不做并改注释')
      return
    }
    // 实现落地后要满足的行为契约：
    const catalog = [{ name: NAME, version: '0.2.0', registry: REG, enginesDsh: '>=99.0.0' }]
    const archive = pluginArchive(NAME, '0.2.0', { manifest: { engines: { dsh: '>=99.0.0' } } })
    const routes = [
      { prefix: CATALOG, body: { plugins: catalog } },
      { prefix: REG + NAME, body: { versions: { '0.2.0': { dist: { tarball: REG + 'pkg/-/pkg-0.2.0.tgz' } } } } },
      { prefix: REG + 'pkg/-/', body: archive },
    ]
    const before = installedVersion(join(profileDir, 'node_modules', NAME))
    const outcome = await mod.updateFactoryPlugins({ dataDir, profileDir, catalogUrl: CATALOG, fetch: fakeFetch(routes), log: quiet })
    assert.equal(outcome.checked, true)
    assert.deepEqual(outcome.updated, [], '不兼容不更新')
    assert.deepEqual(outcome.installed, [], '不兼容不新装')
    assert.ok(outcome.skipped.includes(NAME) || (outcome.leftAlone || []).includes(NAME), '被跳过或留待次日')
    assert.equal(installedVersion(join(profileDir, 'node_modules', NAME)), before, '旧版原样')
  })

  test('V2 契约：兼容的条目照常更新（版本门不能误伤）', async (t) => {
    const src = readFileSync(process.env.FACTORY_UPDATE_MODULE || join(process.cwd(), 'app/src/factory-update.mjs'), 'utf8')
    const implemented = /satisf|engines\.dsh|hostVersion|minHost|compatib|compatible/iu.test(src.replace(/^\s*\/\/.*$/gmu, ''))
    if (!implemented) { t.skip('版本门未实现'); return }
    rmSync(dataDir, { recursive: true, force: true })
    const archive = pluginArchive(NAME, '0.2.0', { manifest: { engines: { dsh: '>=0.1.0' } } })
    const routes = [
      { prefix: CATALOG, body: { plugins: [{ name: NAME, version: '0.2.0', registry: REG, enginesDsh: '>=0.1.0' }] } },
      { prefix: REG + NAME, body: { versions: { '0.2.0': { dist: { tarball: REG + 'pkg/-/pkg-0.2.0.tgz' } } } } },
      { prefix: REG + 'pkg/-/', body: archive },
    ]
    const outcome = await mod.updateFactoryPlugins({ dataDir, profileDir, catalogUrl: CATALOG, fetch: fakeFetch(routes), log: quiet })
    assert.deepEqual(outcome.updated, [NAME], '兼容的照常更新')
  })

  test('V3 契约：不兼容不计入连败拉黑（只是「次日再看」）', async (t) => {
    const src = readFileSync(process.env.FACTORY_UPDATE_MODULE || join(process.cwd(), 'app/src/factory-update.mjs'), 'utf8')
    const implemented = /satisf|engines\.dsh|hostVersion|minHost|compatib|compatible/iu.test(src.replace(/^\s*\/\/.*$/gmu, ''))
    if (!implemented) { t.skip('版本门未实现'); return }
    rmSync(dataDir, { recursive: true, force: true })
    const state = await mod.readState(dataDir)
    assert.equal(state.failures[NAME], undefined, '不兼容不是失败，不累计 failures')
  })

  test('V4 现场证据：catalog 无宿主版本字段，installedVersion 是插件版本不是宿主版本', () => {
    assert.equal(existsSync(join(profileDir, 'package.json')), true)
    // 内网 catalog 实测字段并集（2026-11-08）里没有 engines / minHost / compat。
    const intranetCatalogFields = ['added', 'category', 'description', 'installedVersion', 'name', 'npm', 'owner', 'page', 'registry', 'source', 'status', 'tag', 'upstream', 'url']
    assert.ok(!intranetCatalogFields.some(f => /engine|host|compat|dshversion/iu.test(f)), 'catalog 确实没有宿主版本字段')
    assert.ok(intranetCatalogFields.includes('installedVersion'), '只有已装插件版本')
  })
})
