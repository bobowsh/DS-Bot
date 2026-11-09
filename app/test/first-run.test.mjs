// The first run's places: a packaged Windows install keeps its data beside the program folder
// without asking, and a first start elsewhere picks and saves. The team is not copied or asked
// about — it is seeded by the factory (src/factory.mjs, ds-bot's factory-seed). Electron is the
// test double (test/helpers/loader.mjs), so no display and no data of the user are touched.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, before, describe, test } from 'node:test'
import { paths, state } from './helpers/fake-electron.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()
const { chooseLocations, defaultPlaces, fixedPlaces } = await import('../src/first-run.mjs')

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
const locationsFile = join(paths.userData, 'locations.json')

// A user's DSH home with one Bot: once the offer's source, now only noise the first run ignores.
function dshHomeWithTeam() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-fr-dsh-'))
  write(join(home, 'bot', 'state.json'), JSON.stringify({ version: 1, bots: { 'session-a': { id: 'session-a', name: 'Chief' } }, rooms: {} }))
  return home
}

function dshHomeEmpty() {
  return mkdtempSync(join(tmpdir(), 'ds-bot-fr-dsh-'))
}

let savedDshHome
before(() => { savedDshHome = process.env.DSH_HOME })
afterEach(() => {
  state.dialogs.length = 0
  state.dialogAnswer = undefined
  state.packaged = false
  rmSync(locationsFile, { force: true })
  // The files that a broken locations.json leaves behind are gone with it.
  for (const name of readdirSync(paths.userData)) {
    if (name.startsWith('locations.json.broken-')) rmSync(join(paths.userData, name), { force: true })
  }
})

describe('the packaged Windows install', () => {
  before(() => {
    delete process.env.DS_BOT_HOME
    // A packaged layout of its own: <install>\app holds the exe.
    const install = mkdtempSync(join(tmpdir(), 'ds-bot-fr-install-'))
    paths.exe = join(install, 'app', 'LinkHarness.exe')
  })

  test('the folders are the ones beside the program folder and nothing is asked', { skip: process.platform !== 'win32' && 'the fixed places are a Windows install rule' }, async () => {
    state.packaged = true
    // No team in the user's own DSH: this test is about the folders, and an offer would keep
    // the places unsaved until the card is answered (main-import covers that side).
    process.env.DSH_HOME = dshHomeEmpty()
    const signal = new AbortController().signal
    const where = await chooseLocations(signal)
    // The app's own folders: the program in <install>\app, its data in <install>\data.
    const install = dirname(dirname(paths.exe))
    assert.equal(where.dataDir, join(install, 'data'), 'the data sits beside the program folder')
    assert.equal(where.workspace, join(install, 'workspace'), 'the workspace sits beside it too')
    assert.equal(state.dialogs.length, 0, 'no welcome box, no pickers and no import offer')
    assert.equal(existsSync(where.dataDir), true, 'the data folder is made')
    assert.equal(existsSync(where.workspace), true, 'the workspace folder is made')
    const saved = JSON.parse(readFileSync(locationsFile, 'utf8'))
    // The free space of the data's drive is kept with the places, so a later start can
    // tell when the drive has run short.
    assert.equal(saved.dataDir, where.dataDir)
    assert.equal(saved.workspace, where.workspace)
    assert.ok(saved.freeAtStart > 0, 'the free space of the drive is kept')
  })

  test('an install whose folder is a drive root does not change the places', { skip: process.platform !== 'win32' && 'the fixed places are a Windows install rule' }, async () => {
    state.packaged = true
    process.env.DSH_HOME = dshHomeEmpty()
    // An exe at a drive root makes the program folder itself the root: its "parent" is a
    // whole drive, not a place for one app's data. The path only computes; nothing is made there.
    paths.exe = 'C:\\LinkBot.exe'
    const where = await chooseLocations(new AbortController().signal)
    assert.equal(where.dataDir, defaultPlaces().dataDir, 'the default places are used')
    assert.notEqual(where.dataDir, 'C:\\data', 'not beside the program folder')
    assert.equal(state.dialogs.length, 0, 'the start asks nothing: the start page picks the place')
  })

  test('a program folder whose parent cannot be written falls back to the default places', { skip: process.platform !== 'win32' && 'the fixed places are a Windows install rule' }, async () => {
    state.packaged = true
    process.env.DSH_HOME = dshHomeEmpty()
    // The parent is a file, so nothing can be made beside the program there: the data could
    // never live there. The app says so instead of failing quietly.
    const root = mkdtempSync(join(tmpdir(), 'ds-bot-fr-nowrite-'))
    const parent = join(root, 'not-a-folder')
    writeFileSync(parent, 'this is a file')
    paths.exe = join(parent, 'app', 'LinkHarness.exe')
    const warnings = []
    const warn = console.warn
    console.warn = (...args) => { warnings.push(args.join(' ')) }
    let where
    try {
      where = await chooseLocations(new AbortController().signal)
    } finally {
      console.warn = warn
    }
    assert.equal(where.dataDir, defaultPlaces().dataDir, 'the default places are used')
    assert.ok(warnings.some(line => line.includes('cannot be written')), `the app says why: ${JSON.stringify(warnings)}`)
  })

  test('a saved locations.json is ignored: the places follow the program', async () => {
    // The data follows the program: a place saved from an earlier start is not read any more,
    // so an install that moved keeps its data beside itself.
    state.packaged = true
    const data = mkdtempSync(join(tmpdir(), 'ds-bot-fr-data-'))
    const workspace = join(data, 'workspace')
    mkdirSync(workspace, { recursive: true })
    write(locationsFile, JSON.stringify({ dataDir: data, workspace }))
    process.env.DSH_HOME = dshHomeWithTeam()
    const where = await chooseLocations(new AbortController().signal)
    assert.notEqual(where.dataDir, data, 'the saved place is not used')
    assert.notEqual(where.workspace, workspace, 'the saved workspace is not used')
    assert.equal(where.dataDir, fixedPlaces()?.dataDir ?? defaultPlaces().dataDir, 'the places follow the program')
    assert.equal(state.dialogs.length, 0, 'the first start asks nothing')
  })

  test('no import-declined marker is ever written — the offer is gone', async () => {
    state.packaged = true
    const data = mkdtempSync(join(tmpdir(), 'ds-bot-fr-data-'))
    write(locationsFile, JSON.stringify({ dataDir: data, workspace: join(tmpdir(), 'ds-bot-fr-ws-') }))
    process.env.DSH_HOME = dshHomeWithTeam()
    await chooseLocations(new AbortController().signal)
    assert.equal(existsSync(join(data, 'bot', 'import-declined')), false)
  })
})

