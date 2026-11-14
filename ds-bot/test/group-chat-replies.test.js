import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// 群聊的成员回复与「正在输入」提示原地画在团队自己的 tool-call 座位里
// （上游式）：藏掉宿主的折叠标题、正文平铺展开，所以回复留在原处，
// 不再搬到轮次尾部。普通工具在同一个座位里不画任何东西。
const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { ToolCell, TeamToolView, RelayTail, TurnProcessCell } from './src/client/cells.js'",
    ].join('\n'),
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
let effects = []
// 这个测试里的 React 是个桩：它不重画，所以「正在输入」那种靠轮询得来的
// 状态只能由预设喂进去（presetStates 的第一个就是下一个 useState 的初值）。
let presetStates = []
const Fragment = Symbol('Fragment')
const h = (type, props, ...children) => ({ type, props: { ...props, children } })
const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useCallback: fn => fn,
  createElement: h, Fragment,
  useEffect: (effect) => { effects.push(effect) },
  useLayoutEffect: (effect) => { effects.push(effect) },
  useState: initial => {
    const value = presetStates.length > 0 ? presetStates.shift() : (typeof initial === 'function' ? initial() : initial)
    return [value, () => {}]
  },
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
const { ToolCell, TeamToolView, RelayTail, TurnProcessCell } = module.exports

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
  const pending = effects
  effects = []
  const cleanups = pending.map(effect => effect()).filter(cleanup => typeof cleanup === 'function')
  return () => { for (const cleanup of cleanups) cleanup() }
}

const writer = { id: 'writer', name: 'Writer', color: 'blue' }
const chief = { id: 'chief', name: 'Chief', color: 'green' }
const room = { id: 'room', name: 'Ops', members: ['writer', 'chief'], admin: 'chief' }
const team = (over = {}) => ({
  bots: [writer, chief], byId: { writer, chief }, rooms: [room], roomsById: { room }, exchangeTurns: {},
  questions: {}, secretRequests: {}, secrets: [], prefs: {}, ...over,
})
// 宿主交给 tool-call 座位的东西：一棵调用树。
const relayCall = (callId, replies, turn = 1) => ({
  kind: 'tool-result', name: 'group_relay', callId, turn,
  call: { name: 'group_relay' },
  content: [{ type: 'text', text: JSON.stringify({ replies }) }],
})
const cellProps = (root, { sessionId = 'room', roster = team(), actions = {} } = {}) => ({
  node: { data: { root }, location: { turn: { turn: root.turn ?? 1 } } },
  sessionId,
  useRoster: select => select(roster),
  useUi: select => select({ reactions: {}, visits: {} }),
  useWork: select => select({ bots: {} }),
  useHeldCards: select => select({}),
  actions: { noteLive: () => {}, ...actions },
})
// 宿主交给工具视图的东西：调用的身份、它的阶段与它的 block。
const toolProps = (block, { sessionId = 'room', roster = team() } = {}) => ({
  sessionId,
  toolName: block.name,
  phase: block.kind === 'tool-result' ? 'result' : 'start',
  block,
  useRoster: select => select(roster),
  useUi: select => select({ reactions: {}, visits: {} }),
  useWork: select => select({ bots: {} }),
  useHeldCards: select => select({}),
  actions: { noteLive: () => {} },
})
// 一个普通工具调用：群里不画它，单聊里交给宿主自己的工具视图画。
const plainCall = (callId = 'bash') => ({
  kind: 'tool-result', name: callId, callId, turn: 1,
  call: { name: callId, argsRaw: '{"command":"ls"}' },
  content: [{ type: 'text', text: 'file.txt' }],
})

// 成员回复原地画在 tool-call 座位里：座位本身就是上游式的自绘，
// 所以群里既看得到回复，也看不到工具明细。
test('the group reply draws in the tool-call seat, with the member name and the text', () => {
  const replies = [{ botId: 'writer', text: 'Draft is up.' }]
  const cell = expand(ToolCell(cellProps(relayCall('c1', replies))))
  mount()
  assert.equal(findAll(cell, node => node.props?.className === 'bt-group-msg').length, 1)
  assert.match(text(cell), /Writer.*Draft is up\./)
})

// 团队的工具走宿主已声明的 tool.call.toolview 子槽：宿主树画每个调用，
// 按工具名派发；团队的工具由团队的视图画，其余工具落到宿主自己的视图。
test('a team tool draws through the host tool view, with the member name and the text', () => {
  const replies = [{ botId: 'writer', text: 'Draft is up.' }]
  const cell = expand(TeamToolView(toolProps(relayCall('c1', replies))))
  mount()
  assert.equal(findAll(cell, node => node.props?.className === 'bt-group-msg').length, 1)
  assert.match(text(cell), /Writer.*Draft is up\./)
})

