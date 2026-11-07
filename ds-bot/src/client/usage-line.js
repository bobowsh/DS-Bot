// The usage line under the input: the host's own readings, our own row.
// The figures come from the host's projections (sessionStats, tokenUsage) and the rate
// follows the host's own count (output tokens over the writing time), so the two
// interfaces never disagree about the same session.
import { useMemo } from 'react'
import { t } from './i18n.js'

/** The host's rate: output tokens over the time the model wrote them. */
const decodeSpeed = (stats, lang) => {
  if (!(stats.decodeMs > 0) || !(stats.decodeTokens > 0)) return undefined
  const tps = stats.decodeTokens / (stats.decodeMs / 1000)
  const text = tps >= 100 ? String(Math.round(tps)) : tps.toFixed(1)
  return lang === 'en' ? `${text} tok/s` : `${text} tok/s`
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
 * The line the host's composer shows under the input: turns and steps, the rate,
 * the tokens of the context, the cache hit and the share of the context.
 *
 * Every figure is the host's own; a figure the host does not have is left out
 * rather than shown as an empty slot.
 */
export function UsageLine({ useProjection, useLanguage }) {
  const stats = useProjection('sessionStats')
  const usage = useProjection('tokenUsage')
  const language = useLanguage ? useLanguage() : 'en'
  const parts = useMemo(() => {
    if (stats === undefined || stats === null) return []
    const counts = stats.steps === 0 ? undefined : (language === 'en'
      ? `${stats.turns} turns, ${stats.steps} steps`
      : `${stats.turns} 轮 ${stats.steps} 步`)
    const speed = decodeSpeed(stats, language)
    const left = []
    if (counts !== undefined) left.push(counts)
    if (speed !== undefined) left.push(speed)
    const right = []
    if (usage !== undefined && usage !== null) {
      const total = (usage.uncachedInputTokens ?? 0) + (usage.cachedInputTokens ?? 0) + (usage.outputTokens ?? 0)
      if (total > 0) {
        right.push(`${shortCount(total)} tok`)
        const cached = usage.cachedInputTokens ?? 0
        const uncached = usage.uncachedInputTokens ?? 0
        if (cached + uncached > 0) right.push(`${language === 'en' ? 'cache hit' : '缓存命中'} ${Math.round((cached / (cached + uncached)) * 100)}%`)
        const share = contextShare(usage)
        if (share !== undefined) right.push(share)
      }
    }
    return [left, right]
  }, [stats, usage, language])
  const [left, right] = parts
  if (left.length === 0 && right.length === 0) return null
  return h('div', { className: 'bt-usage' },
    left.length > 0 ? h('span', { className: 'bt-usage-part' }, left.join(' · ')) : null,
    right.length > 0 ? h('span', { className: 'bt-usage-part' }, right.join(' · ')) : null)
}
