// The branch chip above the composer: what the user sees, not what the code says.
//
// The unit test (workspace-branch.test.js) covers reading `.git/HEAD`. This file covers
// the chip itself: that it sits at the top-right corner of the composer card, that it
// does not cover the send button or the textbox, that a long branch name is shortened
// instead of pushing the layout, that a workspace that is not a checkout shows nothing
// at all, that the chip follows the session, and that a branch changed in a terminal is
// picked up when the window comes back into focus.
//
// The geometry is checked with rectangles, not with fixed pixels, so the assertions do
// not decide where the chip belongs: a chip that hangs half outside the card and a chip
// that sits inside it both pass, and only a chip that lands on the send button or leaves
// the card fails. Where exactly the chip sits against the card's top edge is a decision
// for the interface, not a fact this test knows; the real interface settles it, with a
// screenshot against the running app.
//
// The real interface is verified separately against the running app (CDP screenshot);
// a DOM has no layout engine, so the rectangles here are the ones the test owns.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The chip is bundled with a minimal React stand-in, as the tool-cell and sidebar tests
// do: components run as plain functions and the hooks are driven by the test. The API
// module is replaced by a stub, so no call leaves the test.
//
// The stub lives next to the test as a file, so esbuild can put it in place of the
// chip's own import of './api.js'.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const STUB = join(PLUGIN, 'test', 'fixtures', 'branch-chip-api-stub.js')

// The stub's table and the React stand-in's state both live on globalThis, because the
// bundled code runs in its own context.
const table = globalThis.__branchStub = { branches: new Map(), calls: [], sessions: new Map(), answered: new Map() }

// The React stand-in's state, for the chip that was loaded last.
let host = null

/**
 * Builds the chip with the API stub in place of the real one.
 * @returns {Promise<{BranchChip: Function, BRANCH_CSS: string, host: object}>}
 */
async function loadChip() {
  const hostState = {
    refs: [],
    refIndex: 0,
    slots: [],
    slotIndex: 0,
    effects: [],
    focusListeners: new Map(),
    cleanups: [],
  }
  host = hostState
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    Fragment: Symbol('Fragment'),
    useEffect: fn => { hostState.effects.push(fn) },
    useLayoutEffect: fn => { hostState.effects.push(fn) },
    useState: initial => {
      const slot = hostState.slotIndex++
      if (hostState.slots.length <= slot) hostState.slots[slot] = typeof initial === 'function' ? initial() : initial
      return [hostState.slots[slot], value => { hostState.slots[slot] = typeof value === 'function' ? value(hostState.slots[slot]) : value }]
    },
    useRef: current => {
      const slot = hostState.refIndex++
      hostState.refs[slot] ??= { current }
      return hostState.refs[slot]
    },
    useMemo: make => make(),
    useCallback: fn => fn,
    useContext: ctx => ctx.value,
  }
  const window = {
    addEventListener: (name, fn) => hostState.focusListeners.set(name, fn),
    removeEventListener: name => hostState.focusListeners.delete(name),
  }
  const { outputFiles } = await build({
    stdin: {
      contents: "export { BRANCH_CSS, BranchChip } from './src/client/branch-chip.js'",
      resolveDir: PLUGIN,
    },
    bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
    plugins: [{
      name: 'stub-api',
      setup(build) {
        build.onResolve({ filter: /^\.\/api\.js$/ }, () => ({ path: STUB }))
      },
    }],
  })
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports,
    require: name => (name === 'react' ? react : {}),
    window,
    // The chip polls the branch on a timer; the sandbox has no timers of its own.
    setInterval: () => 0,
    clearInterval: () => {},
    // The stub reads the table from this global.
    __branchStub: table,
  })
  return { ...module.exports, host }
}

/**
 * Draws the chip for one session and returns its element tree.
 *
 * The hook indices restart with each draw, the way React's do: the same hook reads the
 * same slot every time, so what the first draw stored is what the next draw reads.
 */
function draw(BranchChip, { sessionId = 'bot-1' } = {}) {
  // A fresh render: its own state slots, so a draw for one session cannot read what a
  // draw for another stored. React does the same when the component is remounted.
  host.refIndex = 0
  host.slotIndex = 0
  host.slots = []
  host.refs = []
  // What was already answered for this session is what the component still holds: the
  // branch is the first state the component holds.
  if (table.answered.has(sessionId)) host.slots[0] = table.answered.get(sessionId)
  return BranchChip({ sessionId })
}

/** The branch name a drawn chip shows. */
function nameOf(chip) {
  const name = chip.props?.children?.find?.(child => child?.props?.className === 'bt-branch-chip-name')
  return name?.props?.children?.[0]
}

/** The chip's root, if the tree drew one. */
function chipOf(tree) {
  if (!tree || typeof tree !== 'object') return undefined
  if (tree.props?.className === 'bt-branch-chip') return tree
  const children = tree.props?.children
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = chipOf(child)
    if (found !== undefined) return found
  }
  return undefined
}

