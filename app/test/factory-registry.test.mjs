// The intranet registry wiring in the profile: .npmrc and the SkillHub config overlay.
// The plugin market's catalog is not ours to name — see the comment in src/profile.mjs.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import * as profile from '../src/profile.mjs'
import { NPM_REGISTRY, SKILLHUB_REGISTRY, alignMarketRegion, writeFactoryNpmrc, writeFactoryRegistryPatch } from '../src/profile.mjs'
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

  test('it sets registryUrl on the skillhub-dsh row and pins the market download region', () => {
    const files = writeFactoryRegistryPatch(profile)
    assert.equal(files.length, 1)
    assert.equal(files[0], join(dirname(profile.dir), 'factory-registry.patch.yml'))
    const rows = parse(readFileSync(files[0], 'utf8'))
    assert.equal(rows.length, 2)

    assert.equal(rows[0].id, 'astron-skillhub')
    assert.equal(rows[0].name, '@astron-team/skillhub-dsh')
    assert.deepEqual(rows[0].config, { registryUrl: SKILLHUB_REGISTRY })

    // The market's catalog source order comes from its region: the `global` order asks the
    // project's own domain first, which this network serves at ~10 KB/s for a 15 MB catalog.
    assert.equal(rows[1].id, 'dsh-market')
    assert.deepEqual(rows[1].config, { region: 'china' })
    assert.ok(existsSync(files[0]))
  })
})

describe('the market region on an existing profile', () => {
  let root
  let dir
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'ds-bot-market-region-'))
    dir = join(root, 'profiles', 'ds-bot')
  })
  after(() => { rmSync(root, { recursive: true, force: true }) })

  const writeState = value => {
    mkdirSync(join(dir, '.dsh-market'), { recursive: true })
    writeFileSync(join(dir, '.dsh-market', 'state.json'), `${JSON.stringify(value, undefined, 2)}\n`, 'utf8')
  }
  const readState = () => JSON.parse(readFileSync(join(dir, '.dsh-market', 'state.json'), 'utf8'))

  test('a profile with no market state needs nothing', () => {
    assert.equal(alignMarketRegion(join(root, 'profiles', 'missing')), 'absent')
  })

  test('a region the probe picked is moved to the pinned one', () => {
    writeState({ region: 'global', notes: { keep: 'me' } })
    // The probe records that it chose the region; that is what may be replaced.
    writeState({ region: 'global', regionAuto: true, notes: { keep: 'me' } })
    assert.equal(alignMarketRegion(dir), 'updated')
    const state = readState()
    assert.equal(state.region, 'china')
    assert.equal(state.regionAuto, false)
    // The rest of the user's state is carried over untouched.
    assert.deepEqual(state.notes, { keep: 'me' })
  })

  test('a region the user picked is left alone', () => {
    writeState({ region: 'global', regionAuto: false })
    assert.equal(alignMarketRegion(dir), 'kept')
    assert.equal(readState().region, 'global')
  })

  test('a second launch changes nothing', () => {
    writeState({ region: 'china', regionAuto: false })
    assert.equal(alignMarketRegion(dir), 'kept')
  })
})
