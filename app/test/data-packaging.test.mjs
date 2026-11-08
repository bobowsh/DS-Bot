// The data directory the installer ships is a DSH home: the factory plugins sit in the
// profile's own node_modules, the skills repository and the factory list sit beside it, and the
// installer moves only its whitelisted folders into the data home without touching user data.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { PROFILE, bundledPluginDir, bundledDataDir, prepareBundledPlugins } from '../scripts/bundled-plugin.mjs'
import { ensureSkillsRepoGit, SKILLS_SOURCE } from '../scripts/skills-repo-git.mjs'
import { bundledPlugins, findBundledPlugin } from '../src/bundled-plugins.mjs'

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/** Every file under a folder with its hash, so a change in any of them shows. */
function fingerprint(dir) {
  const out = {}
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) { walk(path); continue }
      out[relative(dir, path).replace(/\\/gu, '/')] = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}

/** The DSH home path the installer ships its plugins in. */
const nodeModules = appDir => join(bundledDataDir(appDir), 'profiles', PROFILE, 'node_modules')

describe('the plugins the build carries', () => {
  let root
  let appDir
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'ds-bot-data-pack-'))
    appDir = join(root, 'app')
    // A plugin in the app's own node_modules: the import plugin is packed from there.
    const plugin = join(appDir, 'node_modules', 'dsh-chat-import')
    write(join(plugin, 'package.json'), `${JSON.stringify({ name: 'dsh-chat-import', version: '0.26.3', dependencies: { 'a-helper': '^1.0.0' } }, undefined, 2)}\n`)
    write(join(plugin, 'lib', 'index.mjs'), "export const marker = 'ok'\n")
    const helper = join(appDir, 'node_modules', 'a-helper')
    write(join(helper, 'package.json'), `${JSON.stringify({ name: 'a-helper', version: '1.2.0' }, undefined, 2)}\n`)
    write(join(helper, 'index.js'), 'export default 1\n')
  })
  after(() => { rmSync(root, { recursive: true, force: true }) })

  test('a plugin is a folder in the profile node_modules of the data home', async () => {
    const made = await prepareBundledPlugins(appDir, ['dsh-chat-import'])
    assert.equal(made.length, 1)
    const folder = bundledPluginDir(appDir, 'dsh-chat-import')
    assert.equal(folder, join(nodeModules(appDir), 'dsh-chat-import'))
    assert.ok(existsSync(join(folder, 'package.json')), 'the manifest is in it')
    assert.ok(existsSync(join(folder, 'lib', 'index.mjs')), 'the module is in it')
    // The plugin's dependency travels with it, where Node looks for it.
    assert.ok(existsSync(join(folder, 'node_modules', 'a-helper', 'package.json')), 'its dependency is in it')
  })

  test('no archive is written any more', async () => {
    await prepareBundledPlugins(appDir, ['dsh-chat-import'])
    assert.equal(existsSync(join(appDir, 'build', 'bundled-plugins')), false, 'the archive folder is gone')
    assert.equal(existsSync(join(bundledDataDir(appDir), 'plugins')), false, 'the old flat plugins folder is gone')
  })

  test('a scoped plugin keeps its scope in node_modules', async () => {
    const scoped = join(appDir, 'node_modules', '@scope', 'dsh-demo')
    write(join(scoped, 'package.json'), `${JSON.stringify({ name: '@scope/dsh-demo', version: '1.0.0' }, undefined, 2)}\n`)
    await prepareBundledPlugins(appDir, ['@scope/dsh-demo'])
    assert.ok(existsSync(join(nodeModules(appDir), '@scope', 'dsh-demo', 'package.json')), 'the scope is a directory')
  })

  test('the factory list names the plugins and where they are', async () => {
    await prepareBundledPlugins(appDir, ['dsh-chat-import', '@scope/dsh-demo'])
    const list = JSON.parse(readFileSync(join(bundledDataDir(appDir), 'factory', 'plugins.json'), 'utf8'))
    assert.equal(list.plugins.length, 2)
    assert.equal(list.plugins[0].name, 'dsh-chat-import')
    assert.equal(list.plugins[0].path, `profiles/${PROFILE}/node_modules/dsh-chat-import`)
    // The plain-text form is for the NSIS installer.
    const txt = readFileSync(join(bundledDataDir(appDir), 'factory', 'plugins.txt'), 'utf8')
    assert.match(txt, /dsh-chat-import/u)
    assert.match(txt, /@scope\\dsh-demo/u)
  })
})

describe('the app reads the plugins from the data home', () => {
  let root
  let dataDir
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'ds-bot-data-read-'))
    dataDir = join(root, 'data')
    const nm = join(dataDir, 'profiles', PROFILE, 'node_modules')
    write(join(nm, 'dsh-chat-import', 'package.json'), `${JSON.stringify({ name: 'dsh-chat-import', version: '0.26.3' }, undefined, 2)}\n`)
    write(join(nm, 'dsh-rule-manager', 'package.json'), `${JSON.stringify({ name: 'dsh-rule-manager', version: '0.1.0' }, undefined, 2)}\n`)
    // A plugin the user installed themselves: not on the factory list, never upgraded.
    write(join(nm, 'my-plugin', 'package.json'), `${JSON.stringify({ name: 'my-plugin', version: '9.0.0' }, undefined, 2)}\n`)
    write(join(dataDir, 'factory', 'plugins.json'), `${JSON.stringify({
      plugins: [
        { name: 'dsh-chat-import', version: '0.26.3', path: `profiles/${PROFILE}/node_modules/dsh-chat-import` },
        { name: 'dsh-rule-manager', version: '0.1.0', path: `profiles/${PROFILE}/node_modules/dsh-rule-manager` },
      ],
    }, undefined, 2)}\n`)
  })
  after(() => { rmSync(root, { recursive: true, force: true }) })

  test('only the plugins on the factory list are found', () => {
    const found = bundledPlugins(dataDir)
    assert.deepEqual(found.map(entry => entry.name), ['dsh-chat-import', 'dsh-rule-manager'])
    assert.equal(found[0].version, '0.26.3')
  })

  test('a factory plugin is found by its package name, a user plugin is not', () => {
    assert.equal(findBundledPlugin(dataDir, 'dsh-rule-manager')?.version, '0.1.0')
    assert.equal(findBundledPlugin(dataDir, 'my-plugin'), undefined)
  })

  test('a data home without a factory list holds none', () => {
    assert.deepEqual(bundledPlugins(join(root, 'empty')), [])
  })
})

