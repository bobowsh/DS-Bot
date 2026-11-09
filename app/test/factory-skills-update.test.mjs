import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import {
  installedSkills,
  publishedSkills,
  readSyncState,
  readZip,
  syncFactorySkills,
  unpackSkillZip,
  writeSyncState,
} from '../src/factory-skills-update.mjs'

/** A fetch that answers from a table, so the sync runs without the intranet. */
function fakeFetch(routes) {
  return async url => {
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

/** A stored (uncompressed) zip writer: the reader has to walk what a real download produces. */
function makeZip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8')
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0, 8)
    header.writeUInt32LE(file.body.length, 18)
    header.writeUInt32LE(file.body.length, 14)
    header.writeUInt16LE(name.length, 26)
    locals.push(header, name, file.body)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(file.body.length, 20)
    central.writeUInt32LE(file.body.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += 30 + name.length + file.body.length
  }
  const centralStart = offset
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(centralStart, 16)
  return Buffer.concat([...locals, ...centrals, eocd])
}

describe('the SkillHub skill list', () => {
  test('the slugs and their latest versions come out of the wrapped list', async () => {
    const body = { data: { items: [
      { slug: 'grilling', latestVersion: { version: '20261108.022746' } },
      { slug: 'broken' },
      { latestVersion: { version: '1.0.0' } },
    ] } }
    const published = await publishedSkills('http://hub/', fakeFetch([{ prefix: 'http://hub/', body }]))
    assert.deepEqual(published, { grilling: '20261108.022746' })
  })

  test('a list that cannot be read is an error the caller sees', async () => {
    await assert.rejects(() => publishedSkills('http://hub/', fakeFetch([])), /HTTP 404/)
  })
})

