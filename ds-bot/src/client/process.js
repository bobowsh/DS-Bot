// The process of a turn: the tools it called, how long each took, and how fast
// the model was writing. The host publishes all of it in the chat snapshot, so
// nothing here counts on its own — the tokens come from the provider's own
// usage report and the timings from the host's own record of the stream.
import { createElement as h, useEffect, useMemo, useState } from 'react'
import { t } from './i18n.js'
import { elapsedLabel } from './text.js'

// The rate of one assistant step's writing: the tokens the provider reported
// over the time from its first token to the end of the step. This is the output
// side only, and it is the count DSH's own chat and trajectory views use, so
// the numbers here agree with theirs.
export function outputRate(node) {
  const usage = node?.usage
  const timing = node?.timing
  if (usage === undefined || usage === null || timing === undefined) return undefined
  const tokens = usage.outputTokens
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) return undefined
  if (typeof timing.firstTokenTime !== 'number' || !Number.isFinite(timing.firstTokenTime)) return undefined
  if (typeof timing.completedTime !== 'number' || !Number.isFinite(timing.completedTime)) return undefined
  const seconds = (timing.completedTime - timing.firstTokenTime) / 1e3
  if (seconds <= 0) return undefined
  return tokens / seconds
}

// A settled step's own figures: its output tokens and its writing time.
const settledOf = step => {
  const node = step?.finalNode
  const usage = node?.usage
  const timing = node?.timing
  if (usage === undefined || usage === null || timing === undefined) return undefined
  if (typeof usage.outputTokens !== 'number' || !Number.isFinite(usage.outputTokens)) return undefined
  if (typeof timing.firstTokenTime !== 'number' || !Number.isFinite(timing.firstTokenTime)) return undefined
  if (typeof timing.completedTime !== 'number' || !Number.isFinite(timing.completedTime)) return undefined
  const span = timing.completedTime - timing.firstTokenTime
  if (span <= 0) return undefined
  return { tokens: usage.outputTokens, ms: span }
}

// The rate of a whole turn: its steps' output tokens over their writing time.
// A step still running has no final node, so it contributes nothing here; the
// live rate below covers it.
export function turnRate(steps) {
  let tokens = 0
  let ms = 0
  for (const step of steps ?? []) {
    const settled = settledOf(step)
    if (settled === undefined) continue
    tokens += settled.tokens
    ms += settled.ms
  }
  if (ms <= 0) return undefined
  return tokens / (ms / 1e3)
}

// The rate of a step that is still writing, when the provider reports its
// usage as it goes. The clock runs from the step's first visible content, the
// only start the host publishes for a step that has not settled.
export function liveRate(steps) {
  for (const step of steps ?? []) {
    if (step?.status !== 'running') continue
    const usage = step.usage
    if (usage === undefined || usage === null) continue
    const tokens = usage.outputTokens
    if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) continue
    const start = step.time
    if (typeof start !== 'number' || !Number.isFinite(start)) continue
    const seconds = (Date.now() - start) / 1e3
    if (seconds <= 0) continue
    return tokens / seconds
  }
  return undefined
}

