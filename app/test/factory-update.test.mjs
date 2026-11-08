import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
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

/**
 * A minimal ustar writer, so the tests can shape the archives the update unpacks without
 * depending on how the installer builds its bundle.
 * @param {{ path: string, body: Buffer }[]} files - the archive's files, under `package/`
 * @returns {Buffer} the gzipped tar
 */
function makeArchive(files) {
  const blocks = []
  for (const file of files) {
    const header = Buffer.alloc(512)
    header.write(file.path.slice(0, 99), 0, 'utf8')
    header.write('0000644\0', 100, 'utf8')
    header.write(String(file.body.length.toString(8)).padStart(11, '0') + '\0', 124, 'utf8')
    header.write('0', 156, 'utf8')
    header.write('ustar\0', 257, 'utf8')
    header.write('00', 263, 'utf8')
    // The checksum is the sum of the header bytes with its own field blanked.
    header.fill(' ', 148, 156)
    let checksum = 0
    for (const byte of header) checksum += byte
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8')
    blocks.push(header, file.body, Buffer.alloc(512 - (file.body.length % 512 || 512)))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

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
  test('an older installed version updates; a same or newer one does not', () => {
    const installed = { 'dsh-rule-manager': '0.1.0', 'dsh-xdpool': '2.6.1' }
    const catalog = [
      { name: 'dsh-rule-manager', version: '0.2.0' },
      { name: 'dsh-xdpool', version: '2.6.1' },
    ]
    assert.deepEqual(outdated(installed, catalog), [{ name: 'dsh-rule-manager', version: '0.2.0', current: '0.1.0' }])
  })

  test('a catalog entry the profile never installed is a new install, not a skip', () => {
    const installed = { 'dsh-rule-manager': '0.1.0' }
    const catalog = [{ name: 'not-installed', version: '1.0.0' }]
    assert.deepEqual(outdated(installed, catalog), [{ name: 'not-installed', version: '1.0.0', current: undefined }])
  })

  test('a catalog entry that has gone leaves the installed plugin alone', () => {
    const installed = { 'dsh-rule-manager': '0.1.0' }
    assert.deepEqual(outdated(installed, []), [])
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
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'ds-bot-update-'))
    dataDir = join(root, 'data')
    profileDir = join(root, 'profile')
    mkdirSync(join(profileDir, 'node_modules', 'dsh-rule-manager'), { recursive: true })
    writeFileSync(join(profileDir, 'node_modules', 'dsh-rule-manager', 'package.json'), JSON.stringify({ name: 'dsh-rule-manager', version: '0.1.0' }), 'utf8')
    writeFileSync(join(profileDir, 'node_modules', 'dsh-rule-manager', 'old.mjs'), 'old\n', 'utf8')
    archive = makeArchive([
      { path: 'package/package.json', body: Buffer.from(JSON.stringify({ name: 'dsh-rule-manager', version: '0.2.0', dsh: { bundle: {} } }), 'utf8') },
      { path: 'package/new.mjs', body: Buffer.from('new\n', 'utf8') },
    ])
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
      { prefix: 'http://registry/pkg/-/', body: archive },
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
      archive: archive,
    })
    assert.equal(outcome.updated, false)
    assert.match(outcome.reason, /0\.2\.0/)
    const installed = join(profileDir, 'node_modules', 'dsh-rule-manager')
    assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version, '0.1.0', 'the old copy stays')
  })

  test('an archive without a dsh manifest is refused', async () => {
    const { installUpdate } = await import('../src/factory-update.mjs')
    const outcome = await installUpdate({
      dataDir,
      profileDir,
      name: 'dsh-rule-manager',
      version: '0.2.0',
      archive: makeArchive([
        { path: 'package/package.json', body: Buffer.from(JSON.stringify({ name: 'dsh-rule-manager', version: '0.2.0' }), 'utf8') },
      ]),
    })
    assert.equal(outcome.updated, false)
    assert.match(outcome.reason, /does not declare itself a DSH plugin/)
    assert.equal(JSON.parse(readFileSync(join(profileDir, 'node_modules', 'dsh-rule-manager', 'package.json'), 'utf8')).version, '0.1.0', 'the old copy stays')
  })

  test('install scripts on a package off the factory list are refused', async () => {
    const { installUpdate } = await import('../src/factory-update.mjs')
    const outcome = await installUpdate({
      dataDir,
      profileDir,
      name: 'dsh-rule-manager',
      version: '0.2.0',
      archive: makeArchive([
        { path: 'package/package.json', body: Buffer.from(JSON.stringify({ name: 'dsh-rule-manager', version: '0.2.0', dsh: { bundle: {} }, scripts: { postinstall: 'node evil.js' } }), 'utf8') },
      ]),
    })
    assert.equal(outcome.updated, false)
    assert.match(outcome.reason, /install scripts/)
    assert.equal(JSON.parse(readFileSync(join(profileDir, 'node_modules', 'dsh-rule-manager', 'package.json'), 'utf8')).version, '0.1.0', 'the old copy stays')
  })

  test('install scripts on a package on the factory list are allowed', async () => {
    const { installUpdate } = await import('../src/factory-update.mjs')
    mkdirSync(join(dataDir, 'factory'), { recursive: true })
    writeFileSync(join(dataDir, 'factory', 'plugins.json'), JSON.stringify({ plugins: ['dsh-rule-manager'] }), 'utf8')
    const outcome = await installUpdate({
      dataDir,
      profileDir,
      name: 'dsh-rule-manager',
      version: '0.2.0',
      archive: makeArchive([
        { path: 'package/package.json', body: Buffer.from(JSON.stringify({ name: 'dsh-rule-manager', version: '0.2.0', dsh: { bundle: {} }, scripts: { postinstall: 'node setup.js' } }), 'utf8') },
      ]),
    })
    assert.equal(outcome.updated, true)
  })

  test('a catalog entry the profile never installed is installed and recorded', async () => {
    const { updateFactoryPlugins } = await import('../src/factory-update.mjs')
    const newArchive = makeArchive([
      { path: 'package/package.json', body: Buffer.from(JSON.stringify({ name: 'brand-new-plugin', version: '1.0.0', dsh: { bundle: {} } }), 'utf8') },
    ])
    const fetchImpl = fakeFetch([
      { prefix: 'http://catalog/', body: { plugins: [{ name: 'brand-new-plugin', version: '1.0.0', registry: 'http://registry/' }] } },
      { prefix: 'http://registry/brand-new-plugin', body: { versions: { '1.0.0': { dist: { tarball: 'http://registry/pkg/-/pkg-1.0.0.tgz' } } } } },
      { prefix: 'http://registry/pkg/-/', body: newArchive },
    ])
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-rule-manager': '0.1.0' } }), 'utf8')
    const outcome = await updateFactoryPlugins({ dataDir, profileDir, catalogUrl: 'http://catalog/', fetch: fetchImpl })
    assert.deepEqual(outcome.installed, ['brand-new-plugin'])
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    assert.equal(manifest.dependencies['brand-new-plugin'], '1.0.0', 'the dependency is recorded')
    assert.ok(manifest.dsh.profile.bundles.includes('brand-new-plugin'), 'the bundle list gains the name')
    assert.equal(existsSync(join(profileDir, 'node_modules', 'brand-new-plugin', 'package.json')), true)
  })

  test('a plugin the reader disabled only gets new files, never the bundle back', async () => {
    const { updateFactoryPlugins } = await import('../src/factory-update.mjs')
    const fetchImpl = fakeFetch([
      { prefix: 'http://catalog/', body: { plugins: [{ name: 'dsh-rule-manager', version: '0.2.0', registry: 'http://registry/' }] } },
      { prefix: 'http://registry/dsh-rule-manager', body: { versions: { '0.2.0': { dist: { tarball: 'http://registry/pkg/-/pkg-0.2.0.tgz' } } } } },
      { prefix: 'http://registry/pkg/-/', body: archive },
    ])
    // The reader turned the plugin off: it stays a dependency but is off the bundle list.
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-rule-manager': '0.1.0' }, dsh: { profile: { bundles: [] } } }), 'utf8')
    const outcome = await updateFactoryPlugins({ dataDir, profileDir, catalogUrl: 'http://catalog/', fetch: fetchImpl })
    assert.deepEqual(outcome.updated, ['dsh-rule-manager'])
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    assert.deepEqual(manifest.dsh.profile.bundles, [], 'the bundle list is untouched')
    assert.equal(JSON.parse(readFileSync(join(profileDir, 'node_modules', 'dsh-rule-manager', 'package.json'), 'utf8')).version, '0.2.0', 'the files moved')
  })

  test('a profile plugin the catalog dropped is left alone', async () => {
    const { updateFactoryPlugins } = await import('../src/factory-update.mjs')
    const fetchImpl = fakeFetch([{ prefix: 'http://catalog/', body: { plugins: [] } }])
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-rule-manager': '0.1.0' } }), 'utf8')
    const outcome = await updateFactoryPlugins({ dataDir, profileDir, catalogUrl: 'http://catalog/', fetch: fetchImpl })
    assert.deepEqual(outcome.leftAlone, ['dsh-rule-manager'])
    assert.deepEqual(outcome.updated, [])
    assert.deepEqual(outcome.installed, [])
    assert.equal(existsSync(join(profileDir, 'node_modules', 'dsh-rule-manager', 'package.json')), true, 'the plugin stays')
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
