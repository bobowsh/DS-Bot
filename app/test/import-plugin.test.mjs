import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { PLUGIN_NAME, installImportPlugin, newerVersion } from '../src/import-plugin.mjs'

describe('version comparison', () => {
  test('a newer release wins over an older one', () => {
    assert.equal(newerVersion('0.26.4', '0.26.3'), true)
    assert.equal(newerVersion('0.26.3', '0.26.4'), false)
    assert.equal(newerVersion('1.0.0', '0.26.3'), true)
  })

  test('a pre-release is older than the release it leads to', () => {
    assert.equal(newerVersion('0.26.3', '0.26.3-rc1'), true)
    assert.equal(newerVersion('0.26.3-rc1', '0.26.3'), false)
    assert.equal(newerVersion('0.26.3-rc2', '0.26.3-rc1'), true)
    assert.equal(newerVersion('0.26.3-rc1', '0.26.3-rc1'), false)
  })
})

describe('the import plugin in the profile', () => {
  let root
  let profileDir
  let sourceDir
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'ds-bot-import-plugin-'))
    profileDir = join(root, 'profile')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-ds-bot', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'ds-bot'] } } }, undefined, 2)}\n`)
    sourceDir = join(root, 'source')
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'package.json'), `${JSON.stringify({ name: PLUGIN_NAME, version: '0.26.3' }, undefined, 2)}\n`)
    writeFileSync(join(sourceDir, 'cordis.patch.yml'), '- insert:\n    - id: import-claude\n      name: dsh-chat-import\n', 'utf8')
  })
  after(() => { rmSync(root, { recursive: true, force: true }) })

  const manifest = () => JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))

  test('the plugin is copied into the profile and added to its bundle list', async () => {
    const result = await installImportPlugin({ profileDir, sourceDir })
    assert.equal(result.installed, true)
    assert.equal(result.listed, true)
    assert.ok(manifest().dsh.profile.bundles.includes(PLUGIN_NAME), 'the bundle list names it')
    assert.equal(manifest().dependencies[PLUGIN_NAME], '0.26.3', 'the profile depends on it')
  })

  test('the plugin files are in the profile', async () => {
    assert.ok(readFileSync(join(profileDir, 'node_modules', PLUGIN_NAME, 'cordis.patch.yml'), 'utf8').includes('import-claude'))
    assert.equal(JSON.parse(readFileSync(join(profileDir, 'node_modules', PLUGIN_NAME, 'package.json'), 'utf8')).name, PLUGIN_NAME)
  })

  test('a second start does not copy it again', async () => {
    const marker = join(profileDir, 'node_modules', PLUGIN_NAME, 'marker.txt')
    writeFileSync(marker, 'kept', 'utf8')
    await installImportPlugin({ profileDir, sourceDir })
    assert.equal(readFileSync(marker, 'utf8'), 'kept', 'the copy is left alone')
  })

  test('a bundle the user turned off is not put back', async () => {
    // The plugin manager removes the bundle from the list when the user turns it off, and keeps
    // the package in the profile's dependencies.
    const current = manifest()
    current.dsh.profile.bundles = current.dsh.profile.bundles.filter(name => name !== PLUGIN_NAME)
    writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(current, undefined, 2)}\n`)
    const result = await installImportPlugin({ profileDir, sourceDir })
    assert.equal(result.listed, false)
    assert.ok(!manifest().dsh.profile.bundles.includes(PLUGIN_NAME), 'it stays off')
  })

  test('an installation without the plugin does not fail the start', async () => {
    const result = await installImportPlugin({ profileDir, sourceDir: join(root, 'missing') })
    assert.equal(result.installed, false)
  })

  test('a newer plugin in the installer replaces the older copy in the profile', async () => {
    const newerSource = join(root, 'source-newer')
    mkdirSync(newerSource, { recursive: true })
    writeFileSync(join(newerSource, 'package.json'), `${JSON.stringify({ name: PLUGIN_NAME, version: '0.27.0' }, undefined, 2)}\n`)
    writeFileSync(join(newerSource, 'cordis.patch.yml'), '- insert:\n    - id: import-claude\n      name: dsh-chat-import\n', 'utf8')
    const result = await installImportPlugin({ profileDir, sourceDir: newerSource })
    assert.equal(result.updated, true)
    const copied = JSON.parse(readFileSync(join(profileDir, 'node_modules', PLUGIN_NAME, 'package.json'), 'utf8'))
    assert.equal(copied.version, '0.27.0', 'the copy is the newer one')
    assert.equal(manifest().dependencies[PLUGIN_NAME], '0.27.0', 'the profile depends on the newer one')
  })

  test('the same version is not copied again', async () => {
    const sameSource = join(root, 'source-same')
    mkdirSync(sameSource, { recursive: true })
    writeFileSync(join(sameSource, 'package.json'), `${JSON.stringify({ name: PLUGIN_NAME, version: '0.27.0' }, undefined, 2)}\n`)
    const marker = join(profileDir, 'node_modules', PLUGIN_NAME, 'marker.txt')
    writeFileSync(marker, 'kept', 'utf8')
    const result = await installImportPlugin({ profileDir, sourceDir: sameSource })
    assert.equal(result.updated, false)
    assert.equal(readFileSync(marker, 'utf8'), 'kept', 'the copy is left alone')
  })
})
