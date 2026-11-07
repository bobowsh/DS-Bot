// The usage line under the input: the host's own readings, our own row.
//
// The figures come from the host's projections: its session statistics (turns, steps, the
// rate it measured) and its token usage. The rate follows the host's own count of output
// tokens over the writing time, so the two interfaces never disagree about the same session.
// A figure the host does not have is left out rather than shown as an empty slot.
import { createElement as h, useMemo } from 'react'
import { t } from './i18n.js'

/** The host's rate: output tokens over the time the model wrote them. */
const decodeSpeed = stats => {
  if (stats === undefined || stats === null) return undefined
  if (!(stats.decodeMs > 0) || !(stats.decodeTokens > 0)) return undefined
  const tps = stats.decodeTokens / (stats.decodeMs / 1000)
  const text = tps >= 100 ? String(Math.round(tps)) : tps.toFixed(1)
  return `${text} tok/s`
}

/** A count in the host's own short form (K for thousands, M for millions). */
const shortCount = value => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}K`
  return String(value)
}

/** The share of the context the session fills, when the host knows it. */
const contextShare = usage => {
  const total = (usage.uncachedInputTokens ?? 0) + (usage.cachedInputTokens ?? 0) + (usage.outputTokens ?? 0)
  if (total <= 0) return undefined
  const limit = usage.contextLimit ?? usage.contextWindow ?? 0
  if (!(limit > 0)) return undefined
  return `${Math.round((total / limit) * 100)}%`
}

/**
 * The line the host's composer shows under the input: turns and steps, the rate, the
 * tokens of the context, the cache hit and the share of the context.
 */
export function UsageLine({ stats, usage }) {
  const parts = useMemo(() => {
    const left = []
    const right = []
    if (stats !== undefined && stats !== null && stats.steps !== 0) {
      left.push(t('{turns} turns, {steps} steps', { turns: stats.turns, steps: stats.steps }))
      const speed = decodeSpeed(stats)
      if (speed !== undefined) left.push(speed)
    }
    if (usage !== undefined && usage !== null) {
      const total = (usage.uncachedInputTokens ?? 0) + (usage.cachedInputTokens ?? 0) + (usage.outputTokens ?? 0)
      if (total > 0) {
        right.push(`${shortCount(total)} tok`)
        const cached = usage.cachedInputTokens ?? 0
        const uncached = usage.uncachedInputTokens ?? 0
        if (cached + uncached > 0) right.push(t('cache hit {percent}%', { percent: Math.round((cached / (cached + uncached)) * 100) }))
        const share = contextShare(usage)
        if (share !== undefined) right.push(share)
      }
    }
    return [left, right]
  }, [stats, usage])
  const [left, right] = parts
  if (left.length === 0 && right.length === 0) return null
  return h('div', { className: 'bt-usage' },
    left.length > 0 ? h('span', { className: 'bt-usage-part' }, left.join(' · ')) : null,
    right.length > 0 ? h('span', { className: 'bt-usage-part' }, right.join(' · ')) : null)
}

export const USAGE_LINE_CSS = `
.bt-usage{display:flex;align-items:center;gap:10px;margin:2px 0 4px;padding:0 10px;font-size:12px;line-height:18px;color:var(--bt-ink-2);min-width:0}
.bt-usage-part{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
`
