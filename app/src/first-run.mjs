// The first start: where the app keeps its data and the Bots' files (the default places, or the
// one folder picked from the start page), and whether it copies the Bot team of the user's own
// DSH. The answers are kept in the app's own data.
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { findTeam, userDshHome } from './import.mjs'
import { installFolder } from './move-data.mjs'
import { freeSpace, canWrite } from './place.mjs'
import { langOf, t } from './start/text.mjs'

// The app's picker and the cards in the team window speak the language of the start page
// (main.mjs gives it the same locale).
export const lang = () => langOf(app.getLocale())
export const tx = (key, vars) => t(lang(), key, vars)

const locationsFile = () => join(app.getPath('userData'), 'locations.json')

const PICKER_LABELS = ['places', 'drives', 'home', 'desktop', 'documents', 'downloads', 'path', 'go', 'up', 'newFolder', 'newName', 'create', 'name', 'cancel', 'chooseFolder', 'open', 'save', 'replace', 'loading']
const PICKER_LINES = ['empty', 'noFolders', 'more']
const PICKER_ERRORS = ['missing', 'drive', 'denied', 'notFolder', 'notFile', 'tooLong', 'unreadable', 'name', 'exists', 'isFolder', 'replace']

/** The words of the app's picker (preload.cjs showPicker), which has no text of its own. */
export function pickerLabels() {
  return Object.fromEntries([
    ...PICKER_LABELS.map(key => [key, tx(`picker.${key}`)]),
    ...PICKER_LINES.map(key => [key, tx(`dialog.picker.${key}`)]),
    ...PICKER_ERRORS.map(key => [`error.${key}`, tx(`dialog.picker.${key}`)]),
  ])
}

// A quit request while the picker is open stops the first run right after it.
class Quit extends Error {}

async function pick(title, from, signal, ui) {
  const picked = await ui.asking(ui.pick({ mode: 'folder', title, start: existsSync(from) ? from : dirname(from) }))
  await new Promise(resolve => setImmediate(resolve))
  if (signal.aborted) throw new Quit()
  return picked ?? undefined
}

export const programFolder = () => installFolder(app.getPath('exe'))

/**
 * The places a packaged Windows install uses: its data and its team workspace sit beside the
 * program folder, so the uninstaller leaves the data alone and the first run finds them
 * without asking. An install at <root>\app puts <root>\data and <root>\workspace.
 *
 * Nothing is hardcoded: the places follow wherever the program was put. A parent that is a
 * drive root, or missing, is not fixed either — there is nowhere beside it to put them. A
 * parent that cannot be written (an install under Program Files, for instance) is not fixed
 * either, because the data could never be made there.
 *
 * @returns {{ dataDir: string, workspace: string } | undefined} the fixed places, or none
 */
export function fixedPlaces() {
  if (!app.isPackaged || process.platform !== 'win32') return undefined
  const program = programFolder()
  const root = dirname(program)
  if (root === program || root === dirname(root)) return undefined
  if (!canWrite(root)) {
    console.warn(`LinkBot: ${root} cannot be written, the data goes to the default place instead`)
    return undefined
  }
  return { dataDir: join(root, 'data'), workspace: join(root, 'workspace') }
}

/**
 * The places the app starts on when it has not been told otherwise: the program in
 * D:\LinkBot\app, its data in D:\LinkBot\data and its team's files in D:\LinkBot\workspace.
 *
 * The program folder and the data folder are one folder apart on purpose: the uninstaller
 * leaves the data alone, and the first run finds its places without asking. The drive is
 * D when the machine has one and E otherwise; the user's own folders under the profile
 * are not used, so the app's data never ends up on the system drive by accident.
 *
 * @returns {{ dataDir: string, workspace: string }} the places to start on
 */
export function defaultPlaces() {
  const root = driveRoot()
  return { dataDir: join(root, 'LinkBot', 'data'), workspace: join(root, 'LinkBot', 'workspace') }
}

/**
 * The drive the app's folders go on: D when the machine has one, E otherwise, and the
 * user's own profile folder when neither is there.
 *
 * The drive is found with a wildcard: "D:\" and "D:\." both fail, because a backslash at
 * the end of the string is an escape and the path never resolves.
 *
 * @returns {string} the folder the app's own folders are made under
 */
function driveRoot() {
  for (const drive of ['D:', 'E:']) {
    if (existsSync(`${drive}\\`)) return drive
  }
  return homedir()
}

/**
 * The picker of 「换个位置…」 on the start page: one folder, from which the root rule
 * (place.mjs) makes the places. Undefined when the picker was cancelled or the app is quitting.
 * @param {string} from the folder the picker opens in
 */
export async function pickRoot(from, signal, ui) {
  try {
    return await pick(tx('dialog.pickRoot'), from, signal, ui)
  } catch (error) {
    if (error instanceof Quit) return undefined
    throw error
  }
}

