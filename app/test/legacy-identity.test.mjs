import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { parse } from 'yaml'
import { UUID } from 'builder-util-runtime'
import { APP_ID, configureIdentity, LEGACY_ARTIFACT_PREFIX, LEGACY_PRODUCT_NAME, LEGACY_USER_DATA_NAMES } from '../src/legacy.mjs'

function fixture({ saved = [], packaged = true } = {}) {
  const app = new EventEmitter()
  const appData = join(tmpdir(), 'dsbot-identity-fixture')
  const current = join(appData, 'DS Bot')
  const legacy = join(appData, LEGACY_PRODUCT_NAME)
  const paths = { appData, userData: current }
  const names = []
  Object.assign(app, {
    isPackaged: packaged,
    getPath: name => paths[name],
    setPath: (name, value) => { paths[name] = value },
    setName: name => names.push(name),
    setAppUserModelId: id => { app.id = id },
  })
  const exists = path => saved.includes(path)
  return { app, paths, names, current, legacy, exists }
}

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`${platform}: an existing installation keeps its shell data and encryption identity`, () => {
    const f = fixture()
    let created
    const options = { env: {}, platform, mkdir: path => { created = path }, exists: path => path === f.legacy }
    assert.deepEqual(configureIdentity(f.app, options), { userData: f.legacy, legacy: true })
    assert.equal(f.paths.sessionData, f.legacy)
    assert.equal(created, f.legacy)
    if (platform === 'win32') {
      assert.equal(f.app.id, APP_ID)
      assert.deepEqual(f.names, [])
    } else {
      assert.deepEqual(f.names, [LEGACY_PRODUCT_NAME])
      f.app.emit('ready')
      // The visible name restored on ready is the product's own name, not the folder it reused.
      assert.deepEqual(f.names, [LEGACY_PRODUCT_NAME, 'LinkHarness'])
    }
  })
}

test('a fresh installation uses the new shell directory', () => {
  const f = fixture()
  assert.deepEqual(configureIdentity(f.app, { env: {}, platform: 'linux', mkdir: () => {}, exists: f.exists }), { userData: f.current, legacy: false })
  assert.deepEqual(f.names, [])
})

test('an already configured new installation wins when both directories exist', () => {
  const f = fixture()
  const existing = [f.legacy, join(f.current, 'locations.json')]
  assert.equal(configureIdentity(f.app, { env: {}, mkdir: () => {}, exists: path => existing.includes(path) }).userData, f.current)
})

test('an explicit shell directory never probes installed user data', () => {
  const f = fixture()
  const explicit = join(tmpdir(), 'dsbot-custom-shell')
  assert.equal(configureIdentity(f.app, { env: { DS_BOT_SHELL_DATA: explicit }, mkdir: () => {}, exists: () => { throw new Error('must not probe') } }).userData, explicit)
  assert.equal(f.paths.sessionData, explicit)
})

test('an isolated data run never probes an installed application', () => {
  const f = fixture({ packaged: false })
  assert.equal(configureIdentity(f.app, { env: { DS_BOT_HOME: '/tmp/dsbot-test-data' }, mkdir: () => {}, exists: () => { throw new Error('must not probe') } }).userData, f.current)
})

test('a source installation also keeps its existing shell data', () => {
  const f = fixture({ packaged: false })
  assert.equal(configureIdentity(f.app, { env: {}, mkdir: () => {}, exists: path => path === f.legacy }).userData, f.legacy)
})

// 只装过「内部 product name 还是 DS Bot」那一代的机器，userData 目录只有 `DS Bot`。
// 名单里少了它，这些用户升级后就会落进空的 LinkHarness，设置和 locations 都看不到。
test('an installation that only ever had the DS Bot folder is reused', () => {
  const f = fixture()
  const onlyDsBot = join(f.paths.appData, 'DS Bot')
  // 新的 userData 是 LinkHarness，没有 locations.json；旧的 DS Bot 才有。
  f.paths.userData = join(f.paths.appData, 'LinkHarness')
  const result = configureIdentity(f.app, {
    env: {}, platform: 'linux', mkdir: () => {},
    exists: path => path === onlyDsBot || path === join(onlyDsBot, 'locations.json'),
  })
  assert.equal(result.userData, onlyDsBot, 'falls back to the DS Bot folder')
  assert.equal(result.legacy, true)
})

test('the legacy list runs newest to oldest and includes every shipped folder', () => {
  // 顺序是有意义的：第一个存在的目录被复用，所以最近的一代必须排在前面。
  assert.deepEqual(LEGACY_USER_DATA_NAMES, ['LinkBot', 'DS Bot', 'DeepSeek Bot'])
})

for (const suffix of ['mac-arm64.zip', 'mac-x64.zip', 'linux-amd64.deb']) {
  test(`old update clients receive the identical DS Bot payload: ${suffix}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'dsbot-release-alias-'))
    try {
      const source = join(root, `DS-Bot-1.2.3-${suffix}`)
      const payload = Buffer.from('new DS Bot package')
      writeFileSync(source, payload)
      const result = spawnSync(process.execPath, ['scripts/legacy-release-assets.mjs', source], { cwd: new URL('../', import.meta.url), encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      const alias = join(root, `${LEGACY_ARTIFACT_PREFIX}-1.2.3-${suffix}`)
      assert.deepEqual(readFileSync(alias), payload)
      assert.equal(existsSync(source), true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}


test('renaming the Windows application preserves the published installer GUID', () => {
  const config = parse(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'))
  const published = UUID.v5('io.github.fei2411.deepseekbot', UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3'))
  assert.equal(config.appId, APP_ID)
  assert.equal(config.nsis.guid, published)
})
