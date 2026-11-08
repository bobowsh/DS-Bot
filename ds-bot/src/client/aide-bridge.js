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

// The workbench's own root, as dsh-aide draws it. It stands in the host's main
// area, so while it is up the main area belongs to the workbench and not to the
// conversation — our own column has to step aside with it.
export const AIDE_OVERLAY_SELECTOR = '.dvw-overlay'

/** Ask the AIDE workbench to open. */
export function requestAideWorkbench() {
  window.dispatchEvent(new Event(AIDE_SHOW_EVENT))
}

/**
 * Whether the AIDE workbench is up right now.
 * @param {ParentNode} [root] - the tree to look in
 * @returns {boolean}
 */
export const aideWorkbenchOpen = (root = typeof document === 'undefined' ? undefined : document) =>
  root !== undefined && root.querySelector(AIDE_OVERLAY_SELECTOR) !== null

/**
 * Watch the workbench: `onChange` is called with whether it is up, once for the
 * state at the start and then on every change. The observer is a document-wide
 * one: the workbench mounts and unmounts wherever the host puts it, and the
 * conversation's own rows change often enough that watching a narrower tree
 * would miss it.
 * @param {(open: boolean) => void} onChange
 * @returns {() => void} the disposer
 */
export function watchAideWorkbench(onChange) {
  let last = aideWorkbenchOpen()
  onChange(last)
  if (typeof MutationObserver !== 'function' || typeof document === 'undefined') return () => {}
  const observer = new MutationObserver(() => {
    const open = aideWorkbenchOpen()
    if (open === last) return
    last = open
    onChange(open)
  })
  observer.observe(document.body, { childList: true, subtree: true })
  return () => { observer.disconnect() }
}
