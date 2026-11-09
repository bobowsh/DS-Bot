// The own-ui alignment overlay: the desktop app turns off DSH's welcome / sign-in / API-key
// row on every start, keeps the runtime rows, and stops writing when a DSH update drops the row.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { parse } from 'yaml'
import { ownUiPatch, reconcileOwnUi, factoryOffNames, factoryOffRows, alignWorkDetailsPatch, OWN_UI_PATCH_NAME } from '../src/own-ui-patch.mjs'

const UI_ROW = '@deepseek-ai/dsh-client-ui-settings-account'

// A stand-in profile as the app's bundles compose it: dsh-base carries the runtime account
// rows, dsh-web-app the UI row and the model rows, `user` rows model the profile's patch.
function profile(user = []) {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-own-ui-'))
  return {
    name: 'ds-bot', dir, patchPath: join(dir, 'cordis.patch.yml'), skippedBundles: [],
    layers: [
      { packageName: '@deepseek-ai/dsh-base', packageDir: '', patchPaths: [], patches: [
        { insert: [{ id: 'deepseek-account', name: '@deepseek-ai/dsh-llm-deepseek-account' }] },
      ] },
      { packageName: '@deepseek-ai/dsh-web-app', packageDir: '', patchPaths: [], patches: [
        { insert: [
          { id: 'ui-settings-account', name: UI_ROW },
          { id: 'account-controller', name: '@deepseek-ai/dsh-account-controller' },
          { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek' },
        ] },
      ] },
    ],
    patches: user,
  }
}

const made = []
const track = (user) => { const p = profile(user); made.push(p.dir); return p }
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })

test('the overlay disables the UI row with the name it composes to', () => {
  assert.deepEqual(ownUiPatch(track()), [{ id: 'ui-settings-account', name: UI_ROW, disabled: true }])
})

test('the row stays off even after the user turns it off in the profile patch', () => {
  // The same row the user disabled by hand: the written overlay is the same and idempotent.
  const off = { id: 'ui-settings-account', name: UI_ROW, disabled: true }
  assert.deepEqual(ownUiPatch(track([off])), [{ id: 'ui-settings-account', name: UI_ROW, disabled: true }])
})

test('nothing is written when the composition has no such row', () => {
  const p = track()
  p.layers = p.layers.filter(({ packageName }) => packageName !== '@deepseek-ai/dsh-web-app')
  assert.equal(ownUiPatch(p), undefined)
})

test('reconcileOwnUi writes beside the profiles and the composition honours it', () => {
  const p = track()
  const [file] = reconcileOwnUi(p)
  // Outside the profile directory itself, so DSH only reads it through patchFiles.
  assert.equal(file, join(p.dir, '..', OWN_UI_PATCH_NAME))
  assert.notEqual(file, p.patchPath)
  assert.deepEqual(parse(readFileSync(file, 'utf8')), [{ id: 'ui-settings-account', name: UI_ROW, disabled: true }])
  // What runProfile composes with the overlay among the patchFiles rows: the UI is off, the
  // runtime and model rows are untouched.
  const entries = composeEntries([...p.layers.map(layer => layer.patches), ...parse(readFileSync(file, 'utf8'))])
  assert.equal(entries.find(entry => entry.id === 'ui-settings-account')?.disabled, true)
  for (const id of ['deepseek-account', 'account-controller', 'llm-deepseek']) {
    assert.notEqual(entries.find(entry => entry.id === id), undefined, `${id} stays mounted`)
    assert.notEqual(entries.find(entry => entry.id === id)?.disabled, true, `${id} is not disabled`)
  }
})

test('a stale overlay goes away when a DSH update drops the row', () => {
  const p = track()
  const [file] = reconcileOwnUi(p)
  assert.ok(existsSync(file))
  p.layers = p.layers.filter(({ packageName }) => packageName !== '@deepseek-ai/dsh-web-app')
  assert.deepEqual(reconcileOwnUi(p), [])
  assert.equal(existsSync(file), false)
})

// The factory plugins that ship turned off: they are turned off on every start, so a plugin
// whose service the user has not authorized does not sit there reconnecting.
test('the factory plugin that ships off is turned off on every start', () => {
  const p = track()
  p.layers.push({ packageName: 'ds-harness-remote', packageDir: '', patchPaths: [], patches: [
    { insert: [{ id: 'ds-harness-remote', name: 'ds-harness-remote' }] },
  ] })
  // The factory list is what says a plugin ships off: the build marks it there.
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-factory-off-'))
  made.push(home)
  mkdirSync(join(home, 'factory'), { recursive: true })
  writeFileSync(join(home, 'factory', 'plugins.json'), `${JSON.stringify({
    plugins: [{ name: 'ds-harness-remote', version: '0.6.3', disabled: true }],
  })}\n`, 'utf8')
  const [file] = reconcileOwnUi(p, factoryOffNames(home))
  const rows = parse(readFileSync(file, 'utf8'))
  assert.deepEqual(rows.find(row => row.id === 'ds-harness-remote'), { id: 'ds-harness-remote', name: 'ds-harness-remote', disabled: true })
  // The composed profile honours it: the plugin is off, the account UI row still off.
  const entries = composeEntries([...p.layers.map(layer => layer.patches), ...rows])
  assert.equal(entries.find(entry => entry.id === 'ds-harness-remote')?.disabled, true)
  assert.equal(entries.find(entry => entry.id === 'ui-settings-account')?.disabled, true)
})

