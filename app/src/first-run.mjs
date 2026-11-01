// The first start: where the app keeps its data and the Bots' files. The answers are kept in the
// app's own data. The team itself comes from the factory seed (src/factory.mjs puts it under the
// data location; ds-bot builds it at startup), so no team is copied or asked about here.
import { app, dialog } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { userDshHome, within } from './import.mjs'
import { installFolder } from './move-data.mjs'

const TEXT = {
  en: {
    welcome: 'Welcome to LinkBot',
    places: (data, workspace) => `Data: ${data}\nTeam workspace: ${workspace}`,
    start: 'Start', change: 'Change…',
    pickData: 'Folder for LinkBot data', pickWorkspace: 'Folder for the team workspace',
    dataInWorkspace: 'The data folder cannot be inside the team workspace.',
    workspaceInData: 'The team workspace cannot be inside the data folder.',
    inDsh: home => `Choose a folder outside the DeepSeek Harness data (${home}).`,
    inProgram: 'Choose a folder outside the program folder: uninstalling removes it.',
    pickMove: 'New folder for LinkBot data',
    moveDrive: 'Choose a folder, not a whole drive.',
    moveNested: 'Choose a folder outside the current data folder.',
    moveWorkspace: 'The data folder and the team workspace cannot hold each other.',
    moveNotEmpty: 'Choose an empty folder or a new one.',
    moveConfirm: to => `Move LinkBot's data to ${to}?`,
    moveDetail: from => `LinkBot copies its data there and starts again. ${from} stays as it is; you can delete it once everything works.`,
    move: 'Move and restart', cancel: 'Cancel',
    moving: 'Copying LinkBot\'s data…',
    starting: 'Starting LinkBot…',
    moveInUse: 'Another DeepSeek Harness is using this data, so it was not moved. Close it, then try again.',
    moveFailed: message => `The data could not be copied: ${message}\n\nLinkBot goes on with its data where it was.`,
    notStarted: 'LinkBot could not start.',
  },
  zh: {
    welcome: '欢迎使用 LinkBot',
    places: (data, workspace) => `数据：${data}\n总工作区：${workspace}`,
    start: '开始使用', change: '更改位置…',
    pickData: '选择 LinkBot 的数据文件夹', pickWorkspace: '选择总工作区的文件夹',
    dataInWorkspace: '数据文件夹不能放在总工作区里面。',
    workspaceInData: '总工作区不能放在数据文件夹里面。',
    inDsh: home => `请选择 DeepSeek Harness 数据（${home}）以外的文件夹。`,
    inProgram: '请选择程序文件夹以外的位置：卸载时会删掉程序文件夹。',
    pickMove: '选择 LinkBot 数据的新文件夹',
    moveDrive: '请选择一个文件夹，不要选整个磁盘。',
    moveNested: '请选择现在的数据文件夹以外的位置。',
    moveWorkspace: '数据文件夹和总工作区不能互相包含。',
    moveNotEmpty: '请选择一个空文件夹，或者新建一个。',
    moveConfirm: to => `把 LinkBot 的数据移到 ${to} 吗？`,
    moveDetail: from => `LinkBot 会把数据复制过去，然后重新启动。${from} 会原样保留，确认一切正常后可以自己删掉。`,
    move: '移动并重启', cancel: '取消',
    moving: '正在复制 LinkBot 的数据…',
    starting: '正在启动 LinkBot…',
    moveInUse: '另一个 DeepSeek Harness 正在使用这份数据，所以没有移动。请先关掉它，再重试。',
    moveFailed: message => `数据没有复制成功：${message}\n\nLinkBot 会继续使用原来位置的数据。`,
    notStarted: 'LinkBot 没能启动。',
  },
}
export const localeText = table => (app.getLocale().toLowerCase().startsWith('zh') ? table.zh : table.en)
export const text = () => localeText(TEXT)

const locationsFile = () => join(app.getPath('userData'), 'locations.json')

// A quit request while a first-run dialog is open stops the first run right after that dialog.
class Quit extends Error {}

async function ask(options, signal) {
  const { response } = await dialog.showMessageBox({ title: 'LinkBot', noLink: true, ...options, signal })
  // A quit that arrived while a synchronous macOS box was open gets to run first.
  await new Promise(resolve => setImmediate(resolve))
  if (signal.aborted) throw new Quit()
  return response
}

