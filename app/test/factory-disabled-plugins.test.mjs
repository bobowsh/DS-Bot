// A factory plugin can ship turned off: it travels with the installer, but the first start
// keeps it out of the profile's bundle list, so the Host does not load it until the user turns
// it on in the plugin manager.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { installImportPlugin } from '../src/import-plugin.mjs'
import { factoryDisabledPlugins } from '../src/bundled-plugins.mjs'

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

describe('a factory plugin that ships turned off', () => {
  let root
  let profileDir
  let folder

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'ds-bot-disabled-'))
    profileDir = join(root, 'profile')
    folder = join(root, 'plugin')
    write(join(folder, 'package.json'), `${JSON.stringify({ name: 'ds-harness-remote', version: '0.6.3' }, undefined, 2)}\n`)
    write(join(folder, 'lib', 'index.js'), 'export const marker = 1\n')
  })
  after(() => { rmSync(root, { recursive: true, force: true }) })

  test('it is put in place and recorded, but the Host is not told to load it', async () => {
    const result = await installImportPlugin({ profileDir, folder, name: 'ds-harness-remote', version: '0.6.3', disabledByDefault: true })
    assert.equal(result.installed, true)
    assert.equal(result.listed, false, 'it is not put into the bundle list')
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    assert.equal(manifest.dependencies['ds-harness-remote'], '0.6.3', 'the profile knows the plugin')
    assert.deepEqual(manifest.dsh?.profile?.bundles ?? [], [], 'but the Host does not load it')
    assert.ok(existsSync(join(profileDir, 'node_modules', 'ds-harness-remote', 'lib', 'index.js')), 'the files are there')
  })

  test('a plugin that ships on is put into the bundle list', async () => {
    const fresh = join(root, 'profile-on')
    const result = await installImportPlugin({ profileDir: fresh, folder, name: 'ds-harness-remote', version: '0.6.3' })
    assert.equal(result.listed, true)
    const manifest = JSON.parse(readFileSync(join(fresh, 'package.json'), 'utf8'))
    assert.deepEqual(manifest.dsh.profile.bundles, ['ds-harness-remote'])
  })

  test('a plugin the user turned on stays on, even when the factory ships it off', async () => {
    const fresh = join(root, 'profile-kept')
    await installImportPlugin({ profileDir: fresh, folder, name: 'ds-harness-remote', version: '0.6.3', disabledByDefault: true })
    // The user turns it on in the plugin manager: the bundle list gains it.
    const manifest = JSON.parse(readFileSync(join(fresh, 'package.json'), 'utf8'))
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: ['ds-harness-remote'] } }
    writeFileSync(join(fresh, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8')
    const result = await installImportPlugin({ profileDir: fresh, folder, name: 'ds-harness-remote', version: '0.6.3', disabledByDefault: true })
    assert.equal(result.listed, false)
    assert.deepEqual(JSON.parse(readFileSync(join(fresh, 'package.json'), 'utf8')).dsh.profile.bundles, ['ds-harness-remote'], 'the user\'s choice holds')
  })
})

describe('the list of the plugins that ship turned off', () => {
  let root
  let dataDir

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'ds-bot-disabled-list-'))
    dataDir = join(root, 'data')
    write(join(dataDir, 'factory', 'plugins.json'), `${JSON.stringify({
      plugins: [
        { name: 'ds-harness-remote', version: '0.6.3', path: 'profiles/ds-bot/node_modules/ds-harness-remote', disabled: true },
        { name: 'dsh-aide', version: '0.12.0', path: 'profiles/ds-bot/node_modules/dsh-aide' },
      ],
    }, undefined, 2)}\n`)
  })
  after(() => { rmSync(root, { recursive: true, force: true }) })

  test('the build\'s decision is read from the factory list', () => {
    assert.deepEqual(factoryDisabledPlugins(dataDir), ['ds-harness-remote'])
  })

  test('a data tree without the list has none', () => {
    assert.deepEqual(factoryDisabledPlugins(join(root, 'empty')), [])
  })
})
