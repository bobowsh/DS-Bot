// The first run's places and the decoupled import offer: a packaged Windows install keeps
// its data beside the program folder without asking, and the offer for the team of the user's
// own DSH follows any data folder until it is copied or declined once. Electron is the test
// double (test/helpers/loader.mjs), so no display and no data of the user are touched.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, before, describe, test } from 'node:test'
import { paths, state } from './helpers/fake-electron.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()
const { chooseLocations } = await import('../src/first-run.mjs')

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
const locationsFile = join(paths.userData, 'locations.json')

// A user's DSH home with one Bot: enough for the offer to find a team.
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
})

describe('the packaged Windows install', () => {
  before(() => {
    delete process.env.DS_BOT_HOME
    // A packaged layout of its own: <install>\app holds the exe, so the fixed folders land
    // under <install>, not in the temp root the shared fake path sits in.
    const install = mkdtempSync(join(tmpdir(), 'ds-bot-fr-install-'))
    paths.exe = join(install, 'app', 'DeepSeek Bot.exe')
  })

  test('fixes the folders beside the program folder and asks nothing', { skip: process.platform !== 'win32' && 'the fixed places are a Windows install rule' }, async () => {
    state.packaged = true
    process.env.DSH_HOME = dshHomeEmpty()
    const signal = new AbortController().signal
    const where = await chooseLocations(signal)
    const install = dirname(dirname(paths.exe))
    assert.equal(where.dataDir, join(install, 'data'))
    assert.equal(where.workspace, join(install, 'workspace'))
    assert.equal(state.dialogs.length, 0, 'no welcome box and no pickers')
    assert.equal(existsSync(where.dataDir), true, 'the data folder is made')
    assert.equal(existsSync(where.workspace), true, 'the workspace folder is made')
    const saved = JSON.parse(readFileSync(locationsFile, 'utf8'))
    assert.deepEqual(saved, { dataDir: join(install, 'data'), workspace: join(install, 'workspace') })
  })

  test('an install whose folder is a drive root is not fixed', { skip: process.platform !== 'win32' && 'the fixed places are a Windows install rule' }, async () => {
    state.packaged = true
    process.env.DSH_HOME = dshHomeEmpty()
    // An exe at a drive root makes the program folder itself the root: its "parent" is a
    // whole drive, not a place for one app's data. The path only computes; nothing is made there.
    paths.exe = 'C:\\DeepSeek Bot.exe'
    state.dialogAnswer = { response: 2 } // Quit at the welcome box: nothing beyond it is asked
    const where = await chooseLocations(new AbortController().signal)
    assert.equal(state.dialogs.length, 1, 'the first start asks instead of fixing')
    assert.match(state.dialogs[0].message, /Welcome to DeepSeek Bot/)
    assert.deepEqual(where, { quit: true })
  })

  test('an existing locations.json keeps its places and offers a waiting team', async () => {
    state.packaged = true
    const data = mkdtempSync(join(tmpdir(), 'ds-bot-fr-data-'))
    const workspace = join(data, 'workspace')
    mkdirSync(workspace, { recursive: true })
    write(locationsFile, JSON.stringify({ dataDir: data, workspace }))
    process.env.DSH_HOME = dshHomeWithTeam()
    state.dialogAnswer = { response: 0 } // Copy
    const where = await chooseLocations(new AbortController().signal)
    assert.equal(where.dataDir, data, 'the saved places stand')
    assert.equal(where.import?.from, process.env.DSH_HOME)
    assert.equal(state.dialogs.length, 1, 'only the offer, no welcome')
    assert.match(state.dialogs[0].message, /Copy it into DeepSeek Bot/)
  })

  test('declining the offer is remembered and the next start asks nothing', async () => {
    state.packaged = true
    const data = mkdtempSync(join(tmpdir(), 'ds-bot-fr-data-'))
    write(locationsFile, JSON.stringify({ dataDir: data, workspace: join(tmpdir(), 'ds-bot-fr-ws-') }))
    process.env.DSH_HOME = dshHomeWithTeam()
    state.dialogAnswer = { response: 1 } // Do not copy
    await chooseLocations(new AbortController().signal)
    assert.equal(existsSync(join(data, 'bot', 'import-declined')), true, 'the decline is kept in the data')
    state.dialogs.length = 0
    const where = await chooseLocations(new AbortController().signal)
    assert.equal(state.dialogs.length, 0, 'the offer does not return')
    assert.equal(where.import, undefined)
  })

  test('a quit during the offer leaves no decline behind', async () => {
    state.packaged = true
    const data = mkdtempSync(join(tmpdir(), 'ds-bot-fr-data-'))
    write(locationsFile, JSON.stringify({ dataDir: data, workspace: join(tmpdir(), 'ds-bot-fr-ws-') }))
    process.env.DSH_HOME = dshHomeWithTeam()
    const controller = new AbortController()
    // The answer arrives together with the request to quit: the dialog closes as Cancel.
    state.dialogAnswer = () => { controller.abort(); return { response: 0 } }
    const where = await chooseLocations(controller.signal)
    assert.deepEqual(where, { quit: true })
    assert.equal(existsSync(join(data, 'bot', 'import-declined')), false, 'a quit does not count')
  })

  test('a data folder that already holds a team is not offered another', async () => {
    state.packaged = true
    const data = mkdtempSync(join(tmpdir(), 'ds-bot-fr-data-'))
    write(join(data, 'bot', 'state.json'), JSON.stringify({ version: 1, bots: { x: { id: 'x' } }, rooms: {} }))
    write(locationsFile, JSON.stringify({ dataDir: data, workspace: join(tmpdir(), 'ds-bot-fr-ws-') }))
    process.env.DSH_HOME = dshHomeWithTeam()
    const where = await chooseLocations(new AbortController().signal)
    assert.equal(state.dialogs.length, 0)
    assert.equal(where.import, undefined)
  })
})

describe('a run that is not a packaged Windows install', () => {
  test('the first start still asks and its answer is saved', async () => {
    state.packaged = false
    process.env.DSH_HOME = dshHomeEmpty()
    state.dialogAnswer = { response: 0 } // Start with the shown places
    const where = await chooseLocations(new AbortController().signal)
    assert.equal(state.dialogs.length, 1)
    assert.match(state.dialogs[0].message, /Welcome to DeepSeek Bot/)
    const saved = JSON.parse(readFileSync(locationsFile, 'utf8'))
    assert.deepEqual(saved, { dataDir: where.dataDir, workspace: where.workspace })
  })

  test('an unpackaged Windows run keeps asking even beside a program folder', async () => {
    state.packaged = false
    process.env.DSH_HOME = dshHomeEmpty()
    state.dialogAnswer = { response: 0 }
    await chooseLocations(new AbortController().signal)
    assert.match(state.dialogs[0].message, /Welcome to DeepSeek Bot/, 'not the fixed places')
  })
})