async function pick(title, current, signal) {
  const { canceled, filePaths } = await dialog.showOpenDialog({ title, defaultPath: existsSync(current) ? current : dirname(current), properties: ['openDirectory', 'createDirectory', 'promptToCreate'] })
  await new Promise(resolve => setImmediate(resolve))
  if (signal.aborted) throw new Quit()
  return canceled ? current : filePaths[0]
}

export const programFolder = () => installFolder(app.getPath('exe'))

// The Windows install keeps its data beside the program folder, so the uninstaller leaves it
// alone: an install at <root>\app puts <root>\data and <root>\workspace. Nothing is hardcoded,
// and the first run finds the places preset instead of asking. Other platforms keep the first
// start's own picking: on macOS the program folder is the .app bundle, whose sealed contents
// the data must not enter. A parent that is a drive root, or missing, is not fixed either.
function fixedPlaces() {
  if (!app.isPackaged || process.platform !== 'win32') return undefined
  const program = programFolder()
  const root = dirname(program)
  if (root === program || root === dirname(root)) return undefined
  return { dataDir: join(root, 'data'), workspace: join(root, 'workspace') }
}

function placeProblem(t, dataDir, workspace) {
  const dsh = userDshHome()
  const program = programFolder()
  if (within(dataDir, workspace)) return t.dataInWorkspace
  if (within(workspace, dataDir)) return t.workspaceInData
  for (const path of [dataDir, workspace]) {
    if (within(path, dsh) || within(dsh, path)) return t.inDsh(dsh)
    if (app.isPackaged && within(path, program)) return t.inProgram
  }
  return undefined
}

/** Write the chosen places once the first run is finished; quitting before that asks again. */
export function saveLocations({ dataDir, workspace }) {
  const file = locationsFile()
  mkdirSync(dirname(file), { recursive: true })
  // A write that fails half way leaves the places that were there.
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ dataDir, workspace }, null, 2)}\n`)
  renameSync(`${file}.tmp`, file)
}

/**
 * Where the app keeps its data and the Bots' files, asked at the first start.
 * A run on throwaway folders (DS_BOT_HOME, for development and tests) asks nothing.
 * @returns {Promise<{ dataDir: string, workspace?: string, quit?: true, firstRun?: boolean }>}
 */
export async function chooseLocations(signal) {
  if (process.env.DS_BOT_HOME) return { dataDir: process.env.DS_BOT_HOME, workspace: process.env.DS_BOT_WORKSPACE || undefined }
  const file = locationsFile()
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    // The places were preset by an earlier start or moved in the Settings.
    return { dataDir: saved.dataDir, workspace: saved.workspace }
  }
  const t = text()
  // A packaged Windows install fixes the folders beside the program folder and asks nothing;
  // elsewhere the first start still picks, and placeProblem() checks the picks.
  const preset = fixedPlaces()
  let dataDir = preset?.dataDir ?? join(homedir(), '.ds-bot')
  let workspace = preset?.workspace ?? join(homedir(), 'LinkBot')
  try {
    if (preset === undefined) {
      for (;;) {
        const choice = await ask({ type: 'info', message: t.welcome, detail: t.places(dataDir, workspace), buttons: [t.start, t.change, t.quit], defaultId: 0, cancelId: 2 }, signal)
        if (choice === 2) return { quit: true }
        if (choice === 1) {
          dataDir = await pick(t.pickData, dataDir, signal)
          workspace = await pick(t.pickWorkspace, workspace, signal)
          continue
        }
        const problem = placeProblem(t, dataDir, workspace)
        if (problem === undefined) break
        await ask({ type: 'warning', message: problem, buttons: ['OK'] }, signal)
      }
    } else {
      // The fixed folders may not exist yet on a fresh install: make them before the Host runs.
      mkdirSync(dataDir, { recursive: true })
      mkdirSync(workspace, { recursive: true })
    }
  } catch (error) {
    if (error instanceof Quit) return { quit: true }
    throw error
  }
  saveLocations({ dataDir, workspace })
  // The first start: the app has no place of its own yet, so this is the one start that may
  // bring in the sessions of a DSH the user already has.
  return { dataDir, workspace, firstRun: true }
}
