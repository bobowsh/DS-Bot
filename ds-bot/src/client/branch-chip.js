// The branch chip above the Bot composer: the git branch of the workspace this chat runs
// in, at the top-right corner of the input card.
//
// It is read-only. A branch that cannot be read (not a git tree, a detached head, a
// workspace the roster has no path for) shows nothing at all rather than an empty chip:
// a chip that says "no branch" is noise in every chat that is not a checkout.

import { createElement as h, useEffect, useRef, useState } from 'react'
import { call } from './api.js'
import { t } from './i18n.js'

/** How long one answer stays good for. A branch changes from a terminal, not from the app. */
const REFRESH_MS = 15_000

/**
 * The branch of a workspace.
 * @param {string | undefined} path - the workspace directory
 * @returns {string | undefined}
 */
function useBranch(path) {
  const [branch, setBranch] = useState(undefined)
  const latest = useRef(undefined)
  useEffect(() => {
    latest.current = path
    if (path === undefined || path === '') { setBranch(undefined); return undefined }
    let alive = true
    let timer
    const read = async () => {
      const next = await call('branch', { path }).then(value => value?.branch).catch(() => undefined)
      // A slow answer for the folder we have since left must not overwrite the new one.
      if (alive && latest.current === path) setBranch(next)
    }
    void read()
    // The branch can change in a terminal beside the app, and the window coming back into
    // focus is exactly when the user would expect the chip to be right again.
    const onFocus = () => { void read() }
    window.addEventListener('focus', onFocus)
    timer = setInterval(() => { void read() }, REFRESH_MS)
    return () => {
      alive = false
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [path])
  return branch
}

/**
 * The chip itself. The host draws the composer card; this sits in its trailing area, so
 * the styling lives here rather than in a slot the host owns.
 */
export function BranchChip({ sessionId, useRoster }) {
  // Both a Bot chat and a group run in a workspace; the session id decides which one.
  const path = useRoster(state => {
    const bot = state.byId?.[sessionId]
    if (bot !== undefined) return bot.workDir
    return state.roomsById?.[sessionId]?.workDir
  })
  const branch = useBranch(path)
  if (branch === undefined) return null
  return h('div', {
    className: 'bt-branch-chip',
    title: `${t('Workspace branch')}: ${branch}`,
  },
  h('span', { className: 'bt-branch-chip-icon', 'aria-hidden': 'true' }, branchGlyph()),
  h('span', { className: 'bt-branch-chip-name' }, branch))
}

/** A small branch mark, drawn inline so the chip needs no icon font. */
function branchGlyph() {
  return h('svg', { width: 10, height: 10, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
    h('path', {
      d: 'M5 4.5v7M11 4.5v2a2 2 0 0 1-2 2H7a2 2 0 0 0-2 2',
      stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round',
    }),
    h('circle', { cx: 5, cy: 3.2, r: 1.7, stroke: 'currentColor', 'stroke-width': 1.6 }),
    h('circle', { cx: 5, cy: 12.8, r: 1.7, stroke: 'currentColor', 'stroke-width': 1.6 }),
    h('circle', { cx: 11, cy: 3.2, r: 1.7, stroke: 'currentColor', 'stroke-width': 1.6 }))
}

// The host lays the composer card out as a flex row and renders `conversation.input.right`
// inside `trailing > standardControls`, at the card's end. An absolutely positioned chip is
// lifted to the card's top-right corner, where it does not push the send button.
//
// Known limit: the host renders that slot inside `standardControls`, which it hides with
// `hidden={activity}` while the input is in its activity state (dictation). The chip goes with
// it — `display:none` on an ancestor hides the whole subtree, and forcing that wrapper back
// open would un-hide the host's own controls (the model picker among them). So the chip is
// absent exactly while dictation is running, which is a deliberate trade rather than an
// oversight.
export const BRANCH_CSS = `
[data-composer-card]{position:relative!important}
.bt-branch-chip{
  position:absolute!important;
  top:-9px!important;
  right:10px!important;
  display:inline-flex!important;
  align-items:center!important;
  gap:4px!important;
  /* border-box so the 220px cap covers the padding and border too: with the default
     content-box the box measured 235px (220 + 13 padding + 2 border) and could still
     reach past the card's edge on a narrow window. */
  box-sizing:border-box!important;
  max-width:min(220px,45%)!important;
  padding:1px 7px 1px 6px!important;
  border:1px solid var(--bt-line,currentColor)!important;
  border-radius:999px!important;
  background:var(--bt-card)!important;
  color:var(--bt-ink-2,currentColor)!important;
  font:500 10px/1.5 var(--bt-font,inherit)!important;
  letter-spacing:.01em!important;
  opacity:.72!important;
  pointer-events:none!important;
  user-select:none!important;
  z-index:2!important;
}
.bt-branch-chip-icon{display:inline-flex!important;flex:none!important;opacity:.7!important}
.bt-branch-chip-name{
  overflow:hidden!important;
  text-overflow:ellipsis!important;
  white-space:nowrap!important;
  /* Ellipsis at the END, keeping the start. Branch names carry their meaning up front
     (feat/, fix/, release/): an RTL ellipsis would show the tail instead and every long
     branch would read as "...something-somewhere". */
  direction:ltr!important;
  text-align:left!important;
}
`

