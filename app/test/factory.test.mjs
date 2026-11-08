// The factory resources: the seed team file and the bundled skills repo land under the data
// location on first launch. The skills repo ships as a repository of its own and is only
// copied — the first run never reaches the network — and later starts update it with a pull
// from the remote the repository carries. No Electron, and no network in any of these tests.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { installFactoryResources, pullSkillsRepo, skillsRepoRemote } from '../src/factory.mjs'

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

// The app's own resources as the installer ships them: a seed team and one skill, shipped as
// a repository (its .git is made by scripts/skills-repo-git.mjs before the pack).
function resources(root, { git = true } = {}) {
  const dir = join(root, 'resources', `r-${Math.random().toString(36).slice(2)}`)
  write(join(dir, 'factory', 'factory-team.json'), JSON.stringify({ version: '1', bots: [{ factoryId: 'f-chief', name: 'Chief' }], capabilities: { items: {} } }))
  write(join(dir, 'skills-repo', 'review-skill', 'SKILL.md'), '# review-skill\n')
  write(join(dir, 'skills-repo', 'review-skill', 'scripts', 'run.mjs'), 'console.log(1)\n')
  if (git) write(join(dir, 'skills-repo', '.git', 'HEAD'), 'ref: refs/heads/main\n')
  return dir
}

// A git stand-in: the pull is exercised without the package or the network.
const fakeGit = url => ({ getConfig: async () => (url === undefined ? undefined : url) })

let root
before(() => { root = mkdtempSync(join(tmpdir(), 'ds-bot-factory-')) })
after(() => { rmSync(root, { recursive: true, force: true, maxRetries: 5 }) })

describe('installFactoryResources', () => {
  test('copies the seed team and the skills repo, git dir included, on a first run', async () => {
    const res = resources(root)
    const dataDir = join(root, 'data-a')
    const result = await installFactoryResources({ dataDir, resourcesDir: res })
    assert.equal(result.seedCopied, true)
    assert.equal(result.repo, 'copied')
    assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'factory', 'factory-team.json'), 'utf8')), { version: '1', bots: [{ factoryId: 'f-chief', name: 'Chief' }], capabilities: { items: {} } })
    assert.equal(readFileSync(join(dataDir, 'skills-repo', 'review-skill', 'SKILL.md'), 'utf8'), '# review-skill\n')
    assert.equal(existsSync(join(dataDir, 'skills-repo', 'review-skill', 'scripts', 'run.mjs')), true)
    // The copied repository can pull: the shipped .git travels with it.
    assert.equal(existsSync(join(dataDir, 'skills-repo', '.git', 'HEAD')), true)
  })

  test('never reaches the network, whatever remote the installation already names', async () => {
    const res = resources(root)
    const dataDir = join(root, 'data-b')
    const result = await installFactoryResources({ dataDir, resourcesDir: res })
    // There is no clone step left: an unreachable remote changes nothing about a first run.
    assert.equal(result.repo, 'copied')
    assert.equal(result.reason, undefined)
    assert.equal(readFileSync(join(dataDir, 'skills-repo', 'review-skill', 'SKILL.md'), 'utf8'), '# review-skill\n')
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

  test('leaves a skills repo that is already there alone', async () => {
    const res = resources(root)
    const dataDir = join(root, 'data-d')
    write(join(dataDir, 'skills-repo', '.git', 'HEAD'), 'ref: refs/heads/main\n')
    write(join(dataDir, 'skills-repo', 'review-skill', 'SKILL.md'), '# user version\n')
    const result = await installFactoryResources({ dataDir, resourcesDir: res })
    assert.equal(result.repo, 'kept')
    assert.equal(readFileSync(join(dataDir, 'skills-repo', 'review-skill', 'SKILL.md'), 'utf8'), '# user version\n')
  })

  test('hands the shipped git dir to a repo that arrived without one, keeping its files', async () => {
    const res = resources(root)
    const dataDir = join(root, 'data-e')
    write(join(dataDir, 'skills-repo', 'review-skill', 'SKILL.md'), '# user version\n')
    const result = await installFactoryResources({ dataDir, resourcesDir: res })
    assert.equal(result.repo, 'git-added')
    assert.equal(readFileSync(join(dataDir, 'skills-repo', 'review-skill', 'SKILL.md'), 'utf8'), '# user version\n')
    assert.equal(existsSync(join(dataDir, 'skills-repo', '.git', 'HEAD')), true)
  })

  test('copies a bundle that carries no git dir, and only says so', async () => {
    const dataDir = join(root, 'data-f')
    const result = await installFactoryResources({ dataDir, resourcesDir: resources(root, { git: false }) })
    assert.equal(result.repo, 'copied')
    assert.equal(existsSync(join(dataDir, 'skills-repo', '.git')), false)
    assert.equal(existsSync(join(dataDir, 'skills-repo', 'review-skill', 'SKILL.md')), true)
  })

  test('answers a missing bundled repo without failing', async () => {
    const bare = join(root, 'resources-bare')
    write(join(bare, 'factory', 'factory-team.json'), JSON.stringify({ version: '1', bots: [{ factoryId: 'x' }] }))
    const result = await installFactoryResources({ dataDir: join(root, 'data-g'), resourcesDir: bare })
    assert.equal(result.repo, 'kept')
    assert.equal(result.reason, 'no bundled skills repo')
    assert.equal(existsSync(join(root, 'data-g', 'skills-repo')), false)
  })
})

