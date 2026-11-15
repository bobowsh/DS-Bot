// The bridge to the AIDE workbench plugin.
//
// dsh-aide owns the workbench, and it registers itself as a main panel under the id
// `dsh-aide` (its client.js: `PANEL_ID = "dsh-aide"`, registered into `main` and into the
// sidebar's own `sidebar.panellist`). The host's panel list opens it with
// `layout.selectPanel(id)`, and our own button reaches the same call through
// `actions.openPanel`.
//
// This used to dispatch a window event instead (`dvw-workbench-show`), on the belief that
// dsh-aide listened for one. It never did: the plugin has no such listener anywhere, and
// the button's click went nowhere. The event, and the assumed contract with it, are gone.
export const AIDE_PANEL_ID = 'dsh-aide'

// The workbench's own root, as dsh-aide draws it. It stands in the host's main
// area, so while it is up the main area belongs to the workbench and not to the
// conversation — our own column has to step aside with it.
export const AIDE_OVERLAY_SELECTOR = '.dvw-overlay'

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