test('a factory plugin that is not in the profile gets no row', () => {
  const p = track()
  assert.deepEqual(factoryOffRows(p, ['ds-harness-remote']), [])
  assert.deepEqual(factoryOffRows(p, []), [])
})

test('a factory list that is not there names no plugin that ships off', () => {
  assert.deepEqual(factoryOffNames(join(tmpdir(), 'ds-bot-no-factory-list')), [])
})

// The work-details mode in the profile's own layer of the ui-chat settings. The host's
// settings document IS the profile's patch file, so this row is the user's own choice —
// it must stay, or the mode falls back to the base layer's 「完全展开」.
const patchWithWorkDetails = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '- id: ui-chat',
  '  name: "@deepseek-ai/dsh-client-ui-chat"',
  '  config:',
  '    transcriptView: verbose',
  '- id: ui-settings-general',
  '  name: "@deepseek-ai/dsh-client-ui-settings-general"',
  '  config:',
  '    welcomeNoticeVersion: 2026-09-28.1',
  '',
].join('\n')

const patchFile = (content) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-work-details-'))
  made.push(dir)
  const file = join(dir, 'cordis.patch.yml')
  writeFileSync(file, content, 'utf8')
  return file
}

test('the work-details mode is realigned to the standard one', () => {
  const file = patchFile(patchWithWorkDetails)
  assert.equal(alignWorkDetailsPatch(file), true)
  const next = readFileSync(file, 'utf8')
  assert.ok(next.includes('transcriptView: standard'), 'the mode is the standard one')
  // The row stays: it is the user's own layer, and the host writes the choice back into it.
  assert.ok(next.includes('- id: ui-chat'), 'the row stays')
  assert.ok(next.includes('name: "@deepseek-ai/dsh-client-ui-chat"'), 'the name stays')
  // The other rows are untouched.
  assert.ok(next.includes('- id: ui-settings-general'))
  assert.ok(next.includes('welcomeNoticeVersion: 2026-09-28.1'))
})

test('a row that holds something else keeps it', () => {
  const file = patchFile([
    '- id: ui-chat',
    '  name: "@deepseek-ai/dsh-client-ui-chat"',
    '  config:',
    '    transcriptView: verbose',
    '    collapseTiming: completion',
    '- id: other',
    '  name: other-package',
    '',
  ].join('\n'))
  assert.equal(alignWorkDetailsPatch(file), true)
  const next = readFileSync(file, 'utf8')
  assert.ok(next.includes('transcriptView: standard'))
  assert.ok(next.includes('collapseTiming: completion'), 'the other field stays')
})

test('a mode the user already chose is left alone', () => {
  const file = patchFile(patchWithWorkDetails.replace('transcriptView: verbose', 'transcriptView: standard'))
  const before = readFileSync(file, 'utf8')
  assert.equal(alignWorkDetailsPatch(file), false)
  assert.equal(readFileSync(file, 'utf8'), before)
})

test('a profile without the mode is left alone', () => {
  const file = patchFile(patchWithWorkDetails.replace('    transcriptView: verbose\n', ''))
  const before = readFileSync(file, 'utf8')
  assert.equal(alignWorkDetailsPatch(file), false)
  assert.equal(readFileSync(file, 'utf8'), before)
})

test('a leftover shell of a row goes', () => {
  // The Host writes a row with only an id and a name when it takes the row over.
  // It serves no purpose of its own, so it goes.
  const file = patchFile([
    '- id: ui-chat',
    '  name: "@deepseek-ai/dsh-client-ui-chat"',
    '- id: ui-settings-general',
    '  name: "@deepseek-ai/dsh-client-ui-settings-general"',
    '  config:',
    '    welcomeNoticeVersion: 2026-09-28.1',
    '',
  ].join('\n'))
  assert.equal(alignWorkDetailsPatch(file), true)
  const next = readFileSync(file, 'utf8')
  assert.ok(!next.includes('- id: ui-chat'), 'the shell is gone')
  assert.ok(next.includes('- id: ui-settings-general'), 'the other rows stay')
})

test('a profile without a patch file is not an error', () => {
  assert.equal(alignWorkDetailsPatch(join(tmpdir(), 'ds-bot-no-patch-file', 'cordis.patch.yml')), undefined)
})
