// The usage line under the input: the host's own composer statistics pills,
// drawn by us because the host's components are not exported from its package.
//
// Copied from deepseek-harness packages/client/ui-chat/src/client/chat/
// StatsPills.tsx (+ token-format.ts, stat-dialog.ts) and packages/client/
// ui-conversation/src/client/skeleton/ContextMeter.tsx (+ context-occupancy.ts),
// per AGENTS.md rule 3; the class names carry a bt- prefix instead of the
// host's CSS-module hashes. Every figure still rides the host's projections
// (sessionStats, tokenUsage, contextPressure, contextBreakdown) read from the
// session list snapshot, so the numbers never diverge from the host's own.
import { createElement as h, Fragment, memo, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as ui from '@deepseek-ai/dsh-client-ui-primitives'
import { t } from './i18n.js'

// ---------------------------------------------------------------------------
// token-format.ts

/** Compact token count: 517 / 12.2K / 517K / 1.2M. */
const formatTokens = value => {
  const scaled = candidate => candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10)
  if (value < 1000) return String(value)
  if (value < 1_000_000) return t('{value}K', { value: scaled(value / 1000) })
  return t('{value}M', { value: scaled(value / 1_000_000) })
}

/** Exact integer token count with digit grouping. */
const formatExactTokens = value => {
  const digits = String(value)
  const groups = []
  for (let end = digits.length; end > 0; end -= 3) groups.unshift(digits.slice(Math.max(0, end - 3), end))
  return groups.join(',')
}

/** Round a cache-read ratio to exact percentage units, with positive ties rounded up. */
const roundedPercentUnits = (cacheReadTokens, denominator, decimalPlaces) => {
  const unitsPerPercent = decimalPlaces === 0 ? 1 : 10
  const scale = unitsPerPercent * 100
  const doubledScale = scale * 2
  const denominatorQuotient = Math.floor(denominator / doubledScale)
  const denominatorRemainder = denominator % doubledScale
  let lower = 0
  let upper = scale
  while (lower < upper) {
    const candidate = Math.floor((lower + upper + 1) / 2)
    const factor = candidate * 2 - 1
    const threshold = factor * denominatorQuotient + Math.ceil(factor * denominatorRemainder / doubledScale)
    if (cacheReadTokens >= threshold) lower = candidate
    else upper = candidate - 1
  }
  return lower
}

const displayPercentUnits = (units, decimalPlaces) => {
  if (decimalPlaces === 0) return String(units)
  const whole = Math.floor(units / 10)
  const tenths = units % 10
  return tenths === 0 ? String(whole) : `${whole}.${tenths}`
}

/** Display-ready cache-hit share without rounding a partial hit to 100%. */
const formatCacheHitPercent = (cacheReadTokens, promptTokens, decimalPlaces = 0) => {
  if (promptTokens === 0) return null
  const missedInputTokens = promptTokens - cacheReadTokens
  if (missedInputTokens === 0) return '100'
  const roundedUnits = roundedPercentUnits(cacheReadTokens, promptTokens, decimalPlaces)
  const fullHitUnits = decimalPlaces === 0 ? 100 : 1000
  if (roundedUnits < fullHitUnits) return displayPercentUnits(roundedUnits, decimalPlaces)
  let distinguishingPlaces = 1
  let scaledDoubleGap = missedInputTokens * 200
  const denominatorTens = Math.floor(promptTokens / 10)
  while (scaledDoubleGap <= denominatorTens) {
    scaledDoubleGap *= 10
    distinguishingPlaces += 1
  }
  const denominatorOnes = promptTokens % 10
  let roundedLoss = 5
  for (let loss = 1; loss < 5; loss += 1) {
    const factor = loss * 2 + 1
    const threshold = factor * denominatorTens + Math.floor(factor * denominatorOnes / 10)
    if (scaledDoubleGap <= threshold) {
      roundedLoss = loss
      break
    }
  }
  return `99.${'9'.repeat(distinguishingPlaces - 1)}${10 - roundedLoss}`
}

/** The host's decode-throughput figure: whole tokens from ten up, one decimal below. */
const formatTokensPerSecond = tps => {
  const clamped = Math.max(0, tps)
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
}