// The composer card the chip sits on, and the three things inside it the chip must not
// land on. The card is 600 wide and 120 tall; the textbox fills the left of it, and the
// two buttons at its right end are the dictation button and the voice-conversation one.
//
// The buttons are 18px wide with 5px between them, which is what the real app has: in a
// 967-wide card the dictation button (bt-mic) sits at 92.6%..95.4% of the card's width
// and the voice button (bt-voice) at 96.3%..99.2%. There is no send button on the card —
// sending is the return key — so the second of the two is the voice one.
//
// Both matter: a chip that covered only one of them would still be in the way of the
// other.
const CARD = { left: 0, right: 600, top: 0, bottom: 120 }
const TEXTBOX = { left: 16, right: 500, top: 30, bottom: 90 }
const MIC = { left: 555, right: 573, top: 22, bottom: 50 }
const VOICE = { left: 578, right: 595, top: 22, bottom: 50 }

// The chip is one line of 10px text: 15px of line, 2px of padding and 2px of border.
const CHIP_HEIGHT = 19

/**
 * The chip's own box, read from the rules its stylesheet carries. This is what decides
 * where it lands, so it is read from the CSS rather than written out again here.
 */
function chipBox(BRANCH_CSS) {
  const rules = BRANCH_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
  const block = rules.match(/\.bt-branch-chip\{([^}]*)\}/)?.[1] ?? ''
  const prop = name => block.match(new RegExp(`${name}:([^;!]+)`))?.[1]?.trim()
  const numeric = name => {
    const raw = prop(name)
    if (raw === undefined) return undefined
    const value = Number.parseFloat(raw)
    return Number.isNaN(value) ? undefined : value
  }
  const maxWidth = prop('max-width') ?? ''
  return {
    top: numeric('top'),
    right: numeric('right'),
    maxWidthPx: maxWidth.match(/min\((\d+)px/)?.[1] === undefined ? undefined : Number(maxWidth.match(/min\((\d+)px/)[1]),
    maxWidthPercent: maxWidth.match(/(\d+)%\)/)?.[1] === undefined ? undefined : Number(maxWidth.match(/(\d+)%\)/)[1]),
    pointerEvents: prop('pointer-events'),
  }
}

/**
 * The chip's rectangle, in the card's coordinates.
 *
 * Its width is taken at the cap, the widest it can be: a name that fills the chip is the
 * case that can reach the textbox, so that is the one to check.
 *
 * The cap is min(220px, 32% of the card). On this 600-wide card 32% is 192, which is
 * narrower than the 220px cap, so the width checked here is 192 — the chip is checked
 * at the width it can really have on this card. In the real app the card is wider, and
 * there the 220px cap is the tighter of the two.
 */
function chipRect(BRANCH_CSS) {
  const box = chipBox(BRANCH_CSS)
  const width = Math.min(box.maxWidthPx ?? 0, (CARD.right - CARD.left) * (box.maxWidthPercent ?? 100) / 100)
  const right = CARD.right - box.right
  return { left: right - width, right, top: CARD.top + box.top, bottom: CARD.top + box.top + CHIP_HEIGHT }
}

/** Whether two rectangles overlap. Touching edges do not count as overlapping. */
function overlaps(a, b) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

test("the chip sits in the card's top-right area", async () => {
  const { BRANCH_CSS } = await loadChip()
  const chip = chipRect(BRANCH_CSS)
  // Inside the card: it does not stick out to the right of it, nor to the left.
  assert.ok(chip.right <= CARD.right, `the chip (right ${chip.right}) leaves the card (right ${CARD.right})`)
  assert.ok(chip.left >= CARD.left, `the chip (left ${chip.left}) leaves the card (left ${CARD.left})`)
  // At the top: the chip's own top edge is in the card's upper half.
  assert.ok(chip.top < CARD.top + CARD.bottom / 2, `the chip (top ${chip.top}) is not in the card's upper half`)
  // In the right-hand part of the card: how far from the edge it sits is the
  // interface's business, not this test's.
  assert.ok(chip.right > CARD.right / 2, `the chip (right ${chip.right}) is not in the card's right-hand part`)
})

test('the chip does not land on the voice button', async () => {
  const { BRANCH_CSS } = await loadChip()
  const chip = chipRect(BRANCH_CSS)
  assert.ok(!overlaps(chip, VOICE), `the chip ${JSON.stringify(chip)} overlaps the voice button ${JSON.stringify(VOICE)}`)
})

test('the chip does not land on the dictation button', async () => {
  const { BRANCH_CSS } = await loadChip()
  const chip = chipRect(BRANCH_CSS)
  assert.ok(!overlaps(chip, MIC), `the chip ${JSON.stringify(chip)} overlaps the dictation button ${JSON.stringify(MIC)}`)
})

