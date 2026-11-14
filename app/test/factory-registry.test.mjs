// The intranet registry wiring in the profile: .npmrc and the SkillHub config overlay.
// The plugin market's catalog is not ours to name — see the comment in src/profile.mjs.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import * as profile from '../src/profile.mjs'
import { NPM_REGISTRY, SKILLHUB_REGISTRY, writeFactoryNpmrc, writeFactoryRegistryPatch } from '../src/profile.mjs'
import { parse } from 'yaml'

describe('the intranet registry addresses', () => {
  test('npm and SkillHub point at the intranet', () => {
    assert.equal(NPM_REGISTRY, 'http://192.168.1.10:3000/api/packages/dshplugin/npm/')
    assert.equal(SKILLHUB_REGISTRY, 'http://192.168.1.10:8081')
  })

  test('the plugin market keeps its own catalog sources: no DSHM_REGISTRY_URL from the app', () => {
    // Setting it REPLACES dshmarket's whole source list (lib/regions.js routesFor), so an
    // intranet address here costs the market its official domain and its npm fallback. While
    // that intranet service was down, the market could not read any catalog at all.
    assert.equal('DSHM_REGISTRY_URL' in profile, false)
    assert.equal('CATALOG_URL' in profile, false)
  })
})

describe('the profile .npmrc', () => {
  let root
  let dir
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'ds-bot-factory-npmrc-'))
    dir = join(root, 'profiles', 'ds-bot')
  })
  after(() => { rmSync(root, { recursive: true, force: true }) })

  test('written with the intranet registry when the profile has none', () => {
    const r = writeFactoryNpmrc(dir)
    assert.deepEqual(r, { written: true, kept: false })
    assert.equal(readFileSync(join(dir, '.npmrc'), 'utf8'), `# managed by LinkHarness factory registries\nregistry=${NPM_REGISTRY}\n`)
  })

  test('a second launch leaves it alone', () => {
    assert.deepEqual(writeFactoryNpmrc(dir), { written: false, kept: false })
  })

  test("a .npmrc the user wrote themselves is kept", () => {
    const own = 'registry=https://registry.npmjs.org/\nstrict-peer-deps=false\n'
    writeFileSync(join(dir, '.npmrc'), own)
    assert.deepEqual(writeFactoryNpmrc(dir), { written: false, kept: true })
    assert.equal(readFileSync(join(dir, '.npmrc'), 'utf8'), own)
  })

  test('any .npmrc without our marker is never overwritten', () => {
    const own = 'registry=http://old.example/\n'
    writeFileSync(join(dir, '.npmrc'), own)
    assert.deepEqual(writeFactoryNpmrc(dir), { written: false, kept: true })
    assert.equal(readFileSync(join(dir, '.npmrc'), 'utf8'), own)
  })

  test('an outdated file of our own is refreshed', () => {
    writeFileSync(join(dir, '.npmrc'), '# managed by LinkHarness factory registries\nregistry=http://old.example/\n')
    assert.deepEqual(writeFactoryNpmrc(dir), { written: true, kept: false })
    assert.equal(readFileSync(join(dir, '.npmrc'), 'utf8'), `# managed by LinkHarness factory registries\nregistry=${NPM_REGISTRY}\n`)
  })
})

describe('the SkillHub config overlay', () => {
  let root
  let profile
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'ds-bot-factory-patch-'))
    profile = { dir: join(root, 'profiles', 'ds-bot') }
  })
  after(() => { rmSync(root, { recursive: true, force: true }) })

  test('it sets registryUrl on the skillhub-dsh loader row and reports it for patchFiles', () => {
    const files = writeFactoryRegistryPatch(profile)
    assert.equal(files.length, 1)
    assert.equal(files[0], join(dirname(profile.dir), 'factory-registry.patch.yml'))
    const rows = parse(readFileSync(files[0], 'utf8'))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, 'astron-skillhub')
    assert.equal(rows[0].name, '@astron-team/skillhub-dsh')
    assert.deepEqual(rows[0].config, { registryUrl: SKILLHUB_REGISTRY })
    assert.ok(existsSync(files[0]))
  })
})
