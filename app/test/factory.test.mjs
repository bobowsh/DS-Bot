// The factory resources: the seed team file and the bundled skills repo land under the data
// location on first launch, an existing seed is never overwritten, and everything falls back to
// the bundled copy when there is no remote or no isomorphic-git. No Electron and no network.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { installFactoryResources, pullSkillsRepo } from '../src/factory.mjs'

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

// The app's own resources as the installer ships them: a seed team and one skill.
function resources(root) {
  const dir = join(root, 'resources')
  write(join(dir, 'factory', 'factory-team.json'), JSON.stringify({ version: '1', bots: [{ factoryId: 'f-chief', name: 'Chief' }], capabilities: { items: {} } }))
  write(join(dir, 'skills-repo', 'review-skill', 'SKILL.md'), '# review-skill\n')
  write(join(dir, 'skills-repo', 'review-skill', 'scripts', 'run.mjs'), 'console.log(1)\n')
  return dir
}

let root
before(() => { root = mkdtempSync(join(tmpdir(), 'ds-bot-factory-')) })
after(() => { rmSync(root, { recursive: true, force: true, maxRetries: 5 }) })

describe('installFactoryResources', () => {
  test('copies the seed team and the bundled skills repo on a first run', async () => {
    const res = resources(root)
    const dataDir = join(root, 'data-a')
    const result = await installFactoryResources({ dataDir, resourcesDir: res })
    assert.equal(result.seedCopied, true)
    assert.equal(result.repo, 'copied')
    assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'factory', 'factory-team.json'), 'utf8')), { version: '1', bots: [{ factoryId: 'f-chief', name: 'Chief' }], capabilities: { items: {} } })
    assert.equal(readFileSync(join(dataDir, 'skills-repo', 'review-skill', 'SKILL.md'), 'utf8'), '# review-skill\n')
    assert.equal(existsSync(join(dataDir, 'skills-repo', 'review-skill', 'scripts', 'run.mjs')), true)
  })

  test('never overwrites a seed the data location already carries', async () => {
    const res = resources(root)
    const dataDir = join(root, 'data-b')
    write(join(dataDir, 'factory', 'factory-team.json'), JSON.stringify({ version: '9', bots: [{ factoryId: 'user-changed' }] }))
    const result = await installFactoryResources({ dataDir, resourcesDir: res })
    assert.equal(result.seedCopied, false)
    assert.equal(JSON.parse(readFileSync(join(dataDir, 'factory', 'factory-team.json'), 'utf8')).version, '9')
  })

  test('leaves a skills repo that is already there alone', async () => {
    const res = resources(root)
    const dataDir = join(root, 'data-c')
    write(join(dataDir, 'skills-repo', '.git', 'HEAD'), 'ref: refs/heads/main\n')
    write(join(dataDir, 'skills-repo', 'review-skill', 'SKILL.md'), '# user version\n')
    const result = await installFactoryResources({ dataDir, resourcesDir: res })
    assert.equal(result.repo, 'kept')
    assert.equal(readFileSync(join(dataDir, 'skills-repo', 'review-skill', 'SKILL.md'), 'utf8'), '# user version\n')
  })

  test('reports no remote when the seed names none', async () => {
    const res = resources(root)
    const result = await installFactoryResources({ dataDir: join(root, 'data-d'), resourcesDir: res })
    assert.equal(result.repo, 'copied')
    assert.equal(result.reason, 'no skills repo URL')
  })

  test('falls back to the bundled copy when the remote cannot be reached', async () => {
    const res = resources(root)
    const dataDir = join(root, 'data-e')
    write(join(dataDir, 'factory', 'factory-team.json'), JSON.stringify({ version: '1', skillsRepoUrl: 'https://127.0.0.1:1/never.git', bots: [{ factoryId: 'x' }] }))
    const result = await installFactoryResources({ dataDir, resourcesDir: res, env: {} })
    assert.equal(result.repo, 'copied', 'the clone failed and the bundle is used')
    assert.equal(existsSync(join(dataDir, 'skills-repo', 'review-skill', 'SKILL.md')), true)
  })

  test('answers a missing bundled repo without failing', async () => {
    const bare = join(root, 'resources-bare')
    write(join(bare, 'factory', 'factory-team.json'), JSON.stringify({ version: '1', bots: [{ factoryId: 'x' }] }))
    const result = await installFactoryResources({ dataDir: join(root, 'data-f'), resourcesDir: bare })
    assert.equal(result.repo, 'kept')
    assert.equal(existsSync(join(root, 'data-f', 'skills-repo')), false)
  })
})

describe('pullSkillsRepo', () => {
  test('does nothing for a copied bundle that is not a git repo', async () => {
    const dataDir = join(root, 'data-g')
    await installFactoryResources({ dataDir, resourcesDir: resources(root) })
    // a copied bundle has no .git: the pull must return without touching it
    await pullSkillsRepo({ dataDir, resourcesDir: join(root, 'resources'), env: {} })
    assert.equal(existsSync(join(dataDir, 'skills-repo', '.git')), false)
    assert.equal(readFileSync(join(dataDir, 'skills-repo', 'review-skill', 'SKILL.md'), 'utf8'), '# review-skill\n')
  })

  test('swallows a failing fetch and leaves the skills in place', async () => {
    const dataDir = join(root, 'data-h')
    write(join(dataDir, 'skills-repo', '.git', 'HEAD'), 'ref: refs/heads/main\n')
    write(join(dataDir, 'skills-repo', 'review-skill', 'SKILL.md'), '# kept\n')
    write(join(dataDir, 'factory', 'factory-team.json'), JSON.stringify({ version: '1', skillsRepoUrl: 'https://127.0.0.1:1/never.git', bots: [{ factoryId: 'x' }] }))
    await pullSkillsRepo({ dataDir, resourcesDir: join(root, 'resources'), env: {} })
    assert.equal(readFileSync(join(dataDir, 'skills-repo', 'review-skill', 'SKILL.md'), 'utf8'), '# kept\n')
  })
})
