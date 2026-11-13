import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The reply row of a Turn the host called answerless, bundled once and rendered with a
// minimal React: components run as plain functions, effects are collected and run.
const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { AssistantCell } from './src/client/cells.js'",
      "export { answerlessReply } from './src/client/turn-reasoning.js'",
    ].join('\n'),
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

let effects = []
const Fragment = Symbol('Fragment')
const h = (type, props, ...children) => ({ type, props: { ...props, children } })
const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useCallback: fn => fn,
  createElement: h,
  Fragment,
  useEffect: (effect) => { effects.push(effect) },
  useLayoutEffect: (effect) => { effects.push(effect) },
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useMemo: make => make(),
  useRef: current => ({ current }),
  useId: () => 'test-id',
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
}
class FakeObserver {
  constructor() {}
  observe() {}
  disconnect() {}
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  document: { hidden: false }, TextEncoder, MutationObserver: FakeObserver,
  navigator: {},
  setTimeout: () => ({}),
  clearTimeout: () => {},
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      return {
        MarkdownText: ({ text }) => text,
        writeClipboard: () => Promise.resolve(true),
      }
    }
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { AssistantCell, answerlessReply } = module.exports

const expand = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, props: { ...node.props, children: expand(node.props.children) } }
}
const text = (node) => {
  if (node === null || node === undefined) return ''
  if (Array.isArray(node)) return node.map(text).join('')
  return typeof node === 'object' ? text(node.props.children) : String(node)
}
const findAll = (node, match) => {
  const found = []
  const visit = (entry) => {
    if (Array.isArray(entry)) { entry.forEach(visit); return }
    if (!entry || typeof entry !== 'object') return
    if (match(entry)) found.push(entry)
    visit(entry.props?.children)
  }
  visit(node)
  return found
}

const bot = { id: 'writer', name: 'Writer', color: 'blue' }
const roster = { bots: [bot], byId: { writer: bot }, rooms: [], roomsById: {}, exchangeTurns: {}, prefs: {} }
const textBlock = value => ({ kind: 'text', text: value })
const toolBlock = name => ({ kind: 'tool-call', name })
const reasonBlock = value => ({ kind: 'reasoning', text: value })
const step = (n, blocks) => ({ step: n, seq: 100 + n, status: 'settled', blocks, time: 1000 + n })
// The host hands a turn's steps over as their data, in anchor order (client.js: TurnKindNodes.read).
const show = (data, { steps, turnProcess } = {}) => expand(AssistantCell({
  node: { key: `step-${data.step}`, data },
  sessionId: 'writer',
  steps,
  useRoster: value => value(roster),
  useTurnSteps: () => steps ?? [data],
  useTurnContext: () => [],
  useTurnData: () => undefined,
  useWorkDetails: value => value('detailed'),
  turnProcess,
  actions: {},
}))

// A Turn that ends on a tool call: the host reads `answerStep: null` (client.js
// latestAnswer), so none of its steps is the answer.
const answerless = { spec: { turn: 1, answerAnchorSeq: null, answerStep: null }, foldable: true, hasContent: true, open: false }
// A Turn that ends on its reply: the host names that step as the answer.
const answered = step => ({ spec: { turn: 1, answerAnchorSeq: 105 + step, answerStep: step }, foldable: true, hasContent: true, open: false })

test('an answerless Turn shows the last step that is reply text and nothing else', () => {
  const steps = [
    step(0, [reasonBlock('thinking'), toolBlock('pwsh')]),
    step(1, [textBlock('我把这一段改完了。'), toolBlock('pwsh')]),
    step(2, [textBlock('定位结论在下面：')]),
    step(3, [toolBlock('group_relay')]),
  ]
  const reply = answerlessReply(steps, answerless)
  assert.equal(reply.step, 2)
  // The last step is a bare tool call, and the step before it carries its own tool
  // call: neither can stand as the reply.
  assert.equal(answerlessReply(steps.slice(0, 2).concat([step(3, [toolBlock('group_relay')])]), answerless), undefined)
})

test('a Turn the host answered keeps its own answer step, and no step of a Turn mid-run is lifted', () => {
  const steps = [step(0, [textBlock('第一段')]), step(1, [textBlock('最终回答')])]
  assert.equal(answerlessReply(steps, answered(1)), undefined)
  // Without the host's process spec there is no answerlesness to act on.
  assert.equal(answerlessReply(steps, undefined), undefined)
})

test('the reply step of an answerless Turn draws its bubble outside the fold', () => {
  const steps = [
    step(0, [reasonBlock('thinking'), toolBlock('pwsh')]),
    step(1, [textBlock('我把这一段改完了。')]),
    step(2, [toolBlock('group_relay')]),
  ]
  const out = show(steps[1], { steps, turnProcess: answerless })
  // The reply paragraph sits beside the fold, so the fold no longer decides its visibility.
  assert.equal(findAll(out, node => node.props?.className === 'bt-astack').length, 1)
  assert.match(text(out), /我把这一段改完了。/)
  // The turn's reasoning stays in the process rows, not doubled in the reply row.
  assert.equal(findAll(out, node => node.props?.className === 'bt-think').length, 0)
})

test('a step that calls a tool keeps folding with the process, and the answered Turn is unchanged', () => {
  const steps = [
    step(0, [reasonBlock('thinking'), toolBlock('pwsh')]),
    step(1, [textBlock('我把这一段改完了。')]),
  ]
  // The step holding the tool call draws no bubble of its own.
  const toolStep = show(steps[0], { steps, turnProcess: answerless })
  assert.equal(findAll(toolStep, node => node.props?.className === 'bt-astack').length, 0)
  // A Turn the host answered already shows its answer step as a row; this change adds nothing.
  const answeredSteps = [step(0, [toolBlock('pwsh')]), step(1, [textBlock('最终回答')])]
  assert.equal(answerlessReply(answeredSteps, answered(1)), undefined)
  effects = []
})
