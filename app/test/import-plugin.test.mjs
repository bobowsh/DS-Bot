import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { PLUGIN_NAME, installImportPlugin, newerVersion, readTgz, unpackTgz } from '../src/import-plugin.mjs'
import { packPlugin } from '../scripts/bundled-plugin.mjs'

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

describe('the archive of a plugin', () => {
  let root
  let sourceDir
  let archive
  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'ds-bot-plugin-archive-'))
    sourceDir = join(root, 'source')
    mkdirSync(join(sourceDir, 'lib'), { recursive: true })
    writeFileSync(join(sourceDir, 'package.json'), `${JSON.stringify({ name: PLUGIN_NAME, version: '0.26.3' }, undefined, 2)}\n`)
    writeFileSync(join(sourceDir, 'cordis.patch.yml'), '- insert:\n    - id: import-claude\n      name: dsh-chat-import\n', 'utf8')
    writeFileSync(join(sourceDir, 'lib', 'index.mjs'), "export const marker = 'ok'\n", 'utf8')
    archive = join(root, 'plugin.tgz')
    await packPlugin(sourceDir, archive, 'package')
  })
  after(() => { rmSync(root, { recursive: true, force: true }) })

  test('the archive holds the package files', () => {
    const entries = readTgz(readFileSync(archive))
    const paths = entries.map(entry => entry.path)
    assert.ok(paths.includes('package/package.json'), 'the manifest is in it')
    assert.ok(paths.includes('package/cordis.patch.yml'), 'the patch is in it')
    assert.ok(paths.includes('package/lib/index.mjs'), 'the module is in it')
  })

  test('unpacking it puts the files back where they were', async () => {
    const into = join(root, 'unpacked')
    await unpackTgz(readFileSync(archive), into)
    assert.equal(JSON.parse(readFileSync(join(into, 'package.json'), 'utf8')).version, '0.26.3')
    assert.ok(readFileSync(join(into, 'cordis.patch.yml'), 'utf8').includes('import-claude'))
    assert.ok(readFileSync(join(into, 'lib', 'index.mjs'), 'utf8').includes('ok'))
  })
})