// ---------------------------------------------------------------------------
// StatsPills.tsx

/** Sum the three disjoint prompt-side billing buckets. */
const billedInputTokens = usage => usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens

/** Display-ready cache-hit share of prompt-side input over the whole durable log. */
const cacheHitPercent = usage => formatCacheHitPercent(usage.cacheReadTokens, billedInputTokens(usage))

const exactCount = value => formatExactTokens(value)

/** One or two reading segments, visually joined by a separator glyph. */
const reading = (first, second) => {
  if (second === null) return { label: first, text: first }
  return {
    label: h(Fragment, null, first,
      h('span', { className: 'bt-stat-sep', 'aria-hidden': true }, '·'),
      second),
    text: `${first} · ${second}`,
  }
}

/** The full reading above a pill, only while an ellipsis cuts its label. */
const FULL_READING_TOOLTIP = { side: 'top', portal: true, delayMs: 200, onlyWhenClipped: true }

/** A static reading: used when the pill has no dialog rows. */
const PlainPill = ({ stat, icon, label, text }) =>
  h('span', { className: 'bt-stat-anchor', 'data-composer-stat': stat },
    h(ui.Tooltip, { label: text, ...FULL_READING_TOOLTIP, openOnClick: true },
      h('span', { className: 'bt-stat-pill' },
        icon,
        h('span', { className: 'bt-stat-label' }, label))))

/** A pill button opening its own portaled dialog. */
const DialogPill = ({ stat, icon, label, text, title, titleValue, children }) => {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  const panelRef = useRef(null)
  const pos = ui.useAnchoredPosition({ open, anchorRef: rootRef, panelRef, side: 'top', gap: 8, margin: 12 })
  ui.useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)
  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = e => { if (e.key === 'Escape') setOpen(false) }
    const onClick = e => {
      if (e.target instanceof Node
        && rootRef.current?.contains(e.target) !== true
        && panelRef.current?.contains(e.target) !== true) setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('click', onClick, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('click', onClick, true)
    }
  }, [open])
  return h('span', { ref: rootRef, className: 'bt-stat-anchor', 'data-composer-stat': stat },
    h(ui.Tooltip, { label: text, ...FULL_READING_TOOLTIP, disabled: open },
      h('button', {
        type: 'button',
        className: 'bt-stat-pill',
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        'aria-label': text,
        onClick: () => { setOpen(!open) },
      },
      icon,
      h('span', { className: 'bt-stat-label' }, label))),
    open && createPortal(
      h('div', { ref: panelRef, className: 'bt-stat-panel', role: 'dialog', 'aria-label': title, style: pos ?? { visibility: 'hidden', left: 0, top: 0 } },
        h('div', { className: 'bt-stat-title' },
          h('span', { className: 'bt-stat-titleLabel' }, icon, title),
          titleValue !== undefined && h('span', { className: 'bt-stat-titleValue' }, titleValue)),
        h('div', { className: 'bt-stat-titleRule', 'aria-hidden': true }),
        children),
      document.body))
}

/**
 * Turn and step counts with whole-session speed, opening the time and speed
 * dialog. Detailed is the only mode the Bot chat draws; its reads ride the
 * host's sessionStats projection.
 */
export const ActivityPill = memo(function ActivityPill({ stats }) {
  if (stats === undefined || stats === null || stats.steps === 0) return null
  const speed = stats.decodeMs > 0
    ? t('{tps} tok/s', { tps: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1000)) })
    : null
  const icon = h(ui.IconGaugeOutlineRegular)
  const counts = t('{turns} turns, {steps} steps', { turns: stats.turns, steps: stats.steps })
  const content = { stat: 'activity', icon, ...reading(counts, speed) }
  if (stats.llmMs <= 0 && stats.toolMs <= 0 && stats.ttftSteps <= 0 && speed === null) return h(PlainPill, content)
  const duration = ms => {
    const s = ms / 1000
    if (s < 60) return `${Math.round(s * 10) / 10}s`
    const whole = Math.round(s)
    return `${Math.floor(whole / 60)}m${whole % 60}s`
  }
  return h(DialogPill, {
    ...content,
    title: t('Session statistics'),
    titleValue: counts,
  },
  h('dl', { className: 'bt-stat-details' },
    stats.llmMs > 0 && [
      h('dt', null, t('LLM time')),
      h('dd', null, duration(stats.llmMs)),
    ],
    stats.toolMs > 0 && [
      h('dt', null, t('Tool time')),
      h('dd', null, duration(stats.toolMs)),
    ],
    stats.ttftSteps > 0 && [
      h('dt', null, t('Avg time to first token (TTFT)')),
      h('dd', null, duration(stats.ttftMs / stats.ttftSteps)),
    ],
    speed !== null && [
      h('dt', null, t('Tokens per second (TPS)')),
      h('dd', null, speed),
    ]))
})

