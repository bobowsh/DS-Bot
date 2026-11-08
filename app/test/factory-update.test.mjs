import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import {
  FAILURE_LIMIT,
  archiveUrl,
  dayOf,
  dueForCheck,
  installedPlugins,
  outdated,
  readCatalog,
  readState,
  updateFactoryPlugins,
  watchFactoryPlugins,
  writeState,
} from '../src/factory-update.mjs'
import { packPlugin } from '../scripts/bundled-plugin.mjs'

/** A fetch that answers from a table, so the check can run without the intranet. */
function fakeFetch(routes) {
  return async (url) => {
    // The longest prefix wins: an archive under /pkg/-/ must not be answered with the metadata.
    const entry = routes
      .filter(route => url.startsWith(route.prefix))
      .sort((left, right) => right.prefix.length - left.prefix.length)[0]
    if (entry === undefined) return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) }
    const body = entry.body
    return {
      ok: entry.status === undefined ? true : entry.status < 400,
      status: entry.status ?? 200,
      json: async () => body,
      arrayBuffer: async () => {
        const buffer = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
      },
    }
  }
}

describe('the daily check', () => {
  test('it waits for the hour it runs after', () => {
    assert.equal(dueForCheck(new Date('2026-11-08T21:59:00')), false)
    assert.equal(dueForCheck(new Date('2026-11-08T22:00:00')), true)
    assert.equal(dueForCheck(new Date('2026-11-08T23:30:00')), true)
  })

  test('a day is the day a timestamp belongs to', () => {
    assert.equal(dayOf(new Date('2026-11-08T23:59:00').getTime()), '2026-11-08')
    assert.equal(dayOf(new Date('2026-11-09T00:01:00').getTime()), '2026-11-09')
  })

  test('the state remembers the day and the failures', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ds-bot-update-state-'))
    try {
      assert.deepEqual(await readState(root), { failures: {} })
      await writeState(root, { day: '2026-11-08', failures: { 'dsh-rule-manager': 2 } })
      const state = await readState(root)
      assert.equal(state.day, '2026-11-08')
      assert.equal(state.failures['dsh-rule-manager'], 2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('the catalog', () => {
  test('the plugins it lists keep their name and version', async () => {
    const body = {
      plugins: [
        { name: 'dsh-rule-manager', version: '0.2.0', registry: 'http://registry/' },
        { name: 'broken' },
        { version: '1.0.0' },
      ],
    }
    const catalog = await readCatalog('http://catalog/', fakeFetch([{ prefix: 'http://catalog/', body }]))
    assert.deepEqual(catalog, [{ name: 'dsh-rule-manager', version: '0.2.0', registry: 'http://registry/' }])
  })

  test('a catalog that cannot be read is an error the caller sees', async () => {
    await assert.rejects(() => readCatalog('http://catalog/', fakeFetch([])), /HTTP 404/)
  })

  test('the archive of a version comes from the registry', async () => {
    const body = { versions: { '0.2.0': { dist: { tarball: 'http://registry/pkg/-/pkg-0.2.0.tgz' } } } }
    const url = await archiveUrl('pkg', '0.2.0', 'http://registry/', fakeFetch([{ prefix: 'http://registry/pkg', body }]))
    assert.equal(url, 'http://registry/pkg/-/pkg-0.2.0.tgz')
  })

  test('a version the registry does not hold has no archive', async () => {
    await assert.rejects(() => archiveUrl('pkg', '9.9.9', 'http://registry/', fakeFetch([{ prefix: 'http://registry/pkg', body: { versions: {} } }])), /no archive/)
  })
})

describe('choosing what to update', () => {
  test('only a plugin the profile holds an older version of is updated', () => {
    const installed = { 'dsh-rule-manager': '0.1.0', 'dsh-xdpool': '2.6.1' }
    const catalog = [
      { name: 'dsh-rule-manager', version: '0.2.0' },
      { name: 'dsh-xdpool', version: '2.6.1' },
      { name: 'not-installed', version: '1.0.0' },
    ]
    assert.deepEqual(outdated(installed, catalog), [{ name: 'dsh-rule-manager', version: '0.2.0', current: '0.1.0' }])
  })

  test('the profile reads its own dependencies', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ds-bot-update-profile-'))
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { a: '1.0.0' } }), 'utf8')
      assert.deepEqual(await installedPlugins(root), { a: '1.0.0' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('the update itself', () => {
  let root
  let dataDir
  let profileDir
  let archive
  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'ds-bot-update-'))
    dataDir = join(root, 'data')
    profileDir = join(root, 'profile')
    mkdirSync(join(profileDir, 'node_modules', 'dsh-rule-manager'), { recursive: true })
    writeFileSync(join(profileDir, 'node_modules', 'dsh-rule-manager', 'package.json'), JSON.stringify({ name: 'dsh-rule-manager', version: '0.1.0' }), 'utf8')
    writeFileSync(join(profileDir, 'node_modules', 'dsh-rule-manager', 'old.mjs'), 'old\n', 'utf8')
    const source = join(root, 'source')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'dsh-rule-manager', version: '0.2.0' }), 'utf8')
    writeFileSync(join(source, 'new.mjs'), 'new\n', 'utf8')
    archive = join(root, 'plugin.tgz')
    await packPlugin(source, archive, 'package')
  })
  after(() => { rmSync(root, { recursive: true, force: true }) })
  beforeEach(() => {
    rmSync(join(dataDir), { recursive: true, force: true })
    rmSync(join(profileDir, 'node_modules', 'dsh-rule-manager', 'new.mjs'), { force: true })
    writeFileSync(join(profileDir, 'node_modules', 'dsh-rule-manager', 'package.json'), JSON.stringify({ name: 'dsh-rule-manager', version: '0.1.0' }), 'utf8')
  })

  test('a newer copy replaces the old one', async () => {
    const { updateFactoryPlugins } = await import('../src/factory-update.mjs')
    const fetchImpl = fakeFetch([
      { prefix: 'http://catalog/', body: { plugins: [{ name: 'dsh-rule-manager', version: '0.2.0', registry: 'http://registry/' }] } },
      { prefix: 'http://registry/dsh-rule-manager', body: { versions: { '0.2.0': { dist: { tarball: 'http://registry/pkg/-/pkg-0.2.0.tgz' } } } } },
      { prefix: 'http://registry/pkg/-/', body: readFileSync(archive) },
    ])
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-rule-manager': '0.1.0' } }), 'utf8')
    const outcome = await updateFactoryPlugins({ dataDir, profileDir, catalogUrl: 'http://catalog/', fetch: fetchImpl })
    assert.deepEqual(outcome.updated, ['dsh-rule-manager'])
    assert.deepEqual(outcome.failed, [])
    const installed = join(profileDir, 'node_modules', 'dsh-rule-manager')
    assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version, '0.2.0')
    assert.equal(existsSync(join(installed, 'new.mjs')), true, 'the new file is there')
    assert.equal(existsSync(join(installed, 'old.mjs')), false, 'the old file is gone')
  })

  test('an archive of another version is refused and the old copy stays', async () => {
    const { installUpdate } = await import('../src/factory-update.mjs')
    const outcome = await installUpdate({
      dataDir,
      profileDir,
      name: 'dsh-rule-manager',
      version: '0.3.0',
      archive: readFileSync(archive),
    })
    assert.equal(outcome.updated, false)
    assert.match(outcome.reason, /0\.2\.0/)
    const installed = join(profileDir, 'node_modules', 'dsh-rule-manager')
    assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version, '0.1.0', 'the old copy stays')
  })

  test('the day is only checked once', async () => {
    const fetchImpl = fakeFetch([{ prefix: 'http://catalog/', body: { plugins: [] } }])
    const first = await updateFactoryPlugins({ dataDir, profileDir, catalogUrl: 'http://catalog/', fetch: fetchImpl })
    assert.equal(first.checked, true)
    const second = await updateFactoryPlugins({ dataDir, profileDir, catalogUrl: 'http://catalog/', fetch: fetchImpl })
    assert.equal(second.checked, false)
    assert.match(second.reason, /already checked/)
  })

  test('a plugin that fails three times in a row is left alone for the day', async () => {
    await writeState(dataDir, { day: dayOf(Date.now() - 24 * 60 * 60_000), failures: { 'dsh-rule-manager': FAILURE_LIMIT } })
    const fetchImpl = fakeFetch([
      { prefix: 'http://catalog/', body: { plugins: [{ name: 'dsh-rule-manager', version: '0.2.0' }] } },
    ])
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-rule-manager': '0.1.0' } }), 'utf8')
    const outcome = await updateFactoryPlugins({ dataDir, profileDir, catalogUrl: 'http://catalog/', fetch: fetchImpl })
    assert.deepEqual(outcome.skipped, ['dsh-rule-manager'])
    assert.deepEqual(outcome.updated, [])
  })
})

describe('the watcher', () => {
  test('it does not reach for the network before the hour', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ds-bot-update-watch-'))
    try {
      let asked = 0
      const fetchImpl = async () => { asked += 1; return { ok: false, status: 500, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) } }
      const watcher = watchFactoryPlugins({
        dataDir: root,
        profileDirOf: () => root,
        fetch: fetchImpl,
      })
      await watcher.check()
      watcher.stop()
      assert.equal(asked, 0, 'the check waits for 22:00')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
