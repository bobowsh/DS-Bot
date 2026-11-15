import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The AIDE bridge: our own column opens the workbench the way the host's panel list does.
//
// This used to pin a window-event name and assert that we dispatched it — a test that
// passed while the button did nothing, because dsh-aide never listened for that event.
// The entry is the panel id dsh-aide registers as a main panel, opened through the host's
// layout service, so what is pinned here is that id and that call.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))

const { outputFiles } = await build({
  stdin: {
    contents: "export { AIDE_PANEL_ID, AIDE_OVERLAY_SELECTOR, aideWorkbenchOpen, watchAideWorkbench } from './src/client/aide-bridge.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
})

const module = { exports: {} }
runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: () => ({}) })
const { AIDE_PANEL_ID, AIDE_OVERLAY_SELECTOR, aideWorkbenchOpen } = module.exports

test('the AIDE panel id is the one dsh-aide registers', () => {
  // dsh-aide's own client.js declares `PANEL_ID = "dsh-aide"` and registers that id into
  // `main`; layout.selectPanel refuses an id that is not a registered main panel.
  assert.equal(AIDE_PANEL_ID, 'dsh-aide')
})

test('no invented window-event contract is left behind', () => {
  // The previous implementation dispatched `dvw-workbench-show`, which dsh-aide never
  // listened for. A leftover dispatch would be a second, silent dead path. The doc
  // comments still name the old event to explain why it went — so what is checked is the
  // code: no dispatch of it, and no listener contract pinned anywhere in our client.
  const source = readFileSync(join(PLUGIN, 'src', 'client', 'aide-bridge.js'), 'utf8')
  const code = source.split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
  assert.equal(code.includes("dispatchEvent(new Event('dvw-workbench-show'))"), false)
  assert.equal(code.includes('export const AIDE_SHOW_EVENT'), false)
})

test('the button opens the panel through the action, not by dispatching an event', async () => {
  // The button is what the user clicks; it must reach the host's panel navigation.
  const built = await build({
    stdin: {
      contents: "export { AideButton } from './src/client/aide-button.js'",
      resolveDir: PLUGIN,
    },
    bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
    external: ['react'],
  })
  const mod = { exports: {} }
  runInNewContext(built.outputFiles[0].text, {
    module: mod, exports: mod.exports,
    require: name => (name === 'react' ? { createElement: (type, props, ...children) => ({ type, props, children }) } : {}),
  })
  const opened = []
  const node = mod.exports.AideButton({ label: 'AIDE', actions: { openPanel: id => { opened.push(id); return true } } })
  node.props.onClick()
  assert.deepEqual(opened, ['dsh-aide'])
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
  open = true
  observers[0].callback()
  assert.deepEqual(seen, [false, true], 'it reports the change')
  observers[0].callback()
  assert.deepEqual(seen, [false, true], 'the same state is not reported again')
  stop()
  assert.equal(observers[0].disconnected, true, 'the watcher lets go')
})