/** Whole-log token total and cache hit. */
export const UsagePill = memo(function UsagePill({ usage }) {
  if (usage === undefined || usage === null) return null
  if (billedInputTokens(usage) === 0 && usage.outputTokens === 0) return null
  const cacheHit = cacheHitPercent(usage)
  const cacheHitText = cacheHit !== null ? t('cache hit {percent}%', { percent: cacheHit }) : null
  const icon = h(ui.IconDatabaseOutlineRegular)
  const total = billedInputTokens(usage) + usage.outputTokens
  return h(DialogPill, {
    stat: 'usage',
    icon,
    ...reading(formatTokens(total), cacheHitText),
    title: t('Token usage'),
    titleValue: exactCount(total),
  },
  h('dl', { className: 'bt-stat-details' },
    cacheHit !== null && [
      h('dt', null, t('Cache hit')),
      h('dd', null, `${cacheHit}%`),
    ],
    h('dt', null, t('Uncached input')),
    h('dd', null, exactCount(usage.uncachedInputTokens)),
    h('dt', null, t('Cached input')),
    h('dd', null, exactCount(usage.cacheReadTokens)),
    usage.cacheWriteTokens !== 0 && [
      h('dt', null, t('Cache write')),
      h('dd', null, exactCount(usage.cacheWriteTokens)),
    ],
    h('dt', null, t('Output')),
    h('dd', null, exactCount(usage.outputTokens))))
})

// ---------------------------------------------------------------------------
// ContextMeter.tsx

/** Ring geometry: 14px viewBox, 2px stroke. */
const RADIUS = 5.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/** Resolve bounded display occupancy from the pressure projection. */
const contextOccupancy = pressure => {
  const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens
  if (usedTokens === undefined || pressure?.contextWindow === undefined) return null
  return {
    percent: Math.min(100, Math.round(usedTokens / pressure.contextWindow * 100)),
    usedTokens,
    contextWindow: pressure.contextWindow,
  }
}

/**
 * The context-occupancy ring below the composer, fed by the host's
 * contextPressure projection. Renders nothing until the host knows both
 * pressure and a route capacity.
 */
export const ContextMeter = memo(function ContextMeter({ pressure, breakdown }) {
  const context = contextOccupancy(pressure)
  if (context === null) return null
  const percent = context.percent
  const reading_ = `${percent}%`
  const headBefore = t('Context used')
  const headAfter = ''
  const breakdownTotal = breakdown === undefined || breakdown === null
    ? 0
    : breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens
  const parts = breakdown === undefined || breakdown === null || breakdownTotal === 0
    ? [{ key: 'total', color: undefined, width: percent }]
    : [
        { key: 'systemTokens', color: 'bt-ctx-system', width: percent * breakdown.systemTokens / breakdownTotal },
        { key: 'toolsTokens', color: 'bt-ctx-tools', width: percent * breakdown.toolsTokens / breakdownTotal },
        { key: 'messageTokens', color: 'bt-ctx-messages', width: percent * breakdown.messageTokens / breakdownTotal },
      ]
  const segments = parts.filter(part => part.width > 0)
  return h(ContextMeterPanel, { context, percent, reading: reading_, headBefore, headAfter, segments, breakdown })
})

