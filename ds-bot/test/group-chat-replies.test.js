import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// 群聊只显示对话：成员气泡由轮次尾部画，工具块与状态行在群视图里不显示，
// 单聊的工具过程保持原样。
const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { TeamToolView, RelayTail, relayReset, relaySnapshot } from './src/client/cells.js'",
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
  createElement: h, Fragment,
  useEffect: (effect) => { effects.push(effect) },
  useLayoutEffect: (effect) => { effects.push(effect) },
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useMemo: make => make(), useRef: current => ({ current }), useId: () => 'card-id',
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
}
class FakeObserver {
  observe() {}
  disconnect() {}
}
// 会话容器：群视图的标记挂在这里，测试用它看标记的设置与清除。
const conversation = {
  attributes: new Map(),
  setAttribute(name, value) { this.attributes.set(name, value) },
  removeAttribute(name) { this.attributes.delete(name) },
  hasAttribute(name) { return this.attributes.has(name) },
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  document: {
    hidden: false,
    querySelector: selector => (selector === '[data-conversation-session]' ? conversation : null),
    addEventListener: () => {}, removeEventListener: () => {},
  },
  window: { addEventListener: () => {}, removeEventListener: () => {}, innerWidth: 1200, innerHeight: 800, matchMedia: () => ({ matches: false }), getSelection: () => null, visualViewport: null, dispatchEvent: () => {} },
  TextEncoder, MutationObserver: FakeObserver,
  navigator: {}, setTimeout: () => ({}), clearTimeout: () => {},
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      return { MarkdownText: ({ text }) => text, writeClipboard: () => Promise.resolve(true) }
    }
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { TeamToolView, RelayTail, relayReset, relaySnapshot } = module.exports

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
const mount = () => {
  const cleanups = effects.map(effect => effect()).filter(cleanup => typeof cleanup === 'function')
  effects = []
  return () => { for (const cleanup of cleanups) cleanup() }
}

const writer = { id: 'writer', name: 'Writer', color: 'blue' }
const chief = { id: 'chief', name: 'Chief', color: 'green' }
const room = { id: 'room', name: 'Ops', members: ['writer', 'chief'], admin: 'chief' }
const team = (over = {}) => ({
  bots: [writer, chief], byId: { writer, chief }, rooms: [room], roomsById: { room }, exchangeTurns: {},
  questions: {}, secretRequests: {}, secrets: [], prefs: {}, ...over,
})
const relayCall = (callId, replies, turn = 1) => ({
  kind: 'tool-result', name: 'group_relay', callId, turn,
  call: { name: 'group_relay' },
  content: [{ type: 'text', text: JSON.stringify({ replies }) }],
})
const toolProps = (block, { sessionId = 'room', roster = team() } = {}) => ({
  sessionId,
  toolName: 'group_relay',
  phase: 'result',
  block,
  useRoster: select => select(roster),
  useUi: select => select({ reactions: {}, visits: {} }),
  actions: {},
  useHeldCards: select => select({}),
})
const tailOf = (sessionId, turn, roster = team()) => expand(RelayTail({
  turn: { turn },
  sessionId,
  useRoster: select => select(roster),
  actions: {},
  useUi: select => select({ reactions: {}, visits: {} }),
}))

test('the group relay row hands its replies to the turn tail and draws no bubble itself', () => {
  relayReset()
  const replies = [{ botId: 'writer', text: 'Draft is up.' }]
  const row = expand(TeamToolView(toolProps(relayCall('c1', replies))))
  mount()
  // The tool row itself carries no bubble: the reply belongs after the fold.
  assert.equal(findAll(row, node => node.props?.className === 'bt-group-msg').length, 0)
  // The tail has it, once, with the member's name.
  const tail = tailOf('room', 1)
  assert.equal(findAll(tail, node => node.props?.className === 'bt-group-msg').length, 1)
  assert.match(text(tail), /Writer.*Draft is up\./)
})

test('two relays in one turn keep their own replies, in order, each once', () => {
  relayReset()
  const first = relayCall('c1', [{ botId: 'writer', text: 'First reply.' }])
  const second = relayCall('c2', [{ botId: 'writer', text: 'Second reply.' }])
  expand(TeamToolView(toolProps(first)))
  mount()
  expand(TeamToolView(toolProps(second)))
  mount()
  const tail = tailOf('room', 1)
  assert.match(text(tail), /First reply\..*Second reply\./)
  assert.equal(text(tail).split('First reply.').length - 1, 1)
  assert.equal(text(tail).split('Second reply.').length - 1, 1)
})

test('a redraw of the same relay does not duplicate its replies', () => {
  relayReset()
  const replies = [{ botId: 'writer', text: 'Draft is up.' }]
  for (let i = 0; i < 3; i++) {
    expand(TeamToolView(toolProps(relayCall('c1', replies))))
    mount()
  }
  const tail = tailOf('room', 1)
  assert.equal(text(tail).split('Draft is up.').length - 1, 1)
})

test('a relay with no replies leaves the turn tail empty', () => {
  relayReset()
  expand(TeamToolView(toolProps(relayCall('c1', []))))
  mount()
  const tail = tailOf('room', 1)
  assert.equal(findAll(tail, node => node.props?.className === 'bt-group-msg').length, 0)
})

test('the group marker is set for a group chat and cleared for a private one', () => {
  relayReset()
  conversation.attributes.clear()
  const groupRoster = team()
  // A group session marks the conversation container, so the styles can hide the
  // tool blocks there only.
  expand(RelayTail({ turn: { turn: 1 }, sessionId: 'room', useRoster: select => select(groupRoster), actions: {}, useUi: select => select({ reactions: {} }) }))
  mount()
  assert.equal(conversation.hasAttribute('data-bt-group-chat'), true)
  // A private session clears it: a leftover marker would hide that chat's tools too.
  expand(RelayTail({ turn: { turn: 1 }, sessionId: 'chief', useRoster: select => select(groupRoster), actions: {}, useUi: select => select({ reactions: {} }) }))
  mount()
  assert.equal(conversation.hasAttribute('data-bt-group-chat'), false)
})

test('the reply library keeps one entry per session and turn', () => {
  relayReset()
  expand(TeamToolView(toolProps(relayCall('c1', [{ botId: 'writer', text: 'Draft is up.' }]), { sessionId: 'room' })))
  mount()
  const snapshot = relaySnapshot()
  assert.deepEqual(Object.keys(snapshot), ['room:1'])
  assert.equal(snapshot['room:1'][0].callId, 'c1')
  assert.equal(snapshot['room:1'][0].rows[0].text, 'Draft is up.')
})