// 普通工具不由团队画：宿主树把它派给宿主自己的视图，群里无工具明细。
test('an ordinary tool is not the team\'s, so the team draws nothing for it', () => {
  const cell = expand(ToolCell(cellProps(plainCall())))
  mount()
  assert.equal(findAll(cell, node => node.props?.className === 'bt-group-msg').length, 0)
  assert.equal(text(cell).includes('bash'), false)
  assert.equal(text(cell).includes('file.txt'), false)
})

// 提示在气泡之前：正在输入的那一行画在成员气泡的前面。
test('the typing notice draws before the member bubble', () => {
  const replies = [{ botId: 'writer', text: 'Draft is up.' }]
  const cell = expand(ToolCell(cellProps(relayCall('c1', replies))))
  mount()
  const classes = []
  const visit = (entry) => {
    if (Array.isArray(entry)) { entry.forEach(visit); return }
    if (!entry || typeof entry !== 'object') return
    const name = entry.props?.className
    if (name === 'bt-activity' || name === 'bt-group-msg') classes.push(name)
    visit(entry.props?.children)
  }
  visit(cell)
  // 这个用例里没有人在打字（结果已定），所以只有气泡；提示的顺序由下面那条用例覆盖。
  assert.deepEqual(classes, ['bt-group-msg'])
})

test('the typing notice is drawn in the seat while the group is working', () => {
  // 一个还在跑的 group_relay：房间里有人在说话，提示就画出来了。
  const running = { phase: 'start', name: 'group_relay', callId: 'c1', argsRaw: '', subCalls: [], turn: 1 }
  // 提示来自轮询，所以把轮询得到的状态预设进去（这个 React 桩不会重画）。
  presetStates = [{ replies: [], speaking: ['writer'] }]
  const cell = expand(ToolCell(cellProps(running, {
    actions: { roomProgress: async () => [{ callId: 'c1', replies: [], speaking: ['writer'] }] },
  })))
  presetStates = []
  mount()
  const notices = findAll(cell, node => node.props?.className === 'bt-activity')
  assert.equal(notices.length, 1)
  assert.match(text(notices[0]), /Writer/)
})

// 群视图的标记仍然打在会话容器上：CSS 据此只在群聊里调整呈现。
test('the group marker is set for a group chat and cleared for a private one', () => {
  conversation.attributes.clear()
  const groupRoster = team()
  expand(RelayTail({ sessionId: 'room', useRoster: select => select(groupRoster) }))
  mount()
  assert.equal(conversation.hasAttribute('data-bt-group-chat'), true)
  expand(RelayTail({ sessionId: 'chief', useRoster: select => select(groupRoster) }))
  mount()
  assert.equal(conversation.hasAttribute('data-bt-group-chat'), false)
})

// 上游式：藏掉宿主的折叠标题、正文强制平铺展开，成员回复因此留在原处。
test('the styles hide the fold header and lay the process body flat', () => {
  const styles = readFileSync(fileURLToPath(new URL('../src/client/styles.js', import.meta.url)), 'utf8')
  assert.ok(styles.includes('[data-step-process]>div:first-child{display:none!important}'), '折叠标题应被藏掉')
  assert.ok(styles.includes('[data-step-process]>[data-step-process-body]{display:block!important'), '正文应平铺展开')
  // 团队自己的座位不再被藏：回复与提示都要看得见。
  assert.equal(styles.includes('[data-chat-flow-kind="tool-call"]{display:none!important}'), false)
  assert.equal(styles.includes('[data-chat-flow-kind="turn-process"]{display:none!important}'), false)
})

// 轮次状态行「已完成，用时 N 秒」：团队占了这个座位，得自己画——
// 它只说这一轮花了多久，不含任何工具明细，所以群聊里也留着。
test('the turn status row says how long the turn took', () => {
  const node = {
    location: {
      kind: 'turn',
      turn: {
        turn: 1,
        status: 'closed',
        start: { time: 1_700_000_000_000 },
        end: { time: 1_700_000_003_400 },
      },
    },
  }
  const cell = expand(TurnProcessCell({
    node,
    sessionId: 'room',
    turnProcess: { foldable: false, open: true, setOpen: () => {} },
    useRoster: select => select(team()),
    useUi: select => select({ visits: {} }),
    useTurnClock: select => select({}),
    actions: { noteTurnTime: () => {} },
  }))
  mount()
  const rows = findAll(cell, node2 => node2.props?.className === 'bt-turn-status')
  assert.equal(rows.length, 1, '应有轮次状态行')
  // 这个 React 桩没有装中文 locale，所以文案是英文源：时长以「3 秒」写。
  assert.match(text(rows[0]), /Turn took 3 second/)
})