describe('a saved places file that is not usable', () => {
  // The file is written on every start, so a broken one is simply written over: nothing reads it.
  test('a file that is not JSON at all is ignored, and the places follow the program', async () => {
    state.packaged = true
    write(locationsFile, '{ this is not json')
    process.env.DSH_HOME = dshHomeEmpty()
    const where = await chooseLocations(new AbortController().signal)
    assert.equal(where.recovered, undefined, 'nothing was recovered: the file is not read')
    assert.equal(where.dataDir, fixedPlaces()?.dataDir ?? defaultPlaces().dataDir, 'the places follow the program')
    assert.equal(state.dialogs.length, 0, 'the app asks nothing')
    const kept = readdirSync(paths.userData).filter(name => name.startsWith('locations.json.broken-'))
    assert.equal(kept.length, 0, 'the unreadable file is not kept aside: nothing read it')
    const saved = JSON.parse(readFileSync(locationsFile, 'utf8'))
    assert.equal(saved.dataDir, where.dataDir, 'the new place is saved')
  })

  test('a file that names no folder is ignored, and the places follow the program', async () => {
    state.packaged = true
    write(locationsFile, JSON.stringify({ workspace: 'C:\\somewhere' }))
    process.env.DSH_HOME = dshHomeEmpty()
    const where = await chooseLocations(new AbortController().signal)
    assert.equal(where.recovered, undefined, 'nothing was recovered: the file is not read')
    assert.equal(where.dataDir, fixedPlaces()?.dataDir ?? defaultPlaces().dataDir, 'the places follow the program')
  })

  test('a file that names a folder is ignored too', async () => {
    state.packaged = true
    const data = mkdtempSync(join(tmpdir(), 'ds-bot-fr-data-'))
    mkdirSync(join(data, 'workspace'), { recursive: true })
    write(locationsFile, JSON.stringify({ dataDir: data }))
    process.env.DSH_HOME = dshHomeEmpty()
    const where = await chooseLocations(new AbortController().signal)
    assert.equal(where.recovered, undefined, 'nothing was recovered: the file is not read')
    assert.notEqual(where.dataDir, data, 'the data does not stay where it was')
  })
})

describe('a run that is not a packaged Windows install', () => {
  test('the first start takes the default places and saves them', async () => {
    state.packaged = false
    process.env.DSH_HOME = dshHomeEmpty()
    const where = await chooseLocations(new AbortController().signal)
    assert.equal(where.dataDir, defaultPlaces().dataDir, 'the default places')
    assert.equal(where.workspace, defaultPlaces().workspace, 'the default workspace')
    assert.equal(state.dialogs.length, 0, 'the start page picks the place, not a dialog')
    const saved = JSON.parse(readFileSync(locationsFile, 'utf8'))
    assert.equal(saved.dataDir, where.dataDir, 'the places are saved')
    assert.equal(saved.workspace, where.workspace, 'the workspace is saved')
  })

  test('an unpackaged Windows run does not take the fixed places', async () => {
    state.packaged = false
    process.env.DSH_HOME = dshHomeEmpty()
    const where = await chooseLocations(new AbortController().signal)
    assert.notEqual(where.dataDir, fixedPlaces()?.dataDir, 'not the fixed places')
    assert.equal(where.dataDir, defaultPlaces().dataDir, 'the default places')
  })
})