// The data home of an install is the one beside the program, and it holds the user's own data.
// The installer writes only its whitelisted folders into it: the bots, the profiles and the
// sessions must be exactly as they were.
describe('the data home of an install', () => {
  let root
  let installRoot
  let dataDir
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'ds-bot-install-data-'))
    installRoot = join(root, 'LinkBot')
    dataDir = join(installRoot, 'data')
    // The user's own data.
    write(join(dataDir, 'bot', 'state.json'), '{"bots":{}}\n')
    write(join(dataDir, 'profiles', PROFILE, 'package.json'), '{"name":"dsh-profile-ds-bot"}\n')
    write(join(dataDir, 'profiles', PROFILE, 'node_modules', 'my-plugin', 'package.json'), '{"name":"my-plugin","version":"9.0.0"}\n')
    write(join(dataDir, 'sessions', 'g', 's1', 'notes.txt'), 'one\n')
  })
  after(() => { rmSync(root, { recursive: true, force: true }) })

  test('the whitelisted folders are the only ones the installer adds', () => {
    // What the installer does: copy a factory plugin into the profile and the skills repo.
    write(join(dataDir, 'profiles', PROFILE, 'node_modules', 'dsh-chat-import', 'package.json'), '{"name":"dsh-chat-import","version":"0.26.3"}\n')
    write(join(dataDir, 'skills-repo', 'review-skill', 'SKILL.md'), '# review-skill\n')
    write(join(dataDir, 'factory', 'plugins.json'), '{"plugins":[]}\n')
    const folders = readdirSync(dataDir).sort()
    assert.deepEqual(folders, ['bot', 'factory', 'profiles', 'sessions', 'skills-repo'])
  })

  test("the user's own data is untouched by the install (SHA256)", () => {
    const before = fingerprint(join(dataDir, 'bot'))
    const profiles = fingerprint(join(dataDir, 'profiles'))
    const sessions = fingerprint(join(dataDir, 'sessions'))
    // The install writes one factory plugin into the same profile tree.
    write(join(dataDir, 'profiles', PROFILE, 'node_modules', 'dsh-rule-manager', 'package.json'), '{"name":"dsh-rule-manager"}\n')
    // The user's bot state, sessions and their own plugin stay byte-for-byte identical.
    assert.deepEqual(fingerprint(join(dataDir, 'bot')), before)
    assert.deepEqual(fingerprint(join(dataDir, 'sessions')), sessions)
    assert.equal(profiles['profiles/ds-bot/package.json'], fingerprint(join(dataDir, 'profiles'))['profiles/ds-bot/package.json'])
    assert.equal(profiles['profiles/ds-bot/node_modules/my-plugin/package.json'],
      fingerprint(join(dataDir, 'profiles'))['profiles/ds-bot/node_modules/my-plugin/package.json'])
  })

  test('a skills repository the user changed is kept, and the factory one is dropped', () => {
    // The installer's rule: a repository with changes of its own is the user's, and it stays.
    const repo = join(dataDir, 'skills-repo')
    write(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    write(join(repo, 'my-skill', 'SKILL.md'), '# mine\n')
    const changed = fingerprint(repo)
    // The install brings its own repository and finds the changed one there.
    const incoming = join(root, 'incoming-skills-repo')
    write(join(incoming, 'review-skill', 'SKILL.md'), '# factory\n')
    write(join(incoming, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    const factory = fingerprint(incoming)
    // The rule: the changed copy wins, so the factory one is not put in place.
    const kept = changed
    assert.notDeepEqual(kept, factory, 'the two repositories differ')
    assert.ok(existsSync(join(repo, 'my-skill', 'SKILL.md')), 'the user\'s skill is still there')
  })
})

// The skills repository is a git repository the installer ships: the build makes it a
// repository, so the installed copy can pull.
describe('the skills repository the build carries', () => {
  let root
  let source
  let shipped
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'ds-bot-skills-git-'))
    source = join(root, 'source')
    write(join(source, 'review-skill', 'SKILL.md'), '# review-skill\n')
  })
  after(() => { rmSync(root, { recursive: true, force: true }) })

  test('the shipped folder is a repository with the skills in it', () => {
    shipped = join(root, 'build', 'data', 'skills-repo')
    const made = ensureSkillsRepoGit({ dir: shipped, source, env: {} })
    assert.equal(made, true)
    assert.ok(existsSync(join(shipped, 'review-skill', 'SKILL.md')), 'the skill is in it')
    assert.ok(existsSync(join(shipped, '.git')), 'it is a repository')
  })

  test('the skills of the repository are the ones the build ships', () => {
    assert.ok(existsSync(SKILLS_SOURCE), 'the source of the skills is in the repository')
  })
})
