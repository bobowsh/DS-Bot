import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { Arch } from 'electron-builder'
import { archProblem, beforePack, officeRuntimeRequest } from '../scripts/before-pack.mjs'
import { runtimeTarget } from '../scripts/prepare-runtime.mjs'

test('a build for the architecture of this Node goes on', async () => {
  assert.equal(archProblem({ target: 'arm64', platform: 'darwin', host: 'arm64' }), undefined)
  assert.equal(archProblem({ target: 'x64', platform: 'win32', host: 'x64' }), undefined)
  const asked = []
  const skills = []
  const plugins = []
  const servers = []
  // A real app directory carrying the real manifest: the hook reads it from the app dir.
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-before-pack-'))
  const appDir = join(root, 'app')
  mkdirSync(appDir, { recursive: true })
  copyFileSync(new URL('../factory.manifest.json', import.meta.url), join(appDir, 'factory.manifest.json'))
  const manifest = JSON.parse(readFileSync(join(appDir, 'factory.manifest.json'), 'utf8'))
  const packager = { appDir, appInfo: { version: '0.0.0' } }
  await beforePack(
    { arch: Arch[process.arch], electronPlatformName: process.platform, packager },
    async (request) => { asked.push(request) },
    async (dir, skillsEntries) => { skills.push({ dir, skillsEntries }) },
    async (dir, pluginEntries) => { plugins.push({ dir, pluginEntries }) },
    async (dir, serverEntries) => { servers.push({ dir, serverEntries }) },
  )
  assert.equal(asked.length, 1)
  assert.equal(asked[0].target, runtimeTarget(process.platform, process.arch))
  assert.equal(asked[0].output, join(appDir, 'build', 'runtime'))
  // The manifest drives the rest of the hook: the skills, the plugins and the language
  // servers it names are what the three prepare steps are called with.
  assert.equal(skills.length, 1)
  assert.equal(plugins.length, 1)
  assert.deepEqual(plugins[0].pluginEntries, manifest.plugins)
  assert.deepEqual(skills[0].skillsEntries, manifest.skills)
  assert.deepEqual(servers[0].serverEntries, manifest.languageServers)
  rmSync(root, { recursive: true, force: true })
})

test('a build for another architecture stops and says where to build it', async () => {
  assert.equal(archProblem({ target: 'x64', platform: 'darwin', host: 'arm64' }),
    'This Node runs on arm64, so npm installed arm64 native modules, and an x64 app with them would not start. Install the dependencies and build on an Intel Mac, or under Rosetta with an x64 Node.')
  assert.match(archProblem({ target: 'arm64', platform: 'darwin', host: 'x64' }), /build on a Mac with Apple silicon\.$/)
  assert.match(archProblem({ target: 'x64', platform: 'win32', host: 'arm64' }), /build with an x64 Node\.$/)
  assert.match(archProblem({ target: 'universal', platform: 'darwin', host: 'arm64' }), /Build one app per architecture\./)
  const other = process.arch === 'x64' ? 'arm64' : 'x64'
  await assert.rejects(beforePack({ arch: Arch[other], electronPlatformName: process.platform }), new RegExp(`an ${other} app with them would not start`))
})

test('a requested universal build stops before packing either architecture', async () => {
  // electron-builder's MacPackager.doUniversalPack packs x64 then arm64: the hook sees a concrete
  // arch each time, and the universal request only shows in packager.packagerOptions.targets.
  const packager = { packagerOptions: { targets: new Map([[{ nodeName: 'darwin' }, new Map([[Arch.universal, ['dmg']]])]]) } }
  await assert.rejects(beforePack({ arch: Arch.x64, electronPlatformName: 'darwin', packager }), /Build one app per architecture\./)
  await assert.rejects(beforePack({ arch: Arch.arm64, electronPlatformName: 'darwin', packager }), /Build one app per architecture\./)
})

test('electron-builder runs the check before it packs', () => {
  assert.match(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'), /^beforePack: \.\/scripts\/before-pack\.mjs$/m)
})

test('the Office payload goes next to the asar for a platform the lock pins', () => {
  const request = officeRuntimeRequest({ arch: Arch.x64, electronPlatformName: 'win32', packager: { projectDir: 'app-dir', appInfo: { version: '9.9.9' } } })
  assert.equal(request.target, 'win-x64')
  assert.equal(request.version, '9.9.9')
  assert.equal(request.output, join('app-dir', 'build', 'runtime'))
  assert.throws(() => officeRuntimeRequest({ arch: Arch.arm64, electronPlatformName: 'win32', packager: { projectDir: 'app-dir' } }), /No Office runtime payload for win32 arm64/)
  assert.match(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'), /from: build\/runtime\/primary-runtime\r?\n\s+to: primary-runtime/u)
})
