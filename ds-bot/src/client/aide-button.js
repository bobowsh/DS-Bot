// The AIDE workbench's entry, shared by the two places it belongs: the foot of our own Bot
// column and the foot of the host's sidebar (the DSH page, where the account button and the
// import button live).
//
// It opens the workbench the way the host's own panel list does — selecting the main panel
// dsh-aide registers — rather than dispatching a window event, which dsh-aide never listened
// for. Selecting a panel replaces the main area; that is what opening the workbench means, and
// it is what the host's own row costs too.
import { createElement as h } from 'react'
import { AideIcon } from './icons.js'
import { AIDE_PANEL_ID } from './aide-bridge.js'
import { t } from './i18n.js'

/**
 * The button that opens the AIDE workbench.
 * @param {{ label: string, className?: string, actions?: { openPanel?: (id: string) => boolean } }} props
 */
export function AideButton({ label, className = 'bt-round', actions }) {
  return h('button', {
    type: 'button', className, 'aria-label': label, title: label,
    onClick: () => { actions?.openPanel?.(AIDE_PANEL_ID) },
  }, h(AideIcon))
}

/**
 * The same button, as the host's sidebar foot renders it: the slot gives the component the
 * sidebar's own state, and the button reads its label from the app's copy.
 * @param {{ actions?: object }} [props]
 */
export function AideFooterButton(props) {
  return h(AideButton, { label: t('AIDE workbench'), actions: props?.actions })
}