describe('the import plugin in the profile', () => {
  let root
  let profileDir
  let sourceDir
  let archive
  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'ds-bot-import-plugin-'))
    profileDir = join(root, 'profile')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-ds-bot', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'ds-bot'] } } }, undefined, 2)}\n`)
    sourceDir = join(root, 'source')
    mkdirSync(join(sourceDir, 'lib'), { recursive: true })
    writeFileSync(join(sourceDir, 'package.json'), `${JSON.stringify({ name: PLUGIN_NAME, version: '0.26.3' }, undefined, 2)}\n`)
    writeFileSync(join(sourceDir, 'cordis.patch.yml'), '- insert:\n    - id: import-claude\n      name: dsh-chat-import\n', 'utf8')
    writeFileSync(join(sourceDir, 'lib', 'index.mjs'), "export const marker = 'ok'\n", 'utf8')
    archive = join(root, 'plugin.tgz')
    await packPlugin(sourceDir, archive, 'package')
  })
  after(() => { rmSync(root, { recursive: true, force: true }) })

  const manifest = () => JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))

  test('the plugin is unpacked into the profile and added to its bundle list', async () => {
    const result = await installImportPlugin({ profileDir, archive, version: '0.26.3' })
    assert.equal(result.installed, true)
    assert.equal(result.listed, true)
    assert.ok(manifest().dsh.profile.bundles.includes(PLUGIN_NAME), 'the bundle list names it')
    assert.equal(manifest().dependencies[PLUGIN_NAME], '0.26.3', 'the profile depends on it')
  })

  test('the plugin files are in the profile', async () => {
    assert.ok(readFileSync(join(profileDir, 'node_modules', PLUGIN_NAME, 'cordis.patch.yml'), 'utf8').includes('import-claude'))
    assert.equal(JSON.parse(readFileSync(join(profileDir, 'node_modules', PLUGIN_NAME, 'package.json'), 'utf8')).name, PLUGIN_NAME)
    assert.ok(existsSync(join(profileDir, 'node_modules', PLUGIN_NAME, 'lib', 'index.mjs')), 'the module is there')
  })

  test("the plugin's dependencies go beside it in the profile", async () => {
    // The plugin runs from the profile, where Node looks for its imports in the profile's own
    // node_modules; a dependency that stayed in the app's node_modules would not be found.
    const withDep = join(root, 'source-with-dep')
    mkdirSync(join(withDep, 'lib'), { recursive: true })
    writeFileSync(join(withDep, 'package.json'), `${JSON.stringify({ name: PLUGIN_NAME, version: '0.28.0', dependencies: { 'a-helper': '^1.0.0' } }, undefined, 2)}\n`)
    writeFileSync(join(withDep, 'cordis.patch.yml'), '- insert:\n    - id: import-claude\n      name: dsh-chat-import\n', 'utf8')
    writeFileSync(join(withDep, 'lib', 'index.mjs'), "import 'a-helper'\n", 'utf8')
    // 依赖在 app 的 node_modules 里
    const helper = join(root, 'app-node_modules', 'a-helper')
    mkdirSync(helper, { recursive: true })
    writeFileSync(join(helper, 'package.json'), `${JSON.stringify({ name: 'a-helper', version: '1.2.0' }, undefined, 2)}\n`)
    writeFileSync(join(helper, 'index.js'), 'export default 1\n', 'utf8')
    // 打包时把依赖一起带上
    const { prepareBundledPlugins } = await import('../scripts/bundled-plugin.mjs')
    const appDir = join(root, 'fake-app')
    mkdirSync(join(appDir, 'node_modules'), { recursive: true })
    await cp(join(root, 'source-with-dep'), join(appDir, 'node_modules', PLUGIN_NAME), { recursive: true })
    mkdirSync(join(appDir, 'node_modules', 'a-helper'), { recursive: true })
    writeFileSync(join(appDir, 'node_modules', 'a-helper', 'package.json'), `${JSON.stringify({ name: 'a-helper', version: '1.2.0' }, undefined, 2)}\n`)
    writeFileSync(join(appDir, 'node_modules', 'a-helper', 'index.js'), 'export default 1\n', 'utf8')
    const made = await prepareBundledPlugins(appDir, [PLUGIN_NAME])
    assert.equal(made.length, 1)
    // 解包后依赖在 profile 的 node_modules 根，插件自己也在那
    const profile = join(root, 'profile-with-dep')
    await installImportPlugin({ profileDir: profile, archive: made[0], version: '0.28.0' })
    assert.ok(existsSync(join(profile, 'node_modules', PLUGIN_NAME, 'package.json')), 'the plugin is there')
    assert.ok(existsSync(join(profile, 'node_modules', 'a-helper', 'package.json')), 'its dependency is beside it')
  })

  test('a second start does not unpack it again', async () => {
    const marker = join(profileDir, 'node_modules', PLUGIN_NAME, 'marker.txt')
    writeFileSync(marker, 'kept', 'utf8')
    await installImportPlugin({ profileDir, archive })
    assert.equal(readFileSync(marker, 'utf8'), 'kept', 'the unpacked files are left alone')
  })

  test('a bundle the user turned off is not put back', async () => {
    // The plugin manager removes the bundle from the list when the user turns it off, and keeps
    // the package in the profile's dependencies.
    const current = manifest()
    current.dsh.profile.bundles = current.dsh.profile.bundles.filter(name => name !== PLUGIN_NAME)
    writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(current, undefined, 2)}\n`)
    const result = await installImportPlugin({ profileDir, archive, version: '0.26.3' })
    assert.equal(result.listed, false)
    assert.ok(!manifest().dsh.profile.bundles.includes(PLUGIN_NAME), 'it stays off')
  })

  test('a plugin the user removed is installed again', async () => {
    // Removing is not turning off: the plugin manager takes the dependency with it, so the app
    // finds no trace of it and puts it back. Turning it off is the way to keep it from running.
    const current = manifest()
    delete current.dependencies[PLUGIN_NAME]
    current.dsh.profile.bundles = current.dsh.profile.bundles.filter(name => name !== PLUGIN_NAME)
    writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(current, undefined, 2)}\n`)
    rmSync(join(profileDir, 'node_modules', PLUGIN_NAME), { recursive: true, force: true })
    const result = await installImportPlugin({ profileDir, archive, version: '0.26.3' })
    assert.equal(result.installed, true)
    assert.equal(result.listed, true)
    assert.ok(manifest().dsh.profile.bundles.includes(PLUGIN_NAME), 'it is back in the list')
    assert.equal(manifest().dependencies[PLUGIN_NAME], '0.26.3', 'the profile depends on it again')
  })

  test('an installation without the plugin does not fail the start', async () => {
    const result = await installImportPlugin({ profileDir, archive: join(root, 'missing.tgz') })
    assert.equal(result.installed, false)
  })

  test('the plugin goes into a profile that has no manifest yet', async () => {
    // The app puts the plugin in place before the Host boots, and the Host writes the profile's
    // own files when it starts.
    const fresh = join(root, 'fresh-profile')
    const result = await installImportPlugin({ profileDir: fresh, archive })
    assert.equal(result.installed, true)
    assert.equal(result.listed, true)
    const written = JSON.parse(readFileSync(join(fresh, 'package.json'), 'utf8'))
    assert.ok(written.dsh.profile.bundles.includes(PLUGIN_NAME), 'the bundle list names it')
    assert.equal(written.dependencies[PLUGIN_NAME], '0.26.3', 'the profile depends on it')
    assert.ok(existsSync(join(fresh, 'node_modules', PLUGIN_NAME, 'cordis.patch.yml')), 'the files are there')
  })

  test('a newer plugin in the installer replaces the older copy in the profile', async () => {
    const newerSource = join(root, 'source-newer')
    mkdirSync(join(newerSource, 'lib'), { recursive: true })
    writeFileSync(join(newerSource, 'package.json'), `${JSON.stringify({ name: PLUGIN_NAME, version: '0.27.0' }, undefined, 2)}\n`)
    writeFileSync(join(newerSource, 'cordis.patch.yml'), '- insert:\n    - id: import-claude\n      name: dsh-chat-import\n', 'utf8')
    const newerArchive = join(root, 'newer.tgz')
    await packPlugin(newerSource, newerArchive, 'package')
    const result = await installImportPlugin({ profileDir, archive: newerArchive })
    assert.equal(result.updated, true)
    const copied = JSON.parse(readFileSync(join(profileDir, 'node_modules', PLUGIN_NAME, 'package.json'), 'utf8'))
    assert.equal(copied.version, '0.27.0', 'the copy is the newer one')
    assert.equal(manifest().dependencies[PLUGIN_NAME], '0.27.0', 'the profile depends on the newer one')
  })

  test('the same version is not unpacked again', async () => {
    const sameSource = join(root, 'source-same')
    mkdirSync(join(sameSource, 'lib'), { recursive: true })
    writeFileSync(join(sameSource, 'package.json'), `${JSON.stringify({ name: PLUGIN_NAME, version: '0.27.0' }, undefined, 2)}\n`)
    const sameArchive = join(root, 'same.tgz')
    await packPlugin(sameSource, sameArchive, 'package')
    const marker = join(profileDir, 'node_modules', PLUGIN_NAME, 'marker.txt')
    writeFileSync(marker, 'kept', 'utf8')
    const result = await installImportPlugin({ profileDir, archive: sameArchive })
    assert.equal(result.updated, false)
    assert.equal(readFileSync(marker, 'utf8'), 'kept', 'the unpacked files are left alone')
  })
})