// A turn's own token accounting: the host's per-turn figures, exact when the
// loaded evidence is complete and absent when it is not.
export function turnTokens(tail) {
  const usage = tail?.tokenUsage
  if (usage === undefined || usage === null) return undefined
  const input = (usage.uncachedInputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  const output = usage.outputTokens ?? 0
  const total = usage.totalTokens ?? input + output
  return { input, output, total }
}

// How long a turn's steps took, from the first step's start to its last end.
export function turnDuration(steps) {
  let start
  let end
  for (const step of steps ?? []) {
    const timing = step?.finalNode?.timing
    if (timing === undefined) continue
    if (typeof timing.stepStartTime === 'number' && (start === undefined || timing.stepStartTime < start)) start = timing.stepStartTime
    if (typeof timing.completedTime === 'number' && (end === undefined || timing.completedTime > end)) end = timing.completedTime
  }
  if (start === undefined || end === undefined || end <= start) return undefined
  return end - start
}

// The calls the transcript already draws on their own, as an event line or a
// card. The fold lists the rest, so no tool is shown twice.
export const FLOW_TOOLS = new Set([
  'message_bot', 'stop_bot', 'create_bot', 'update_bot', 'group_relay', 'create_group',
  'update_group', 'delete_group', 'post_to_group', 'ask_user', 'request_secret',
  'request_connector', 'mail_send', 'ask_user_question', 'show_view', 'browser_handoff',
  'computer_handoff', 'read_group_chat', 'remember', 'forget',
])

const computerCall = name => name === 'cua' || name?.startsWith('cua_driver_native__') === true

// Whether the transcript draws this call on its own.
export const inFlow = name => FLOW_TOOLS.has(name) || computerCall(name)

// One call's own state: still running, finished, or failed.
export function callState(call) {
  if (call?.kind === 'tool-result') return call.isError === true ? 'failed' : 'done'
  return 'running'
}

// How long one call took, from the call head to its result.
export function callDuration(call) {
  if (call?.kind !== 'tool-result') return undefined
  const start = call.callTime
  if (typeof start !== 'number' || !Number.isFinite(start)) return undefined
  if (typeof call.time !== 'number' || !Number.isFinite(call.time)) return undefined
  const span = call.time - start
  return span > 0 ? span : undefined
}

// The text of a call's result: what the tool said, or why it failed.
export function resultText(call) {
  if (call?.kind !== 'tool-result') return ''
  if (call.isError === true) {
    const reason = call.error?.reason ?? call.error?.code ?? call.error?.name
    return typeof reason === 'string' && reason !== '' ? reason : t('The tool call failed')
  }
  return (call.content ?? [])
    .filter(block => block?.type === 'text')
    .map(block => block.text)
    .join('\n')
}

// The arguments of a call, as the model wrote them.
export function argsText(call) {
  if (call?.kind === 'tool-result') {
    const raw = call.call?.argsRaw
    return typeof raw === 'string' ? raw : ''
  }
  const raw = call?.argsRaw
  return typeof raw === 'string' ? raw : ''
}

// The calls of one turn, in the order they were made, each with the calls a
// program made under it. A call the transcript already draws on its own is
// left out, so no tool is shown twice.
export function callsOf(nodes) {
  const calls = []
  const visit = (call, depth) => {
    if (call === undefined || call === null) return
    if (!inFlow(call.name)) calls.push({ call, depth })
    for (const child of call.subCalls ?? []) visit(child, depth + 1)
  }
  for (const node of nodes ?? []) visit(node?.root, 0)
  return calls
}

// How many calls a turn made, counting the calls a program made under it.
export function countCalls(nodes) {
  let count = 0
  const visit = call => {
    if (call === undefined || call === null) return
    count += 1
    for (const child of call.subCalls ?? []) visit(child)
  }
  for (const node of nodes ?? []) visit(node?.root)
  return count
}

// The rate a turn is written as: the number, or "unavailable" when the provider
// has not reported one. It never shows zero, which would read as "the model was
// not writing".
export function rateText(rate) {
  if (rate === undefined || rate === null) return t('Speed unavailable')
  return t('{speed} tok/s', { speed: rate.toFixed(1) })
}

// One tool call's row: its name, its state, and how long it took.
export function CallRow({ call }) {
  const state = callState(call)
  const ms = callDuration(call)
  return h('span', { className: 'bt-proc-call' },
    h('span', { className: 'bt-proc-call-name' }, call?.name ?? ''),
    h('span', { className: 'bt-proc-call-state', 'data-state': state },
      state === 'running' ? t('Running') : state === 'failed' ? t('Failed') : t('Done'),
      ms === undefined ? null : h('span', { className: 'bt-proc-call-time' }, ` · ${elapsedLabel(ms)}`)))
}

// One tool call, folded: the row, and — when it is opened — the arguments it
// ran with and what it returned.
export function CallDisclosure({ call, depth }) {
  const args = argsText(call)
  const result = resultText(call)
  return h('details', { className: 'bt-proc-callwrap', 'data-state': callState(call), 'data-depth': depth },
    h('summary', null, h(CallRow, { call })),
    h('div', { className: 'bt-proc-detail' },
      args === '' ? null : h('div', { className: 'bt-proc-block' },
        h('div', { className: 'bt-proc-label' }, t('Arguments')),
        h('pre', { className: 'bt-proc-code' }, args)),
      result === '' ? null : h('div', { className: 'bt-proc-block' },
        h('div', { className: 'bt-proc-label' }, t('Results')),
        h('pre', { className: 'bt-proc-code' }, result))))
}

// The turn's own figures: how many calls it made, how long it took, how fast
// the model wrote, and how many tokens that cost. The rate is the output side
// only, and it says so.
export function ProcessStats({ steps, tools, tail, running }) {
  const rate = useMemo(() => turnRate(steps) ?? liveRate(steps), [steps])
  const ms = useMemo(() => turnDuration(steps), [steps])
  const tokens = useMemo(() => turnTokens(tail), [tail])
  const calls = useMemo(() => countCalls(tools), [tools])
  const parts = []
  if (calls > 0) parts.push(t('{count} tool calls', { count: calls }))
  if (ms !== undefined) parts.push(elapsedLabel(ms))
  if (parts.length === 0 && rate === undefined && tokens === undefined) return null
  return h('span', { className: 'bt-proc-stats' },
    parts.length > 0 ? `${parts.join(' · ')} · ` : '',
    h('span', { className: 'bt-proc-rate', 'data-available': rate === undefined ? 'no' : 'yes' },
      `${t('Output speed')} ${rateText(rate)}`),
    tokens === undefined ? null : h('span', { className: 'bt-proc-tokens' },
      ` · ${t('Input')} ${tokens.input.toLocaleString()} · ${t('Output')} ${tokens.output.toLocaleString()} · ${t('Total')} ${tokens.total.toLocaleString()}`),
    running ? h('span', { className: 'bt-proc-live' }, ` · ${t('Running')}`) : null)
}

// Where the open state of one turn's process is kept between visits.
const openKey = (sessionId, turn) => `ds-bot:process:${sessionId}:${turn}`

const readOpen = key => {
  try {
    return globalThis.localStorage?.getItem(key) === '1'
  } catch {
    return false
  }
}

const writeOpen = (key, open) => {
  try {
    if (open) globalThis.localStorage?.setItem(key, '1')
    else globalThis.localStorage?.removeItem(key)
  } catch { /* storage unavailable */ }
}

// The whole process of one turn: the figures, and — when it is open — the
// calls it made that the transcript does not draw on their own. It starts
// closed, and stays open for the reader who opened it.
export function ProcessView({ steps, tools, tail, running, sessionId, turn }) {
  const key = sessionId === undefined || turn === undefined ? undefined : openKey(sessionId, turn)
  const [open, setOpen] = useState(() => key !== undefined && readOpen(key))
  useEffect(() => {
    if (key === undefined) return
    writeOpen(key, open)
  }, [key, open])
  const calls = useMemo(() => callsOf(tools), [tools])
  const toggle = event => {
    event.preventDefault()
    setOpen(!open)
  }
  return h('details', { className: 'bt-proc', open, onToggle: toggle },
    h('summary', null,
      h('span', { className: 'bt-proc-title' }, t('Process')),
      h(ProcessStats, { steps, tools, tail, running })),
    h('div', { className: 'bt-proc-body' },
      calls.length > 0 ? h('div', { className: 'bt-proc-calls' },
        calls.map(({ call, depth }) => h(CallDisclosure, { key: call?.callId ?? depth, call, depth }))) : null))
}
