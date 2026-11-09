// Every close of the team window asks what should happen, on a card in the window's page, not
// in a message box: minimize to the system tray, end the app, or leave the window as it is.
// The answer is not remembered — the next close asks again. The Electron parts are test
// doubles: no display, no DSH, no data of the user.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { before, test } from 'node:test'
import { paths, state } from './helpers/fake-electron.mjs'
import { state as hostState } from './helpers/fake-host-process.mjs'
import { answerCard, handOff, messageBoxes, startApp, trayMenu, waitFor, window, windowCards } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

before(async () => { await startApp({ later: true }) })

test('the close asks on a card in the window and hides it once the tray is chosen', async () => {
  await waitFor(() => window() !== undefined, 'open the window')
  await waitFor(() => state.tray !== undefined, 'build the tray')
  hostState.release()
  await handOff()
  const win = window()
  trayMenu()[0].click()
  await waitFor(() => win.visible === true, 'show the window')
  // The window was pushed down behind another one: the close still asks where the user looks.
  win.minimize()
  const focused = win.focused
  win.close()
  await waitFor(() => windowCards(win).length === 1, 'ask what the close should do')
  assert.equal(win.minimized, false, 'the window comes back up with its card')
  assert.ok(win.focused > focused, 'the window with the card is brought to the front')
  const card = windowCards(win)[0]
  assert.equal(card.buttons.length, 3, 'the card offers three answers')
  // The quit comes first and is the default answer; the tray answer is the second.
  assert.match(card.buttons[0], /退出|Quit/u)
  assert.match(card.buttons[1], /托盘|tray/u)
  assert.match(card.message, /window closes|关闭窗口/u)
  assert.equal(win.visible, true, 'the window stays until the answer')
  answerCard(1, win)
  await waitFor(() => win.visible === false, 'hide the window')
  assert.deepEqual(messageBoxes(), [], 'no message box')
})

test('the quit answer ends the app', async () => {
  const win = window()
  trayMenu()[0].click()
  await waitFor(() => win.visible === true, 'show the window')
  win.close()
  await waitFor(() => windowCards(win).length >= 1, 'ask what the close should do')
  answerCard(1, win)
  await waitFor(() => state.tray.destroyed === true, 'the app ends')
})

test('the next close asks again; the answer is not remembered', async () => {
  const win = window()
  trayMenu()[0].click()
  await waitFor(() => win.visible === true, 'show the window')
  win.close()
  await waitFor(() => windowCards(win).length >= 2, 'the second close asks again')
  assert.ok(windowCards(win).length >= 2, 'the question is asked on every close')
  answerCard(2, win)
})
