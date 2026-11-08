// The window and the tray share one life: closing the window hides it, the tray is the way
// back to it, and the tray's Quit is the one ordinary way out. The app itself decides when
// a close really ends it: an update, a data move, a failed start and the end of the
// operating system's session all close the window for good.
import { createTray } from './tray.mjs'
import { DISPLAY_NAME } from './legacy.mjs'

export const SHELL_TEXT = {
  en: {
    tooltip: 'LinkBot',
    open: 'Open LinkBot',
    quit: 'Quit LinkBot',
    closeAsk: {
      message: 'What should happen when the window closes?',
      toTray: 'Minimize to the system tray',
      quit: 'Quit LinkBot',
      cancel: 'Cancel',
    },
    fallback: 'The system tray is not available, so LinkBot cannot stay in the background. Do you want to end it?',
    cancel: 'Cancel',
    stopAll: 'Stop all',
  },
  zh: {
    tooltip: 'LinkBot',
    open: '打开 LinkBot',
    quit: '退出 LinkBot',
    closeAsk: {
      message: '关闭窗口后要做什么？',
      toTray: '最小化到系统托盘',
      quit: '退出 LinkBot',
      cancel: '取消',
    },
    fallback: '系统托盘不可用，LinkBot 不能留在后台。要结束它吗？',
    cancel: '取消',
    stopAll: '全部停止',
  },
}

/**
 * The window and the tray of the desktop app.
 *
 * @param {{
 *   electron: { app: any, Menu: any, Tray: any, powerMonitor: any },
 *   platform: string,
 *   messages: () => { tooltip: string, open: string, quit: string, closeAsk: { message: string, toTray: string, quit: string, cancel: string }, fallback: string, cancel: string },
 *   trayImage: () => any,
 *   window: () => any,
 *   build: () => any,
 *   reveal: (window: any) => void,
 *   quit: () => void,
 *   busy: () => boolean,
 *   ready: () => boolean,
 *   closeAsk: { show: (options: object) => Promise<{ response: number }> },
 *   fallback?: { show: (options: object) => Promise<{ response: number }> },
 *   log?: Pick<Console, 'warn'>,
 * }} options the pieces of the app the shell drives
 */
