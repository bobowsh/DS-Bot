import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The work-details mode a fresh profile opens on.
//
// The host owns the setting (its `ui-chat` namespace) and offers four modes. The
// team opens on the standard one: enough of a turn's process to see what the Bots
// ran, without the fully expanded rows. A mode the user picked is never changed.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))

const { outputFiles } = await build({
  stdin: {
    contents: "export { DEFAULT_WORK_DETAILS, WORK_DETAILS, reasoningShown } from './src/client/work-details.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
})

const module = { exports: {} }
runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: () => ({}) })
const { DEFAULT_WORK_DETAILS, WORK_DETAILS, reasoningShown } = module.exports

test('the default work-details mode is one the host accepts', () => {
  assert.equal(DEFAULT_WORK_DETAILS, 'standard')
  const modes = WORK_DETAILS.map(([id]) => id)
  assert.ok(modes.includes(DEFAULT_WORK_DETAILS), `${DEFAULT_WORK_DETAILS} 不在宿主给的 ${modes.join('/')} 里`)
})

test('the default mode shows a settled thought beside its title', () => {
  // The standard mode keeps the first line of a settled thought; only compact folds it.
  assert.equal(reasoningShown(DEFAULT_WORK_DETAILS), true)
  assert.equal(reasoningShown('compact'), false)
})
