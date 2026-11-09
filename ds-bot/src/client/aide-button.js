// The AIDE workbench's entry, shared by the two places it belongs: the foot of our own Bot
// column and the foot of the host's sidebar (the DSH page, where the account button and the
// import button live). The button asks the workbench to open through the bridge; it does not
// go through the host's panel list, because selecting a panel there replaces the main area and
// unloads the whole session view — opening the workbench would cost a full-screen rebuild.
import { createElement as h } from 'react'
import { AideIcon } from './icons.js'
import { requestAideWorkbench } from './aide-bridge.js'
import { t } from './i18n.js'

/**
 * The button that opens the AIDE workbench.
 * @param {{ label: string, className?: string }} props
 */
export function AideButton({ label, className = 'bt-round' }) {
  return h('button', {
    type: 'button', className, 'aria-label': label, title: label,
    onClick: () => { requestAideWorkbench() },
  }, h(AideIcon))
}

/**
 * The same button, as the host's sidebar foot renders it: the slot gives the component the
 * sidebar's own state, and the button reads its label from the app's copy.
 */
export function AideFooterButton() {
  return h(AideButton, { label: t('AIDE workbench') })
}
