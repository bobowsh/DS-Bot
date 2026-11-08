// The bridge to the AIDE workbench plugin.
//
// dsh-aide owns the workbench; it listens for this event on the window and shows
// it. The path through the host's panel list is deliberately not taken: selecting
// a panel there replaces the main area and unloads the whole session view, so
// opening the workbench would cost a full-screen rebuild.
//
// The name is a contract with dsh-aide: both sides must use the same string. The
// test in ds-bot/test/ pins it, and dsh-aide's own copy of the listener uses it.
export const AIDE_SHOW_EVENT = 'dvw-workbench-show'

/** Ask the AIDE workbench to open. */
export function requestAideWorkbench() {
  window.dispatchEvent(new Event(AIDE_SHOW_EVENT))
}
