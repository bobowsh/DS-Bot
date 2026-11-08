import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The work-details mode: how much of a turn's tool calls shows.
//
// The host owns the setting (its `ui-chat` namespace) and offers four modes. DS Bot
// writes the host's own field, so the chat and the settings row never disagree.
//
// Nothing is written on startup. Earlier builds wrote a default mode on every
// start, and that write is what made a choice in the settings page impossible to
// keep: the user picked one, and the next start wrote the default over it.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))

const { outputFiles } = await build({
  stdin: {
    contents: "export { WORK_DETAILS, reasoningShown, thinkingShown, workDetailsToApply, workDetailsToSave, isWorkDetailsMode } from './src/client/work-details.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
})

const module = { exports: {} }
runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: () => ({}) })
const { WORK_DETAILS, reasoningShown, thinkingShown, workDetailsToApply, workDetailsToSave, isWorkDetailsMode } = module.exports

test('the host offers four modes and the standard one shows a settled thought', () => {
  const modes = WORK_DETAILS.map(([id]) => id).join('/')
  assert.equal(modes, 'compact/standard/detailed/verbose')
  // The standard mode keeps the first line of a settled thought; only compact folds it.
  assert.equal(reasoningShown('standard'), true)
  assert.equal(reasoningShown('compact'), false)
})

test('only the host\'s own modes count', () => {
  for (const mode of ['compact', 'standard', 'detailed', 'verbose']) {
    assert.equal(isWorkDetailsMode(mode), true, mode)
  }
  assert.equal(isWorkDetailsMode('expanded'), false)
  assert.equal(isWorkDetailsMode(undefined), false)
})

test('the team\'s mode reaches the host when the team has one', () => {
  // The team has a mode and the host carries another: the team's is written.
  assert.equal(workDetailsToApply('standard', 'verbose'), 'standard')
  // The host already carries it: nothing is written.
  assert.equal(workDetailsToApply('standard', 'standard'), undefined)
})

test('nothing is written when the team has no mode of its own', () => {
  // This is the fix for a choice that never survived a restart: the earlier builds
  // wrote a default on every start, and it overwrote whatever the user had picked.
  assert.equal(workDetailsToApply(undefined, 'detailed'), undefined)
  assert.equal(workDetailsToApply(undefined, undefined), undefined)
  assert.equal(workDetailsToApply('nonsense', 'detailed'), undefined)
})

test('a mode the user picks in the host\'s settings becomes the team\'s mode', () => {
  assert.equal(workDetailsToSave('compact', 'standard'), 'compact')
  // The same mode: nothing to save.
  assert.equal(workDetailsToSave('standard', 'standard'), undefined)
  // A host without a mode says nothing.
  assert.equal(workDetailsToSave(undefined, 'standard'), undefined)
})

test('the user\'s own switch wins over the work-details mode', () => {
  // No switch of their own: the mode decides, and only the compact mode folds the
  // thought away.
  assert.equal(thinkingShown({}, 'standard'), true)
  assert.equal(thinkingShown({}, 'compact'), false)
  assert.equal(thinkingShown(undefined, 'compact'), false)
  // A switch of their own wins over the mode, either way.
  assert.equal(thinkingShown({ thinking: true }, 'compact'), true)
  assert.equal(thinkingShown({ thinking: false }, 'verbose'), false)
})