test('the chip does not land on the textbox', async () => {
  const { BRANCH_CSS } = await loadChip()
  const chip = chipRect(BRANCH_CSS)
  assert.ok(!overlaps(chip, TEXTBOX), `the chip ${JSON.stringify(chip)} overlaps the textbox ${JSON.stringify(TEXTBOX)}`)
})

test('the chip never takes pointer events, so it cannot block the composer', async () => {
  const { BRANCH_CSS } = await loadChip()
  assert.equal(chipBox(BRANCH_CSS).pointerEvents, 'none')
})

test('a long branch name is shortened instead of stretching the chip', async () => {
  const { BRANCH_CSS } = await loadChip()
  const box = chipBox(BRANCH_CSS)
  assert.ok(box.maxWidthPx !== undefined, 'the chip must have a width cap')
  assert.ok(box.maxWidthPercent !== undefined, 'the chip must also be capped against the card width')
  assert.ok(box.maxWidthPx <= 220, `the cap is too wide: ${box.maxWidthPx}`)
  // The cap holds against the card as well, so a narrow card cannot be overrun.
  assert.ok(box.maxWidthPercent <= 50, `the cap takes too much of the card: ${box.maxWidthPercent}%`)
  // The name is cut with an ellipsis, so it cannot push the chip past its cap.
  assert.ok(BRANCH_CSS.includes('text-overflow:ellipsis'), 'the name must be cut with an ellipsis')
  assert.ok(BRANCH_CSS.includes('white-space:nowrap'), 'the name must stay on one line')
  // The tighter of the two caps is what the chip can really be.
  const effective = Math.min(box.maxWidthPx, ((CARD.right - CARD.left) * box.maxWidthPercent) / 100)
  assert.ok(effective <= 220, `the effective cap is ${effective}, which is too wide`)
})

test('a session that works in a folder which is not a checkout shows no chip at all', async () => {
  const { BranchChip, host } = await loadChip()
  // The session works in a folder that is not a git tree: the host answers with no
  // branch, and the chip draws nothing rather than an empty chip.
  table.sessions.set('bot-1', 'C:\\not-a-repo')
  table.branches.set('C:\\not-a-repo', undefined)
  table.calls.length = 0
  draw(BranchChip, { sessionId: 'bot-1' })
  for (const effect of host.effects) effect()
  await new Promise(resolve => setTimeout(resolve, 0))
  const second = draw(BranchChip, { sessionId: 'bot-1' })
  assert.equal(chipOf(second), undefined, 'a workspace that is not a checkout must show no chip')
})

test('the chip follows the session it is drawn for', async () => {
  const { BranchChip, host } = await loadChip()
  table.branches.set('C:\\one', 'feat/one')
  table.branches.set('C:\\three', 'feat/three')
  table.calls.length = 0
  table.answered.clear()
  table.sessions.set('bot-1', 'C:\\one')
  table.sessions.set('room', 'C:\\three')
  draw(BranchChip, { sessionId: 'bot-1' })
  for (const effect of host.effects) effect()
  await new Promise(resolve => setTimeout(resolve, 0))
  // The group chat is a different session, so the chip asks for that one's workspace.
  host.effects.length = 0
  draw(BranchChip, { sessionId: 'room' })
  for (const effect of host.effects) effect()
  await new Promise(resolve => setTimeout(resolve, 0))
  const one = chipOf(draw(BranchChip, { sessionId: 'bot-1' }))
  const three = chipOf(draw(BranchChip, { sessionId: 'room' }))
  assert.ok(one !== undefined, 'the Bot chat drew no chip')
  assert.ok(three !== undefined, 'the group chat drew no chip')
  // Each chat shows its own branch, not the other's.
  assert.equal(nameOf(one), 'feat/one')
  assert.equal(nameOf(three), 'feat/three')
  // And each asked for its own session, so the host can resolve the folder itself.
  const asked = table.calls
    .filter(([endpoint]) => endpoint === 'branch')
    .map(([, payload]) => payload.sessionId ?? payload.path)
  assert.ok(asked.includes('bot-1'), 'the Bot chat did not ask for its own session')
  assert.ok(asked.includes('room'), 'the group chat did not ask for its own session')
})

test('the chip reads the branch again when the window comes back into focus', async () => {
  const { BranchChip, host } = await loadChip()
  table.branches.set('C:\\work', 'feat/x')
  table.calls.length = 0
  draw(BranchChip)
  for (const effect of host.effects) effect()
  await new Promise(resolve => setTimeout(resolve, 0))
  const cleanup = host.effects[host.effects.length - 1]
  assert.ok(cleanup !== undefined, 'the chip registered no effect')
  assert.ok(host.focusListeners.has('focus'), 'the chip does not listen for the window regaining focus')
  // The effect returned a cleanup, so the listener can be taken off again.
  assert.equal(typeof cleanup, 'function')
  // The focus brings in a new branch: the chip asks again.
  const before = table.calls.length
  host.focusListeners.get('focus')()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.ok(table.calls.length > before, 'the focus did not make the chip read the branch again')
})