/** The Bot team in a data folder, if it has one. */
export function teamIn(dataDir) {
  try {
    return findTeam(dataDir)
  } catch {
    return undefined
  }
}

/**
 * What the start window can say before the first-run questions: the team that a reinstall keeps,
 * or whether the user's own DSH has a team to offer.
 */
export function teamsAt(dataDir = defaultPlaces().dataDir) {
  const team = teamIn(dataDir)
  return { team, offered: team === undefined && teamIn(userDshHome()) !== undefined }
}

/**
 * The team that the user's own DSH offers to a data folder without one, if any. The start page
 * asks about it on the import card (import-flow.mjs).
 * @returns {ReturnType<typeof findTeam>}
 */
function offerOf(dataDir) {
  try {
    return teamIn(dataDir) === undefined ? findTeam(userDshHome()) : undefined
  } catch (error) {
    console.error(error)
    return undefined
  }
}

/**
 * Write the chosen places once the first run is finished; quitting before that asks again. The
 * free space of the data's drive when the data goes to a folder is kept as long as it stays
 * there: a later start shows the place line again once a fifth of it is left (start-window §5).
 */
export function saveLocations({ dataDir, workspace }) {
  const file = locationsFile()
  mkdirSync(dirname(file), { recursive: true })
  const saved = readSaved(file)
  const kept = saved !== undefined && typeof saved.dataDir === 'string' && resolve(saved.dataDir) === resolve(dataDir) && roomOf(saved.freeAtStart) !== undefined
  // A full drive gives no room to measure a fifth of: the next save measures again.
  const freeAtStart = kept ? saved.freeAtStart : roomOf(freeSpace(dataDir))
  // A write that fails half way leaves the places that were there.
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ dataDir, workspace, freeAtStart }, null, 2)}\n`)
  renameSync(`${file}.tmp`, file)
}

const roomOf = bytes => (Number.isFinite(bytes) && bytes > 0 ? bytes : undefined)

function readSaved(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Where the app keeps its data and the Bots' files: the program's own folder decides it.
 *
 * A packaged install puts its data beside the program folder (D:\LinkBot\app -> D:\LinkBot\data);
 * anywhere else the default place is used. A place saved from an earlier start is **not** read: the
 * data follows the program, so an install that moved decides where its data lives. The consequence
 * is that 「换个位置」 no longer sticks across restarts — the user chose this over keeping the
 * saved place, which would leave an install that moved pointing at a folder it no longer owns.
 *
 * Nothing is made or written here: the start window asks for the kind of start before the boot
 * has done anything, and it only needs to know where the data would be.
 *
 * @returns {{ dataDir: string, workspace: string }}
 */
export function placesFor() {
  return fixedPlaces() ?? defaultPlaces()
}

/**
 * Where the app keeps its data and the Bots' files.
 *
 * The places follow the program: a packaged install puts its data beside the program folder
 * (D:\LinkBot\app -> D:\LinkBot\data), and anywhere else the default place is used. A place
 * saved from an earlier start is **not** read: the data follows the program, so an install that
 * moved decides where its data lives. The consequence is that 「换个位置」 no longer sticks
 * across restarts — the user chose this over keeping the saved place, which would leave an
 * install that moved pointing at a folder it no longer owns.
 *
 * A run on throwaway folders (DS_BOT_HOME, for development and tests) asks nothing and copies
 * nothing. `freeAtStart` is the free space of the data's drive that saveLocations() kept, none
 * when it kept none yet.
 * @returns {{ dataDir: string, workspace?: string, freeAtStart?: number, offer?: NonNullable<ReturnType<typeof findTeam>> }}
 */
export function chooseLocations() {
  if (process.env.DS_BOT_HOME) return { dataDir: process.env.DS_BOT_HOME, workspace: process.env.DS_BOT_WORKSPACE || undefined }
  const { dataDir, workspace } = placesFor()
  // The folders the places name are made right away: the data folder is written to
  // whatever the start does next, and the workspace with it.
  makePlaces(dataDir, workspace)
  const offer = offerOf(dataDir)
  // A first start with a team to offer waits for the answer: the place the user picks on the
  // card is the one that is saved, so nothing is written before that. Every other start has its
  // place already, and writes it so that the free space of the drive is measured while it goes on.
  if (offer === undefined) saveLocations({ dataDir, workspace })
  if (offer !== undefined) return { dataDir, workspace, offer }
  return { dataDir, workspace }
}

/**
 * The folders the places name, made so that the first run finds them there. A folder that
 * cannot be made is left to the start that writes into it: the app says so when it fails.
 * @param {string} dataDir - where the data goes
 * @param {string} [workspace] - where the team's files go
 */
function makePlaces(dataDir, workspace) {
  for (const dir of [dataDir, workspace]) {
    if (dir === undefined) continue
    try {
      mkdirSync(dir, { recursive: true })
    } catch (error) {
      console.error(`LinkBot: the folder ${dir} was not made: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
