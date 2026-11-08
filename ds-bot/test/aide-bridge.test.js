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
    contents: "export { AIDE_SHOW_EVENT, AIDE_OVERLAY_SELECTOR, requestAideWorkbench, aideWorkbenchOpen, watchAideWorkbench } from './src/client/aide-bridge.js'",
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
const { AIDE_SHOW_EVENT, AIDE_OVERLAY_SELECTOR, requestAideWorkbench, aideWorkbenchOpen } = module.exports

test('the AIDE bridge asks for the workbench by a named window event', () => {
  assert.equal(typeof AIDE_SHOW_EVENT, 'string')
  assert.notEqual(AIDE_SHOW_EVENT, '')
  requestAideWorkbench()
  assert.deepEqual(dispatched, [AIDE_SHOW_EVENT])
})

// The workbench stands in the host's main area, so our own column steps aside while
// it is up. The mark it leaves in the DOM is how we know.
test('the workbench is recognised by the mark it leaves in the page', () => {
  const tree = (html) => ({ querySelector: selector => (html.includes('dvw-overlay') && selector === '.dvw-overlay' ? {} : null) })
  assert.equal(aideWorkbenchOpen(tree('<div class="dvw-overlay"></div>')), true)
  assert.equal(aideWorkbenchOpen(tree('<div class="other"></div>')), false)
  assert.equal(AIDE_OVERLAY_SELECTOR, '.dvw-overlay')
})

test('the watcher reports the state now and every change after it', async () => {
  const seen = []
  const observers = []
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this) }
    observe() {}
    disconnect() { this.disconnected = true }
  }
  // The page the built module sees: the workbench is not up yet.
  let open = false
  const document = { body: {}, querySelector: () => (open ? {} : null) }
  const built = await build({
    stdin: {
      contents: "export { watchAideWorkbench } from './src/client/aide-bridge.js'",
      resolveDir: PLUGIN,
    },
    bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  })
  const mod2 = { exports: {} }
  runInNewContext(built.outputFiles[0].text, {
    module: mod2, exports: mod2.exports, require: () => ({}), MutationObserver: FakeMutationObserver, document,
  })
  const stop = mod2.exports.watchAideWorkbench(value => seen.push(value))
  assert.deepEqual(seen, [false], 'it reports the state at the start')
  assert.equal(observers.length, 1, 'it watches the page')
  // The workbench comes up: the watcher says so.
  open = true
  observers[0].callback()
  assert.deepEqual(seen, [false, true], 'it reports the change')
  // And again: the same state is not reported twice.
  observers[0].callback()
  assert.deepEqual(seen, [false, true], 'the same state is not reported again')
  stop()
  assert.equal(observers[0].disconnected, true, 'the watcher lets go')
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