/** The meter with its open state; split out so the memo compares only the data. */
const ContextMeterPanel = ({ context, percent, reading: reading_, headBefore, headAfter, segments, breakdown }) => {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  const panelRef = useRef(null)
  const position = ui.useAnchoredPosition({ open, anchorRef: rootRef, panelRef, side: 'top', gap: 8, margin: 12 })
  ui.useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)
  useEffect(() => {
    if (!open) return
    const onKeyDown = e => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open])
  return h('span', { ref: rootRef, className: 'bt-ctx-root' },
    h(ui.Tooltip, { label: `${headBefore} ${reading_}`, side: 'top', delayMs: 200, disabled: open },
      h('button', {
        type: 'button',
        className: 'bt-ctx-trigger',
        'aria-label': `${headBefore} ${reading_}`,
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        onClick: () => { setOpen(!open) },
      },
      h('svg', { viewBox: '0 0 14 14', width: '14', height: '14', 'aria-hidden': true },
        h('circle', { className: 'bt-ctx-track', cx: '7', cy: '7', r: RADIUS }),
        h('circle', {
          className: 'bt-ctx-fill',
          cx: '7', cy: '7', r: RADIUS,
          strokeDasharray: `${CIRCUMFERENCE * percent / 100} ${CIRCUMFERENCE}`,
          transform: 'rotate(-90 7 7)',
        })),
      h('span', null, reading_))),
    open && createPortal(
      h('div', {
        ref: panelRef,
        className: 'bt-ctx-panel',
        style: position ?? { visibility: 'hidden', left: 0, top: 0 },
        role: 'dialog',
        'aria-label': headBefore,
      },
      h('div', { className: 'bt-ctx-header' },
        h('span', { className: 'bt-ctx-headline' }, headBefore),
        h('span', { className: 'bt-ctx-percent' }, reading_),
        h('span', { className: 'bt-ctx-headline' }, headAfter),
        h('span', { className: 'bt-ctx-figures' }, `~${formatTokens(context.usedTokens)} / ${formatTokens(context.contextWindow)}`)),
      h('div', { className: 'bt-ctx-bar' },
        segments.map(segment => h('div', {
          key: segment.key,
          className: segment.color === undefined ? 'bt-ctx-segment' : `bt-ctx-segment ${segment.color}`,
          style: { width: `${segment.width}%` },
        }))),
      breakdown !== undefined && breakdown !== null && breakdownTotal(breakdown) > 0 && h('dl', { className: 'bt-ctx-rows' },
        [
          ['systemTokens', t('System'), 'bt-ctx-system'],
          ['toolsTokens', t('Tools'), 'bt-ctx-tools'],
          ['messageTokens', t('Conversation'), 'bt-ctx-messages'],
        ].map(([key, label, color]) => h('div', { key, className: 'bt-ctx-row' },
          h('dt', null, h('span', { className: `bt-ctx-swatch ${color}`, 'aria-hidden': true }), label),
          h('dd', null, `~${formatTokens(breakdown[key])}`))))),
      document.body))
}

const breakdownTotal = breakdown => breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens

// ---------------------------------------------------------------------------

/**
 * The host composer's usage row, drawn from the host's own projections:
 * the activity pill, the token usage pill, and the context ring.
 */
export function UsageLine({ stats, usage, pressure, breakdown }) {
  return h('div', { className: 'bt-usage' },
    h(ActivityPill, { stats }),
    h(UsagePill, { usage }),
    h(ContextMeter, { pressure, breakdown }))
}