describe('the repo and the sync state', () => {
  test('the skills the repo carries are the folders with a SKILL.md', () => {
    const root = mkdtempSync(join(tmpdir(), 'ds-bot-skills-repo-'))
    try {
      mkdirSync(join(root, 'grilling'), { recursive: true })
      writeFileSync(join(root, 'grilling', 'SKILL.md'), '---\nname: grilling\n---\n', 'utf8')
      mkdirSync(join(root, '.git'), { recursive: true })
      mkdirSync(join(root, 'not-a-skill'), { recursive: true })
      assert.deepEqual(installedSkills(root), ['grilling'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('the sync state round-trips', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ds-bot-skills-state-'))
    try {
      assert.deepEqual(await readSyncState(root), { versions: {} })
      await writeSyncState(root, { versions: { grilling: '20261108.022746' } })
      assert.deepEqual(await readSyncState(root), { versions: { grilling: '20261108.022746' } })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('the skill zip', () => {
  test('the reader walks stored members and strips a wrapping folder', async () => {
    const zip = makeZip([
      { path: 'skill/SKILL.md', body: Buffer.from('---\nname: x\n---\n', 'utf8') },
      { path: 'skill/lib/index.mjs', body: Buffer.from('export const ok = true\n', 'utf8') },
    ])
    const files = readZip(zip)
    assert.deepEqual(files.map(file => file.path).sort(), ['skill/SKILL.md', 'skill/lib/index.mjs'])
    const root = mkdtempSync(join(tmpdir(), 'ds-bot-skills-zip-'))
    try {
      await unpackSkillZip(zip, root)
      assert.equal(readFileSync(join(root, 'SKILL.md'), 'utf8').includes('name: x'), true)
      assert.equal(readFileSync(join(root, 'lib', 'index.mjs'), 'utf8').includes('ok = true'), true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a file that is not a zip is refused', async () => {
    assert.throws(() => readZip(Buffer.from('not a zip')), /not a zip archive/)
  })
})

describe('the sync', () => {
  let root
  let dataDir
  let repoDir
  const zip = makeZip([
    { path: 'SKILL.md', body: Buffer.from('---\nname: grilling\n---\nnew\n', 'utf8') },
  ])
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'ds-bot-skills-sync-'))
    dataDir = join(root, 'data')
    repoDir = join(root, 'skills-repo')
  })
  after(() => { rmSync(root, { recursive: true, force: true }) })
  beforeEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(repoDir, { recursive: true, force: true })
    mkdirSync(join(repoDir, 'grilling'), { recursive: true })
    writeFileSync(join(repoDir, 'grilling', 'SKILL.md'), '---\nname: grilling\n---\nold\n', 'utf8')
  })

  test('the first sync records versions without overwriting the repo', async () => {
    const outcome = await syncFactorySkills({
      dataDir,
      repoDir,
      registry: 'http://hub/',
      fetch: fakeFetch([
        { prefix: 'http://hub/', body: { data: { items: [{ slug: 'grilling', latestVersion: { version: '20261108.022746' } }] } } },
        { prefix: 'http://hub/api/v1/skills/', body: zip },
      ]),
    })
    assert.deepEqual(outcome.recorded, ['grilling'])
    assert.deepEqual(outcome.updated, [])
    assert.equal(readFileSync(join(repoDir, 'grilling', 'SKILL.md'), 'utf8').includes('old'), true, 'the repo is untouched')
  })

  test('a changed version is downloaded over the local copy', async () => {
    await writeSyncState(dataDir, { versions: { grilling: '20261108.022746' } })
    const outcome = await syncFactorySkills({
      dataDir,
      repoDir,
      registry: 'http://hub/',
      fetch: fakeFetch([
        { prefix: 'http://hub/', body: { data: { items: [{ slug: 'grilling', latestVersion: { version: '20261109.110000' } }] } } },
        { prefix: 'http://hub/api/v1/skills/', body: zip },
      ]),
    })
    assert.deepEqual(outcome.updated, ['grilling'])
    assert.equal(readFileSync(join(repoDir, 'grilling', 'SKILL.md'), 'utf8').includes('new'), true, 'the new copy landed')
    const state = await readSyncState(dataDir)
    assert.equal(state.versions.grilling, '20261109.110000')
  })

  test('an unchanged version downloads nothing', async () => {
    await writeSyncState(dataDir, { versions: { grilling: '20261108.022746' } })
    const outcome = await syncFactorySkills({
      dataDir,
      repoDir,
      registry: 'http://hub/',
      fetch: fakeFetch([
        { prefix: 'http://hub/', body: { data: { items: [{ slug: 'grilling', latestVersion: { version: '20261108.022746' } }] } } },
        { prefix: 'http://hub/api/v1/skills/', body: zip },
      ]),
    })
    assert.deepEqual(outcome.updated, [])
    assert.equal(readFileSync(join(repoDir, 'grilling', 'SKILL.md'), 'utf8').includes('old'), true, 'the repo is untouched')
  })

  test('a skill the SkillHub dropped is left alone', async () => {
    const outcome = await syncFactorySkills({
      dataDir,
      repoDir,
      registry: 'http://hub/',
      fetch: fakeFetch([{ prefix: 'http://hub/', body: { data: { items: [] } } }]),
    })
    assert.deepEqual(outcome.updated, [])
    assert.equal(existsSyncLike(join(repoDir, 'grilling', 'SKILL.md')), true, 'the skill stays')
  })

  test('a broken archive leaves the local skill untouched', async () => {
    await writeSyncState(dataDir, { versions: { grilling: '20261108.022746' } })
    const outcome = await syncFactorySkills({
      dataDir,
      repoDir,
      registry: 'http://hub/',
      fetch: fakeFetch([
        { prefix: 'http://hub/', body: { data: { items: [{ slug: 'grilling', latestVersion: { version: '20261109.110000' } }] } } },
        { prefix: 'http://hub/api/v1/skills/', body: Buffer.from('definitely not a zip') },
      ]),
    })
    assert.deepEqual(outcome.updated, [])
    assert.deepEqual(outcome.failed, ['grilling'])
    assert.equal(readFileSync(join(repoDir, 'grilling', 'SKILL.md'), 'utf8').includes('old'), true, 'the old copy stays')
    assert.equal(existsSyncLike(join(dataDir, 'skills-update-staging')), false, 'no staging leftover')
    const state = await readSyncState(dataDir)
    assert.equal(state.versions.grilling, '20261108.022746', 'the old version record is kept so the retry re-checks')
  })

  test('an archive without a SKILL.md is refused and the local skill stays', async () => {
    await writeSyncState(dataDir, { versions: { grilling: '20261108.022746' } })
    const outcome = await syncFactorySkills({
      dataDir,
      repoDir,
      registry: 'http://hub/',
      fetch: fakeFetch([
        { prefix: 'http://hub/', body: { data: { items: [{ slug: 'grilling', latestVersion: { version: '20261109.110000' } }] } } },
        { prefix: 'http://hub/api/v1/skills/', body: makeZip([{ path: 'lib/index.mjs', body: Buffer.from('x', 'utf8') }]) },
      ]),
    })
    assert.deepEqual(outcome.updated, [])
    assert.deepEqual(outcome.failed, ['grilling'])
    assert.equal(readFileSync(join(repoDir, 'grilling', 'SKILL.md'), 'utf8').includes('old'), true, 'the old copy stays')
  })
})

function existsSyncLike(path) {
  try {
    return readFileSync(path, 'utf8').length > 0
  } catch {
    return false
  }
}

after(() => {})
