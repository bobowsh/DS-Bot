// The factory resources: the seed team file lands under the data location on first launch.
// The factory skills and plugins travel inside the data tree itself (data/skills/,
// data/profiles/), so the installer or the first start puts them in place; the seed below is
// the only resource that is version-checked and copied. No Electron, and no network here.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { installFactoryResources } from '../src/factory.mjs'

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

// The app's own resources as the installer ships them: a seed team file.
function resources(root) {
  const dir = join(root, 'resources', `r-${Math.random().toString(36).slice(2)}`)
  write(join(dir, 'factory', 'factory-team.json'), JSON.stringify({ version: '1', bots: [{ factoryId: 'f-chief', name: 'Chief' }], capabilities: { items: {} } }))
  return dir
}

let root
before(() => { root = mkdtempSync(join(tmpdir(), 'ds-bot-factory-')) })
after(() => { rmSync(root, { recursive: true, force: true, maxRetries: 5 }) })

describe('installFactoryResources', () => {
  test('copies the seed team on a first run', async () => {
    const res = resources(root)
    const dataDir = join(root, 'data-a')
    const result = await installFactoryResources({ dataDir, resourcesDir: res })
    assert.equal(result.seedCopied, true)
    assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'factory', 'factory-team.json'), 'utf8')), { version: '1', bots: [{ factoryId: 'f-chief', name: 'Chief' }], capabilities: { items: {} } })
  })

  test('keeps a seed that is ahead of the one the installer carries', async () => {
    // The bundled seed is version 1; a data location carrying 9 is newer, so it wins.
    const res = resources(root)
    const dataDir = join(root, 'data-c')
    write(join(dataDir, 'factory', 'factory-team.json'), JSON.stringify({ version: '9', bots: [{ factoryId: 'user-changed' }] }))
    const result = await installFactoryResources({ dataDir, resourcesDir: res })
    assert.equal(result.seedCopied, false)
    assert.equal(JSON.parse(readFileSync(join(dataDir, 'factory', 'factory-team.json'), 'utf8')).version, '9')
  })

  test('a seed beside the installer that is newer replaces the installed one', async () => {
    // An upgrade ships a higher version, and the factory team has to come with it. Without this
    // an upgraded install keeps applying the seed it was first installed with.
    const res = resources(root)
    const dataDir = join(root, 'data-c2')
    write(join(dataDir, 'factory', 'factory-team.json'), JSON.stringify({ version: '1', bots: [{ factoryId: 'old-team' }] }))
    write(join(res, 'factory', 'factory-team.json'), JSON.stringify({ version: '2', bots: [{ factoryId: 'new-team' }] }))
    const result = await installFactoryResources({ dataDir, resourcesDir: res })
    assert.equal(result.seedCopied, true)
    const applied = JSON.parse(readFileSync(join(dataDir, 'factory', 'factory-team.json'), 'utf8'))
    assert.equal(applied.version, '2')
    assert.equal(applied.bots[0].factoryId, 'new-team')
  })

  test('the same version is left alone, so a seed the user edited stays edited', async () => {
    const res = resources(root)
    const dataDir = join(root, 'data-c3')
    write(join(dataDir, 'factory', 'factory-team.json'), JSON.stringify({ version: '1', bots: [{ factoryId: 'edited-by-user' }] }))
    const result = await installFactoryResources({ dataDir, resourcesDir: res })
    assert.equal(result.seedCopied, false)
    assert.equal(JSON.parse(readFileSync(join(dataDir, 'factory', 'factory-team.json'), 'utf8')).bots[0].factoryId, 'edited-by-user')
  })

  test('answers a missing bundled seed without failing', async () => {
    const bare = join(root, 'resources-bare')
    mkdirSync(bare, { recursive: true })
    const result = await installFactoryResources({ dataDir: join(root, 'data-g'), resourcesDir: bare })
    assert.equal(result.seedCopied, false)
    assert.equal(existsSync(join(root, 'data-g', 'factory', 'factory-team.json')), false)
  })
})

// The seed that actually ships: it is a team for a stranger's machine, so it must carry no model
// (a fresh install has no keys and would open on "model unavailable") and no path from the
// developer's own box. These assertions guard the file itself, not a copy in a temporary directory.
describe('the shipped seed team', () => {
  const seed = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'resources', 'factory', 'factory-team.json'), 'utf8'))

  test('carries a main Bot and more than one member', () => {
    assert.ok(seed.bots.length > 1)
    assert.equal(seed.bots.filter(bot => bot.main === true).length, 1)
    for (const bot of seed.bots) {
      assert.ok(bot.factoryId, `a seed Bot has no factoryId: ${bot.name}`)
      assert.ok(bot.name, 'a seed Bot has no name')
      assert.ok(bot.instructions, `a seed Bot has no instructions: ${bot.name}`)
    }
    const ids = seed.bots.map(bot => bot.factoryId)
    assert.equal(new Set(ids).size, ids.length, 'factoryIds must be unique or an upgrade would refresh the wrong Bot')
  })

  test('carries no model or effort, so a fresh install opens on the model picker', () => {
    for (const bot of seed.bots) {
      assert.equal(bot.model, undefined, `${bot.name} ships a model`)
      assert.equal(bot.effort, undefined, `${bot.name} ships a thinking level`)
    }
  })

  test('carries nothing that only exists on the machine it was written on', () => {
    const text = JSON.stringify(seed)
    // A drive letter path, a UNC path, or the developer's home name.
    assert.doesNotMatch(text, /[A-Za-z]:\\\\/u, 'the seed names an absolute Windows path')
    assert.doesNotMatch(text, /\\\\\\\\(?!")/u, 'the seed names a UNC path')
    for (const bot of seed.bots) {
      assert.equal(bot.workDir, undefined, `${bot.name} ships a working directory`)
      assert.equal(bot.avatar, undefined, `${bot.name} ships an avatar file`)
    }
  })

  test('every seeded capability can be rebuilt from what ships', () => {
    for (const [name, item] of Object.entries(seed.capabilities?.items ?? {})) {
      if (item.kind === 'skill') {
        assert.ok(item.locator || item.content, `${name}: a skill needs a locator into the skills folder or inline content`)
        // The locator is relative to the data directory; the skills live at data/skills/<slug>.
        if (item.locator) assert.match(item.locator, /^skills\//u, `${name}: the skill locator points into data/skills/`)
      } else if (item.kind === 'mcp') {
        const command = item.transport === 'stdio' ? String(item.command ?? '') : String(item.url ?? '')
        assert.ok(command.length > 0, `${name}: an MCP needs a command or a url`)
        assert.doesNotMatch(command, /^[A-Za-z]:[\\\\/]/u, `${name}: an MCP command must not be an absolute path`)
      }
    }
  })
})
