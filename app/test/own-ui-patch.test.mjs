// The own-ui alignment overlay: the desktop app turns off DSH's welcome / sign-in / API-key
// row on every start, keeps the runtime rows, and stops writing when a DSH update drops the row.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { parse } from 'yaml'
import { ownUiPatch, reconcileOwnUi, OWN_UI_PATCH_NAME } from '../src/own-ui-patch.mjs'

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
