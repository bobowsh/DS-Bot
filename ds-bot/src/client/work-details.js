// The work details of the host's own chat: how much of a turn's process shows.
// The host owns the setting (its `ui-chat` settings namespace), so DS Bot reads
// and writes that one field, and the chat follows the host's own policy.

// The host's own modes (`dsh-client-ui-chat`'s `TranscriptViewMode`).
export const WORK_DETAILS = [
  ['compact', 'Compact'],
  ['standard', 'Standard'],
  ['detailed', 'Detailed'],
  ['verbose', 'Verbose'],
]

// The mode a profile that never chose one opens on.
//
// The team wants the standard amount of a turn's process: enough to see what the
// Bots ran, without the fully expanded rows. A mode the user picked is never
// overwritten — this only fills in a profile that has none.
export const DEFAULT_WORK_DETAILS = 'standard'

// Whether the mode shows a settled thought's first line beside its title. The
// host's own policy decides this (`settledReasoningPreview`): compact folds the
// thought away, the other three show it.
export const reasoningShown = mode => mode === 'standard' || mode === 'detailed' || mode === 'verbose'
