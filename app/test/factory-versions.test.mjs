// Resolving which version a factory plugin ships at: the registry's latest when it is newer AND
// this app can load it, the manifest's pinned version otherwise. No network: every registry
// answer is supplied here, so the decisions are what is under test.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { candidatesFor, compatibilityOf, hostDshVersion, isNewer } from '../scripts/factory-versions.mjs'
import { factoryRegistries, PUBLIC_REGISTRIES, resolveFactoryVersion } from '../scripts/bundled-plugin.mjs'

// The host the app pins, as src/factory-update.mjs compares it: three numbers, prerelease ignored.
const HOST = { version: '0.2.2-rc.1', packages: new Map([['@deepseek-ai/dsh', '0.2.2-rc.1'], ['@deepseek-ai/dsh-tools', '0.2.2-rc.1'], ['@deepseek-ai/dsh-llm', '0.2.2-rc.1']]) }

/** A registry answer for one package, standing in for the network. */
function fakeRegistry({ latest, manifests = {} }) {
  return async (name) => {
    if (latest[name] === undefined) return { error: 'the registry answered 404' }
    return { version: latest[name] }
  }
}

test('a registry latest that is not newer never replaces the pinned version', () => {
  // Measured on 2026-11-15: npmmirror publishes dsh-aide only as 0.0.0-stage and calls it latest,
  // while npmjs has 0.12.0. Following that tag would silently downgrade a plugin.
  assert.equal(isNewer('0.0.0-stage', '0.12.0'), false, 'a placeholder behind the pinned version')
  assert.equal(isNewer('0.12.0', '0.12.0'), false, 'the same version is not newer')
  assert.equal(isNewer('0.13.0', '0.12.0'), true)
  assert.equal(isNewer('1.73.19', '1.70.2'), true)
  assert.equal(isNewer('not-a-version', '0.1.0'), false, 'an unparseable answer is ignored')
})

test('the candidate list only offers latest when it is newer', () => {
  assert.deepEqual(candidatesFor('0.12.0', '0.0.0-stage'), ['0.12.0'], 'the placeholder is dropped')
  assert.deepEqual(candidatesFor('0.12.0', undefined), ['0.12.0'])
  assert.deepEqual(candidatesFor('0.4.12', '0.4.14'), ['0.4.14', '0.4.12'])
})

test('compatibility reads engines.dsh the way the runtime update path does', () => {
  assert.deepEqual(compatibilityOf({ engines: { dsh: '>=0.2.1-rc.2 <0.3.0' } }, HOST), { compatible: true })
  assert.deepEqual(compatibilityOf({ engines: { dsh: '>=0.2.0-0 <0.3.0' } }, HOST), { compatible: true })
  const out = compatibilityOf({ engines: { dsh: '>=0.3.0' } }, HOST)
  assert.equal(out.compatible, false)
  assert.match(out.reason, /engines\.dsh >=0\.3\.0/u, 'the reason names the range')
  assert.deepEqual(compatibilityOf({}, HOST), { compatible: true }, 'a plugin that declares nothing is fine')
})

test('a peer dependency on a DSH package is checked against the version the app carries', () => {
  const bad = compatibilityOf({ peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.3.0' } }, HOST)
  assert.equal(bad.compatible, false)
  assert.match(bad.reason, /dsh-tools >=0\.3\.0/u)
  assert.deepEqual(compatibilityOf({ peerDependencies: { '@deepseek-ai/dsh-tools': '^0.2.1-rc.1' } }, HOST), { compatible: true })
  // A package this app does not carry is not a refusal: another plugin may bring it.
  assert.deepEqual(compatibilityOf({ peerDependencies: { '@deepseek-ai/dsh-not-here': '>=9.0.0' } }, HOST), { compatible: true })
})

test('a prerelease host is compared the way the host itself compares it', () => {
  // The host runs 0.2.2-rc.1. A plugin that peers on ^0.2.2-rc.2 must be refused, because the
  // host skips it and warns about crashes — this is exactly what happened with
  // dsh-better-sidebar@0.32.1, which used to slip through and got packed anyway.
  assert.equal(compatibilityOf({ peerDependencies: { '@deepseek-ai/dsh-llm': '^0.2.2-rc.2' } }, HOST).compatible, false)
  // Its previous release asks for rc.1 and is fine.
  assert.equal(compatibilityOf({ peerDependencies: { '@deepseek-ai/dsh-llm': '^0.2.2-rc.1' } }, HOST).compatible, true)
  // A range with an rc floor still accepts a newer rc: >=0.2.1-rc.2 covers 0.2.2-rc.1.
  assert.equal(compatibilityOf({ engines: { dsh: '>=0.2.1-rc.2 <0.3.0' } }, HOST).compatible, true)
  assert.equal(compatibilityOf({ engines: { dsh: '>=0.2.0-rc.1' } }, HOST).compatible, true)
})

test('a peer on a package the app carries is checked, not skipped as unknown', () => {
  // dsh-agent is not in app/package.json, it comes in transitively. Before the host map was
  // built from node_modules, a peer on it was silently unverifiable.
  const { packages } = hostDshVersion(fileURLToPath(new URL('..', import.meta.url)))
  assert.ok(packages.size > 100, `every installed dsh package is known (${packages.size})`)
  assert.ok(packages.has('@deepseek-ai/dsh-agent'), 'a transitively installed package is in the map')
})

test('the build pulls from the public mirrors unless the environment names a registry', (t) => {
  const before = process.env.DS_BOT_FACTORY_REGISTRY
  t.after(() => { if (before === undefined) delete process.env.DS_BOT_FACTORY_REGISTRY; else process.env.DS_BOT_FACTORY_REGISTRY = before })
  delete process.env.DS_BOT_FACTORY_REGISTRY
  assert.deepEqual(factoryRegistries(), [...PUBLIC_REGISTRIES], 'npmmirror first, then npmjs')
  assert.equal(PUBLIC_REGISTRIES[0], 'https://registry.npmmirror.com')
  // An intranet build still works by naming its own registry.
  process.env.DS_BOT_FACTORY_REGISTRY = 'http://192.168.1.10:3000/api/packages/dshplugin/npm/'
  assert.deepEqual(factoryRegistries(), ['http://192.168.1.10:3000/api/packages/dshplugin/npm/'])
})