export function createShell(options) {
  const { electron, platform, log = console } = options
  const { app, powerMonitor } = electron
  // The tray is kept here, so that it stays alive as long as the app runs.
  let tray
  // The app is on its way out: the window may close for good.
  let quitting = false
  // A quit was asked for; the app may still refuse it (a first-run dialog, a copy).
  let quitAsked = false
  let sessionEnding = false
  // The windows the shell has hidden: they do not show themselves again.
  const hidden = new WeakSet()
  // The hides that wait for a fullscreen window to leave fullscreen.
  const pending = new WeakMap()

  const text = () => options.messages()
  const current = () => options.window()

  const hide = (target = current()) => {
    if (quitting || sessionEnding || target === undefined || target.isDestroyed()) return
    hidden.add(target)
    if (platform === 'darwin' && target.isFullScreen()) {
      // A fullscreen window leaves an empty black space behind when it is hidden.
      const onLeave = () => {
        pending.delete(target)
        if (quitting || sessionEnding || target.isDestroyed()) return
        // The window was opened again while it was leaving fullscreen: it stays.
        if (!hidden.has(target)) return
        target.hide()
      }
      pending.set(target, onLeave)
      target.once('leave-full-screen', onLeave)
      target.setFullScreen(false)
      return
    }
    target.hide()
  }

  /** The window is there: show it. It is gone: build one that talks to the running Host. */
  const open = () => {
    if (quitting) return
    const target = current()
    if (target !== undefined && !target.isDestroyed()) {
      if (target.isMinimized()) target.restore()
      // A hide that waits for the fullscreen to end is called off: the window stays.
      const waiting = pending.get(target)
      if (waiting !== undefined) {
        pending.delete(target)
        target.removeListener?.('leave-full-screen', waiting)
      }
      hidden.delete(target)
      options.reveal(target)
      return
    }
    // There is no window yet, and the app is still starting: nothing to show.
    if (!options.ready()) return
    const built = options.build()
    if (built !== undefined && !built.isDestroyed()) {
      hidden.delete(built)
      options.reveal(built)
    }
  }

  /**
   * The tray's Quit: the one ordinary way out of the app. The app may still refuse it (a
   * first-run dialog is open, a copy is under way); then it says so with {@link cancelQuit}.
   */
  const quit = () => {
    if (quitAsked) return
    quitAsked = true
    options.quit()
  }

  /** The app is on its way out; the window may close for good. */
  function beginQuit() { quitting = true; quitAsked = true }

  /** The app refused the quit: it goes on, and the tray works again. */
  function cancelQuit() { quitting = false; quitAsked = false }

  const buildTray = () => {
    try {
      const image = options.trayImage()
      tray = createTray({
        Tray: electron.Tray, Menu: electron.Menu, platform,
        image, tooltip: text().tooltip,
        open: { label: text().open, run: () => { open() } },
        quit: { label: text().quit, run: () => { quit() } },
        computer: { onAction: (kind, botId) => { options.computer?.(kind, botId) }, stopAll: () => text().stopAll },
        log,
      })
    } catch (error) {
      // Without a tray the window stays where the user can reach it; the app never vanishes.
      tray = undefined
      log.warn(`LinkBot: the system tray is not available: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Without a tray there is no Quit of its own: the close asks whether the app should end.
   * @param {any} target the window that stays reachable
   */
  const askFallback = async (target) => {
    const t = text()
    try {
      const { response } = await options.fallback.show({
        type: 'question', title: DISPLAY_NAME, message: t.fallback,
        buttons: [t.quit, t.cancel], defaultId: 1, cancelId: 1, noLink: true,
      })
      if (response === 0) { quit(); return }
    } catch (error) {
      log.warn(`LinkBot: the fallback quit could not be asked: ${error instanceof Error ? error.message : String(error)}`)
    }
    // The window stays in the task bar, where the user can reach it.
    target.minimize()
  }

  /**
   * The window's close: with a tray it asks every time what the close should do — minimize to
   * the tray, end the app, or nothing. Without one it asks whether the app should end.
   * @param {{ preventDefault: () => void }} event the window's close event
   */
  const close = (event) => {
    if (quitting || sessionEnding) return
    event.preventDefault()
    const target = current()
    if (target === undefined) return
    // An import or a data move is under way: the close cancels it, as it did before.
    if (options.busy()) { quit(); return }
    // Without a tray there is no way back to a hidden window, and no Quit of its own: the
    // close asks whether the app should end.
    if (tray === undefined) { void askFallback(target); return }
    void askClose(target)
  }

  /**
   * The close question, asked on every window close: minimize to the tray, end the app, or
   * leave the window as it is. The quit goes through the tray's own quit, so a first-run
   * dialog or a running copy can still refuse it.
   * @param {any} target the window the question is about
   */
  const askClose = async (target) => {
    const t = text().closeAsk
    try {
      const { response } = await options.closeAsk.show({
        type: 'question', title: DISPLAY_NAME, message: t.message,
        buttons: [t.toTray, t.quit, t.cancel], defaultId: 0, cancelId: 2, noLink: true,
      })
      if (response === 0) { hide(target); return }
      if (response === 1) { quit(); return }
    } catch (error) {
      log.warn(`LinkBot: the close question could not be asked: ${error instanceof Error ? error.message : String(error)}`)
    }
    // A cancelled or failed question leaves the window where it is.
  }

  /** The window's own listeners. */
  const watch = (target) => {
    target.on('close', (event) => { close(event) })
    if (platform === 'win32') {
      // The session ends for good: the window may close.
      target.on('session-end', () => { sessionEnding = true })
    } else {
      // A shutdown that another application called off leaves the app running; the next focus
      // or show of the window says that the session goes on.
      target.on('focus', () => { sessionEnding = false })
      target.on('show', () => { sessionEnding = false })
    }
  }

  const install = () => {
    // The app stays in the tray: a closed window is not a closed app.
    app.on('window-all-closed', () => {})
    // macOS: the Dock icon opens the window again.
    app.on('activate', () => { sessionEnding = false; open() })
    if (platform !== 'win32') {
      // macOS and Linux: the power-off notification comes before the terminate request, and
      // another application can still call the shutdown off.
      powerMonitor.on('shutdown', () => { sessionEnding = true })
    }
    buildTray()
  }

  const dispose = () => {
    tray?.dispose()
    tray = undefined
  }

  return {
    install,
    watch,
    close,
    open,
    quit,
    beginQuit,
    cancelQuit,
    dispose,
    /** The same computer-use entries the floating indicator carries. */
    setComputer: entries => { tray?.setComputer(entries) },
    hasTray: () => tray !== undefined,
    isQuitting: () => quitting,
    isHidden: (target) => hidden.has(target),
    isSessionEnding: () => sessionEnding,
  }
}