export const USAGE_LINE_CSS = `
.bt-usage{display:inline-flex;align-items:center;gap:2px;min-width:0;max-width:100%;overflow:hidden}
.bt-stat-anchor{display:inline-flex;min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}
.bt-stat-pill{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;max-width:100%;padding:1px 8px;border:none;border-radius:var(--dsw-radius-sm,4px);background:transparent;color:var(--bt-ink-3);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap}
.bt-stat-pill svg{width:14px;height:14px;flex:none}
button.bt-stat-pill{cursor:pointer}
button.bt-stat-pill[aria-expanded=true]{background:var(--bt-hover);color:var(--bt-ink-2)}
@media(hover:hover){button.bt-stat-pill:hover{background:var(--bt-hover);color:var(--bt-ink-2)}}
.bt-stat-label{min-width:0;overflow:hidden;text-overflow:ellipsis}
.bt-stat-sep{color:var(--bt-line-2);margin:0 6px}
.bt-stat-panel{position:fixed;z-index:1100;box-sizing:border-box;width:max-content;min-width:min(300px,calc(100vw - 24px));max-width:min(440px,calc(100vw - 24px));padding:16px;border:0;border-radius:10px;background:var(--bt-card);box-shadow:var(--bt-glass-shadow);font-size:12px;line-height:18px;color:var(--bt-ink-2);cursor:default}
.bt-stat-title{display:flex;justify-content:space-between;gap:16px;margin-bottom:8px;color:var(--bt-ink);font-weight:500}
.bt-stat-titleRule{margin-bottom:10px;border-top:.5px solid var(--bt-line)}
.bt-stat-titleValue{font-variant-numeric:tabular-nums}
.bt-stat-titleLabel{display:inline-flex;align-items:center;gap:6px;min-width:0}
.bt-stat-titleLabel svg{width:14px;height:14px;flex:none}
.bt-stat-details{display:grid;grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;color:var(--bt-ink-3)}
.bt-stat-details dt,.bt-stat-details dd{min-width:0;margin:0}
.bt-stat-details dd{color:var(--bt-ink-2);font-variant-numeric:tabular-nums;text-align:right}
.bt-ctx-root{display:inline-flex;flex:none}
.bt-ctx-trigger{display:inline-flex;align-items:center;gap:6px;flex:none;padding:1px 8px;border:none;border-radius:var(--dsw-radius-sm,4px);background:transparent;color:var(--bt-ink-3);font-family:inherit;font-size:var(--dsh-content-font-size-secondary,13px);font-variant-numeric:tabular-nums;line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));white-space:nowrap;cursor:pointer}
.bt-ctx-trigger[aria-expanded=true]{background:var(--bt-hover);color:var(--bt-ink-2)}
@media(hover:hover){.bt-ctx-trigger:hover{background:var(--bt-hover);color:var(--bt-ink-2)}}
.bt-ctx-track{fill:none;stroke:var(--bt-line-2);stroke-width:2}
.bt-ctx-fill{fill:none;stroke:var(--bt-ink-3);stroke-width:2;stroke-linecap:round}
.bt-ctx-panel{position:fixed;z-index:1100;box-sizing:border-box;width:min(264px,calc(100vw - 24px));padding:12px;border:0;border-radius:10px;background:var(--bt-card);box-shadow:var(--bt-glass-shadow);font-size:12px;line-height:20px;color:var(--bt-ink-2);cursor:default}
.bt-ctx-header{display:flex;align-items:center;gap:6px}
.bt-ctx-figures{margin-left:auto;font-weight:500;font-variant-numeric:tabular-nums;color:var(--bt-ink)}
.bt-ctx-percent{font-weight:500;color:var(--bt-ink)}
.bt-ctx-headline{color:var(--bt-ink-3)}
.bt-ctx-headline:empty{display:none}
.bt-ctx-bar{display:flex;gap:1px;margin:10px 0 12px;height:4px;border-radius:999px;background:var(--bt-hover);overflow:hidden}
.bt-ctx-segment{flex:none;min-width:2px;height:100%;border-radius:0;background:var(--meter-tint,var(--bt-ink-3))}
.bt-ctx-swatch{display:inline-block;margin-right:6px;width:8px;height:8px;border-radius:0;background:var(--meter-tint);vertical-align:baseline}
.bt-ctx-system{--meter-tint:var(--bt-ink-3)}
.bt-ctx-tools{--meter-tint:var(--bt-accent)}
.bt-ctx-messages{--meter-tint:var(--bt-accent)}
.bt-ctx-rows{margin:6px 0 0}
.bt-ctx-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:2px 0}
.bt-ctx-row dt{color:var(--bt-ink-2)}
.bt-ctx-row dd{margin:0;font-variant-numeric:tabular-nums;color:var(--bt-ink)}
`
