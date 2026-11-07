import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The process of a turn: the tools it called, and how fast the model wrote.
const bundle = await build({
  stdin: {
    contents: "export { outputRate, turnRate, liveRate, turnTokens, turnDuration, callsOf, countCalls, callState, callDuration, resultText, argsText, rateText, ProcessStats, ProcessView } from './src/client/process.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const effects = []
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, Date, Intl,
  require: (name) => {
    const platform = {
      react: {
        Fragment: 'fragment',
        createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
        useContext: ctx => ctx.value, useCallback: fn => fn, useId: () => 'proc-id',
        useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
        useRef: current => ({ current }), useLayoutEffect() {}, useEffect: effect => { effects.push(effect) }, useMemo: make => make(),
      },
      'react-dom': {},
      '@deepseek-ai/dsh-client-ui-primitives': {},
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { outputRate, turnRate, liveRate, turnTokens, turnDuration, callsOf, countCalls, callState, callDuration, resultText, argsText, rateText } = module.exports

// One settled assistant step, as the host publishes it.
const step = (over = {}) => ({
  turn: 1, step: 1, status: 'settled', time: 1_000, blocks: [],
  finalNode: {
    seq: 10, turn: 1, step: 1, time: 4_000, blocks: [],
    usage: { inputTokens: 100, outputTokens: 200 },
    timing: { stepStartTime: 1_000, firstTokenTime: 1_000, completedTime: 3_000 },
  },
  ...over,
})

test('the rate of a step is its output tokens over the time it wrote them', () => {
  // 200 tokens over two seconds of writing.
  assert.equal(outputRate(step().finalNode), 100)
  // The step's start does not count: the rate is the decode side only.
  const slow = step()
  slow.finalNode.timing.stepStartTime = 0
  assert.equal(outputRate(slow.finalNode), 100)
})

test('a step with no usable figure has no rate, and never a rate of zero', () => {
  assert.equal(outputRate(undefined), undefined)
  assert.equal(outputRate({}), undefined)
  // The provider reported no usage.
  assert.equal(outputRate({ usage: undefined, timing: { firstTokenTime: 1, completedTime: 2 } }), undefined)
  // The provider reported no output tokens.
  assert.equal(outputRate({ usage: { outputTokens: undefined }, timing: { firstTokenTime: 1, completedTime: 2 } }), undefined)
  // No first token was recorded.
  assert.equal(outputRate({ usage: { outputTokens: 10 }, timing: { firstTokenTime: null, completedTime: 2 } }), undefined)
  // The step finished before its first token.
  assert.equal(outputRate({ usage: { outputTokens: 10 }, timing: { firstTokenTime: 2, completedTime: 2 } }), undefined)
})

test('the rate of a turn sums its steps', () => {
  const first = step()
  const second = step({ step: 2 })
  second.finalNode.usage.outputTokens = 100
  second.finalNode.timing.firstTokenTime = 5_000
  second.finalNode.timing.completedTime = 6_000
  // 300 tokens over three seconds of writing.
  assert.equal(turnRate([first, second]), 100)
  // A step still running has no final node, so it contributes nothing.
  assert.equal(turnRate([first, { turn: 1, step: 2, status: 'running', blocks: [] }]), 100)
  // No settled step at all: no rate.
  assert.equal(turnRate([{ turn: 1, step: 1, status: 'running', blocks: [] }]), undefined)
})

test('a step that is still writing has a rate only when the provider reports one', () => {
  const running = { turn: 1, step: 1, status: 'running', time: Date.now() - 2_000, blocks: [], usage: { outputTokens: 100 } }
  assert.equal(Math.round(liveRate([running])), 50)
  // The provider has not reported its usage yet: there is no rate to show.
  assert.equal(liveRate([{ turn: 1, step: 1, status: 'running', time: Date.now(), blocks: [] }]), undefined)
})

test('a turn\'s tokens come from the host\'s own accounting', () => {
  const tail = { tokenUsage: { uncachedInputTokens: 100, outputTokens: 200, totalTokens: 300, cacheReadTokens: 50, cacheWriteTokens: 25 } }
  // The cached input counts as input too.
  assert.deepEqual(JSON.parse(JSON.stringify(turnTokens(tail))), { input: 175, output: 200, total: 300 })
  // No complete accounting: no figures at all.
  assert.equal(turnTokens({}), undefined)
  assert.equal(turnTokens(undefined), undefined)
})

test('a turn\'s length runs from its first step to its last', () => {
  const first = step()
  const second = step({ step: 2 })
  second.finalNode.timing.stepStartTime = 2_000
  second.finalNode.timing.completedTime = 5_000
  assert.equal(turnDuration([first, second]), 4_000)
  assert.equal(turnDuration([]), undefined)
})

// A tool call, as the host publishes it: a call head, then its result.
const call = (over = {}) => ({
  kind: 'tool-result', callId: 'c1', name: 'read_file', time: 5_000, callTime: 4_000,
  call: { name: 'read_file', argsRaw: '{"path":"a.md"}' },
  content: [{ type: 'text', text: 'the file' }], isError: false, subCalls: [], ...over,
})
const running = (over = {}) => ({
  phase: 'start', callId: 'c1', name: 'read_file', time: 4_000, argsRaw: '{"path":"a.md"}', subCalls: [], ...over,
})

test('a call\'s state and its length come from the host\'s record', () => {
  assert.equal(callState(call()), 'done')
  assert.equal(callState(call({ isError: true })), 'failed')
  assert.equal(callState(running()), 'running')
  assert.equal(callDuration(call()), 1_000)
  assert.equal(callDuration(running()), undefined)
  // A result whose call head left the loaded window has no length.
  assert.equal(callDuration(call({ callTime: null })), undefined)
})

test('a call shows the arguments it ran with and what it returned', () => {
  assert.equal(argsText(call()), '{"path":"a.md"}')
  assert.equal(resultText(call()), 'the file')
  // A failed call says why.
  assert.equal(resultText(call({ isError: true, error: { code: 'ENOENT' } })), 'ENOENT')
  // A call still running has no result yet.
  assert.equal(resultText(running()), '')
})

test('the calls of a turn are in order, and a program\'s own calls count too', () => {
  const nested = call({ callId: 'c2', name: 'grep' })
  const program = call({ callId: 'p1', name: 'run_code', subCalls: [nested] })
  const nodes = [{ root: program }, { root: call({ callId: 'c3', name: 'write' }) }]
  assert.deepEqual(JSON.parse(JSON.stringify(callsOf(nodes).map(entry => [entry.call.name, entry.depth]))), [['run_code', 0], ['grep', 1], ['write', 0]])
  assert.equal(countCalls(nodes), 3)
  assert.equal(countCalls([]), 0)
})

test('a rate that is not available says so, and never shows zero', () => {
  assert.equal(rateText(12.34), '12.3 tok/s')
  assert.equal(rateText(undefined), 'Speed unavailable')
  assert.equal(rateText(null), 'Speed unavailable')
})
