// The D1 deployment tool: frontmatter parsing/completion, skill discovery, staging into a
// disposable directory, token scrubbing, and the publish-missing-only report. No network, no
// real CLI, no token: everything here is a pure function or a local temp directory.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import {
  completeFrontmatter,
  publishedSlugs,
  readFrontmatter,
  skillDirectories,
  skillhub,
  stageSkills,
  SKILLHUB_REGISTRY,
} from '../scripts/import-skills.mjs'

describe('SKILL.md frontmatter', () => {
  test('a compliant frontmatter is read and left unchanged', () => {
    const text = '---\nname: grilling\ndescription: Grill a plan.\n---\n\n# grilling\nbody\n'
    assert.deepEqual(readFrontmatter(text), { name: 'grilling', description: 'Grill a plan.' })
    assert.equal(completeFrontmatter('grilling', text), text)
  })

  test('a folded description keeps its continuation lines', () => {
    const text = '---\nname: ub-mode\ndescription: >\n  First line\n  second line\n---\n'
    assert.equal(readFrontmatter(text).description, '> First line second line')
  })

  test('a plain Markdown SKILL.md gets name + description, source text intact', () => {
    const text = '# 插件运维\n\n使用 profile 命令管理安装。\n'
    const done = completeFrontmatter('dsh-profile-plugin-ops', text)
    const fields = readFrontmatter(done)
    assert.equal(fields.name, 'dsh-profile-plugin-ops')
    assert.match(fields.description, /profile/)
    assert.ok(done.endsWith(text), 'the original body is kept verbatim')
  })

  test('a missing frontmatter but no usable body still gets a description', () => {
    const done = completeFrontmatter('review-skill', '---\nname: review-skill\n---\n')
    assert.match(readFrontmatter(done).description, /review-skill/)
  })

  test('no frontmatter at all returns null', () => {
    assert.equal(readFrontmatter('# just a title\n'), null)
  })
})

describe('skills-repo staging', () => {
  let root
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'ds-bot-import-skills-'))
  })
  after(() => { rmSync(root, { recursive: true, force: true }) })

  test('discovers only real skill directories, never .git', () => {
    mkdirSync(join(root, 'alpha'), { recursive: true })
    writeFileSync(join(root, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: A skill.\n---\n', 'utf8')
    mkdirSync(join(root, 'beta', 'scripts'), { recursive: true })
    writeFileSync(join(root, 'beta', 'SKILL.md'), '# beta\n\nbody text\n', 'utf8')
    writeFileSync(join(root, 'beta', 'scripts', 'tool.mjs'), 'export const ok = true\n', 'utf8')
    mkdirSync(join(root, '.git', 'objects'), { recursive: true })
    writeFileSync(join(root, 'README.md'), 'not a skill', 'utf8')
    assert.deepEqual(skillDirectories(root).sort(), ['alpha', 'beta'])
  })

  test('stages into a disposable folder, completes frontmatter, never edits the source', () => {
    const stage = mkdtempSync(join(tmpdir(), 'ds-bot-import-stage-'))
    try {
      const { staged } = stageSkills(root, stage)
      assert.deepEqual(staged.map(s => s.name).sort(), ['alpha', 'beta'])
      const betaSource = readFileSync(join(root, 'beta', 'SKILL.md'), 'utf8')
      assert.equal(betaSource.startsWith('---'), false, 'the source is still plain Markdown')
      const betaStaged = readFileSync(join(stage, 'beta', 'SKILL.md'), 'utf8')
      assert.equal(readFrontmatter(betaStaged).name, 'beta')
      assert.ok(readFileSync(join(stage, 'beta', 'scripts', 'tool.mjs'), 'utf8').includes('ok = true'))
    } finally { rmSync(stage, { recursive: true, force: true }) }
  })

  test('refuses a staging folder inside the source, so it can never copy itself', () => {
    assert.throws(() => stageSkills(root, join(root, 'stage')), /must not be inside/)
  })
})

describe('CLI output scrubbing', () => {
  test('a token in the output is replaced, never printed', () => {
    // node -e stands in for the CLI: no SkillHub binary or network is needed.
    const args = ['-e', 'console.log("token=sk_abcdefghijklmnop1234 ok=true")']
    const result = skillhub(args, { token: 'sk_abcdefghijklmnop1234', cli: process.execPath })
    assert.ok(!result.output.includes('sk_abcdefghijklmnop1234'), 'the token is scrubbed')
    assert.ok(result.output.includes('<redacted>'))
    assert.equal(result.ok, false, 'ok:true requires the real JSON shape')
  })
})

describe('the deployment report', () => {
  test('the default registry is the intranet SkillHub', () => {
    assert.equal(SKILLHUB_REGISTRY, 'http://192.168.1.10:8081')
  })

  test('publishedSlugs reads the anonymous list response', async () => {
    const fetchImpl = async () => ({
      json: async () => ({ items: [{ slug: 'grilling' }, { slug: 'ub-mode' }] }),
    })
    assert.deepEqual(await publishedSlugs('http://registry/', fetchImpl), ['grilling', 'ub-mode'])
  })

  test('an empty items list is not mistaken for a failed publish', async () => {
    const fetchImpl = async () => ({ json: async () => ({ items: [] }) })
    assert.deepEqual(await publishedSlugs('http://registry/', fetchImpl), [])
  })
})