describe('skillsRepoRemote', () => {
  test('prefers the environment and falls back to the repository configuration', async () => {
    assert.equal(await skillsRepoRemote('dir', fakeGit('http://192.168.1.10:3000/wangsh/skills-repo.git'), {}), 'http://192.168.1.10:3000/wangsh/skills-repo.git')
    assert.equal(await skillsRepoRemote('dir', fakeGit('http://from-config/'), { DS_BOT_SKILLS_REPO: 'http://from-env/' }), 'http://from-env/')
    assert.equal(await skillsRepoRemote('dir', fakeGit(undefined), {}), '')
    assert.equal(await skillsRepoRemote('dir', { getConfig: async () => { throw new Error('no config') } }, {}), '')
  })
})

describe('pullSkillsRepo', () => {
  test('does nothing for a copy that is not a git repo', async () => {
    const dataDir = join(root, 'data-h')
    await installFactoryResources({ dataDir, resourcesDir: resources(root) })
    await pullSkillsRepo({ dataDir, env: {} })
    assert.equal(readFileSync(join(dataDir, 'skills-repo', 'review-skill', 'SKILL.md'), 'utf8'), '# review-skill\n')
  })

  test('does nothing, and warns about nothing, when the repository has no remote', async () => {
    const dataDir = join(root, 'data-i')
    write(join(dataDir, 'skills-repo', '.git', 'HEAD'), 'ref: refs/heads/main\n')
    write(join(dataDir, 'skills-repo', 'review-skill', 'SKILL.md'), '# kept\n')
    const warnings = []
    const warn = console.warn
    console.warn = (...args) => { warnings.push(args.join(' ')) }
    try {
      await pullSkillsRepo({ dataDir, env: {} })
    } finally {
      console.warn = warn
    }
    assert.deepEqual(warnings, [])
    assert.equal(readFileSync(join(dataDir, 'skills-repo', 'review-skill', 'SKILL.md'), 'utf8'), '# kept\n')
  })

  test('swallows a failing fetch and leaves the skills in place', async () => {
    const dataDir = join(root, 'data-j')
    write(join(dataDir, 'skills-repo', '.git', 'HEAD'), 'ref: refs/heads/main\n')
    write(join(dataDir, 'skills-repo', 'review-skill', 'SKILL.md'), '# kept\n')
    const warnings = []
    const warn = console.warn
    console.warn = (...args) => { warnings.push(args.join(' ')) }
    try {
      await pullSkillsRepo({ dataDir, env: { DS_BOT_SKILLS_REPO: 'http://127.0.0.1:1/never.git' } })
    } finally {
      console.warn = warn
    }
    assert.equal(readFileSync(join(dataDir, 'skills-repo', 'review-skill', 'SKILL.md'), 'utf8'), '# kept\n')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /the skills repo was not updated/u)
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
        assert.ok(item.locator || item.content, `${name}: a skill needs a locator into the skills repo or inline content`)
      } else if (item.kind === 'mcp') {
        const command = item.transport === 'stdio' ? String(item.command ?? '') : String(item.url ?? '')
        assert.ok(command.length > 0, `${name}: an MCP needs a command or a url`)
        assert.doesNotMatch(command, /^[A-Za-z]:[\\\\/]/u, `${name}: an MCP command must not be an absolute path`)
      }
    }
  })
})