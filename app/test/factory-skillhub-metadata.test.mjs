// The factory skills that the SkillHub knows about: the plugin judges "installed" by the
// metadata it keeps beside a skill, so a skill that ships with the app needs that file. The
// version comes from the registry, so a skill that was never published gets none.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { publishedSkills, skillhubMetadata, writeSkillhubMetadata } from '../scripts/factory-skillhub-metadata.mjs'

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

describe('the skills the registry holds', () => {
  test('the list is read from the registry', async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ data: { items: [
      { slug: 'ub-mode', version: '20261108.022844' },
      { slug: 'grilling', version: '20261108.022746' },
      { slug: 'no-version' },
    ] } }) })
    const published = await publishedSkills('http://registry', fetchImpl)
    assert.equal(published.get('ub-mode'), '20261108.022844')
    assert.equal(published.get('grilling'), '20261108.022746')
    assert.equal(published.has('no-version'), false, 'a skill without a version is not published')
  })

  test('a registry that cannot be reached publishes nothing', async () => {
    const published = await publishedSkills('http://registry', async () => { throw new Error('no route') })
    assert.equal(published.size, 0)
  })
})

describe('the installation record of a factory skill', () => {
  let root
  let skillsDir

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'ds-bot-skillhub-meta-'))
    skillsDir = join(root, 'skills')
    write(join(skillsDir, 'ub-mode', 'SKILL.md'), '---\nname: ub-mode\n---\n')
    write(join(skillsDir, 'cua-driver', 'SKILL.md'), '---\nname: cua-driver\n---\n')
  })
  after(() => { rmSync(root, { recursive: true, force: true }) })

  test('the record names the registry, the namespace, the slug and the version', () => {
    const metadata = JSON.parse(skillhubMetadata({ slug: 'ub-mode', version: '1.2.3', registry: 'http://registry', namespace: 'global' }))
    assert.equal(metadata.registry, 'http://registry')
    assert.equal(metadata.namespace, 'global')
    assert.equal(metadata.slug, 'ub-mode')
    assert.equal(metadata.version, '1.2.3')
    assert.equal(metadata.source, 'skillhub')
  })

  test('a published skill gets its record, an unpublished one does not', async () => {
    const marked = await writeSkillhubMetadata(skillsDir, new Map([['ub-mode', '20261108.022844']]), { registry: 'http://registry', namespace: 'global' })
    assert.deepEqual(marked, ['ub-mode'])
    assert.ok(existsSync(join(skillsDir, 'ub-mode', '.skillhub', 'metadata.json')), 'the record is there')
    assert.equal(existsSync(join(skillsDir, 'cua-driver', '.skillhub')), false, 'the unpublished skill has none')
  })

  test('a skill that is not in the folder gets no record', async () => {
    const marked = await writeSkillhubMetadata(skillsDir, new Map([['not-there', '1.0.0']]), { registry: 'http://registry' })
    assert.deepEqual(marked, [])
  })
})
