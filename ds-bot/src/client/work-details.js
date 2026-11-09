// The work details of the host's own chat: how much of a turn's process shows.
//
// The host owns the setting in its own `ui-chat` settings namespace, and the chat
// follows the host's policy. The setting row in DS Bot's own settings writes the
// host's field, so the row and the chat never disagree.
//
// Nothing is written on startup. Earlier builds wrote a default mode on every
// start, and that write is what made a choice in the settings page impossible to
// keep: the user picked one, and the next start wrote the default over it. A
// profile that never chose a mode now opens on the host's own default, and a
// choice the user made stays.
//
// The team's own preferences hold the choice as well, as a second place it is
// written to. It is what a start reads to restore the mode when the host's own
// layer did not keep it.

// The host's own modes (`dsh-client-ui-chat`'s `TranscriptViewMode`).
export const WORK_DETAILS = [
  ['compact', 'Compact'],
  ['standard', 'Standard'],
  ['detailed', 'Detailed'],
  ['verbose', 'Verbose'],
]

// The modes the host accepts.
export const WORK_DETAILS_MODES = WORK_DETAILS.map(([mode]) => mode)

/**
 * Whether a value is one of the host's work-details modes.
 * @param {unknown} value
 * @returns {boolean}
 */
export const isWorkDetailsMode = value => typeof value === 'string' && WORK_DETAILS_MODES.includes(value)

/**
 * Whether the mode shows a settled thought's first line beside its title. The
 * host's own policy decides this (`settledReasoningPreview`): compact folds the
 * thought away, the other three show it.
 * @param {string} mode
 * @returns {boolean}
 */
export const reasoningShown = mode => mode === 'standard' || mode === 'detailed' || mode === 'verbose'

/**
 * Whether a settled thought shows beside its answer.
 *
 * The work-details mode is the default: only the compact mode folds a settled
 * thought away. The user's own switch wins over the mode when they have made one,
 * so the thought can be shown or hidden whatever the mode says.
 * @param {{ thinking?: boolean }} [prefs] - the team's preferences
 * @param {string} [mode] - the work-details mode
 * @returns {boolean}
 */
export const thinkingShown = (prefs, mode) => {
  if (typeof prefs?.thinking === 'boolean') return prefs.thinking
  return reasoningShown(mode)
}

/**
 * The mode to write into the host when the team starts.
 *
 * Nothing is written when the team has no mode of its own: the host's own value is
 * then the user's, and writing ours over it would throw that choice away. This is
 * the whole fix for a choice that never survived a restart — the earlier builds
 * wrote a default on every start, and every later choice was overwritten by it.
 * @param {string | undefined} saved - the mode the team saved
 * @param {string | undefined} hostMode - the mode the host carries now
 * @returns {string | undefined} the mode to write, or `undefined` when nothing is written
 */
export function workDetailsToApply(saved, hostMode) {
  if (!isWorkDetailsMode(saved)) return undefined
  return saved === hostMode ? undefined : saved
}

/**
 * What a change in the host's own settings means for the team's saved mode.
 *
 * The host's value is the user's choice, so a change in it becomes the team's mode
 * too. The very first reading after a start is not a change: it is whatever the
 * host carries, and the team keeps no mode of its own until the user makes one.
 * @param {string | undefined} hostMode - the mode the host carries now
 * @param {string | undefined} saved - the mode the team saved
 * @returns {string | undefined} the mode to save, or `undefined` to keep what is saved
 */
export function workDetailsToSave(hostMode, saved) {
  if (!isWorkDetailsMode(hostMode)) return undefined
  if (hostMode === saved) return undefined
  return hostMode
}
