import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The AIDE bridge: our own column shows the workbench, and dsh-aide answers it.
// The event name is a contract between the two plugins, so it is pinned here and
// compared with the listener dsh-aide registers.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))

const { outputFiles } = await build({
  stdin: {
    contents: "export { AIDE_SHOW_EVENT, requestAideWorkbench } from './src/client/aide-bridge.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
})

const module = { exports: {} }
const dispatched = []
const sandbox = {
  module, exports: module.exports,
  require: () => ({}),
  Event,
  window: {
    dispatchEvent: event => { dispatched.push(event.type); return true },
    addEventListener() {},
    removeEventListener() {},
  },
}
runInNewContext(outputFiles[0].text, sandbox)
const { AIDE_SHOW_EVENT, requestAideWorkbench } = module.exports

test('the AIDE bridge asks for the workbench by a named window event', () => {
  assert.equal(typeof AIDE_SHOW_EVENT, 'string')
  assert.notEqual(AIDE_SHOW_EVENT, '')
  requestAideWorkbench()
  assert.deepEqual(dispatched, [AIDE_SHOW_EVENT])
})

test('the event name matches the one dsh-aide listens for', () => {
  // dsh-aide registers this listener in its own apply(); the string must be the
  // same on both sides or the button does nothing. The plugin is not part of
  // this repository, so the check only runs where that checkout is present.
  const aide = join(PLUGIN, '..', '..', 'dsh-plugins-dev', 'dsh-aide', 'src', 'client', 'index.tsx')
  if (!existsSync(aide)) return
  const source = readFileSync(aide, 'utf8')
  assert.ok(source.includes(`'${AIDE_SHOW_EVENT}'`), `dsh-aide 的源码里没有 ${AIDE_SHOW_EVENT}`)
  assert.ok(source.includes('service.show()'), 'dsh-aide 的监听里没有 service.show()')
})
