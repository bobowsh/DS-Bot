import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

// #26: the account gear was drawn twice.
//
// The two places are the shell's own settings row and the foot of our own Bot
// column. A global flag (`accountSeated`) decided between them: whoever mounted
// first set it, and the other stood down. The flag did not say which surface it
// belonged to, so the shell's launcher — mounted but invisible while the shell's
// sidebar is a rail — still held the seat. In a plain Bot view, where the shell's
// sidebar is open, that would have put two usable gears on the page.
//
// The places now decide for themselves, by the surface mode: the classic page
// shows the account in the shell, the Bot page shows it in our own column.
//
// The components are read as text: importing them pulls in React, which the
// unit tests do not have.
const here = dirname(fileURLToPath(import.meta.url))
const read = (name) => readFileSync(join(here, '..', 'src', 'client', name), 'utf8')

const sidebar = read('sidebar.js')
const index = read('index.js')

test('the global seating flag is gone', () => {
  // It was the whole bug: one boolean, no surface, no owner.
  assert.doesNotMatch(sidebar, /accountSeated/)
  assert.doesNotMatch(index, /accountSeated/)
  assert.doesNotMatch(index, /seatAccount/)
  assert.doesNotMatch(sidebar, /seatAccount/)
})

test('every launcher says which place it is', () => {
  // Three places: the shell's settings row, the shell's own footer, our column.
  assert.match(sidebar, /place === 'column' \? mode === 'bot' : mode === 'agent'/)
  // The shell's seat.
  assert.match(index, /h\(AccountLauncher, \{ \.\.\.props, place: 'shell' \}\)/)
  // Our own column.
  assert.match(sidebar, /h\(AccountLauncher, \{ place: 'column', useSurface: props\.useSurface, actions \}\)/)
  // The shell's footer.
  assert.match(sidebar, /h\(AccountLauncher, \{ \.\.\.props, place: 'footer' \}\)/)
})

test('the classic page shows the account in the shell, the Bot page in our column', () => {
  // The shell's footer entry stands down on the Bot page: our column shows it there.
  assert.match(sidebar, /const mode = props\.useSurface \? props\.useSurface\(value => value\.mode\) : 'bot'\n  if \(mode !== 'agent'\) return null/)
})

test('a launcher that does not draw itself holds no menu and no listeners', () => {
  // The listeners used to hang on the window whatever the launcher did.
  const listener = sidebar.slice(sidebar.indexOf('const onDown = (event) =>'))
  assert.match(listener, /if \(!open \|\| !shown\) return undefined/)
  // And the menu portal only opens when the launcher draws.
  assert.match(sidebar, /if \(!shown\) return null/)
})

test('the mode comes from the surface the plugin owns', () => {
  // `surface` is the plugin's own store; the host's `wide` is the shell's column
  // width, which is a different thing entirely.
  assert.match(index, /const surface = createSource\(\{ mode: readMode\(\)/)
  // The hooks carry it, and the host turns a hook into its `useXxx` prop.
  assert.match(index, /hooks: \{ roster, ui, activity, work, memoryNews, registry, turnClock, live, computer, cards, heldCards, browserPages, browserTabs, browserHolds, surface,/)
})
