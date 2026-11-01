// What the user's own DSH holds, and what the app does about it on the first start.
// The user's DSH home is read, never written: its sessions are imported into the app's own
// home, and the home itself stays where it is. The environment variable that points at it is
// removed afterwards, so a later DSH run uses its own default home again.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { userDshHome } from './import.mjs'

// The name of the variable the user's DSH home is set with, at the user and the machine level.
export const DSH_HOME_VARIABLE = 'DSH_HOME'

// The user's DSH home, as DSH reads the variable, with the app's own override for a test run.
export function userHome(env = process.env) {
  const override = env.DS_BOT_USER_DSH_HOME?.trim()
  if (override) return resolve(override)
  return userDshHome(env)
}

// The session log of a DSH session: `sessions/<workspace>/<id>/session[.vN].jsonl[.zstd]`.
// The rule is the one the import plugin uses, so both read the same files.
const SESSION_LOG = /^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$/iu

/**
 * The sessions the user's DSH home holds, with the formats their logs are in. A home that does
 * not exist, or one without sessions, holds none.
 * @param {string} [from] the DSH home; the user's own by default
 * @returns {{ from: string, sessions: number, logs: number, formats: string[] }}
 */
export function detectSessions(from = userHome()) {
  const root = join(from, 'sessions')
  const result = { from, sessions: 0, logs: 0, formats: [] }
  if (!existsSync(root)) return result
  const formats = new Set()
  let workspaces
  try {
    workspaces = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())
  } catch {
    return result
  }
  for (const workspace of workspaces) {
    let ids
    try {
      ids = readdirSync(join(root, workspace.name), { withFileTypes: true }).filter(entry => entry.isDirectory())
    } catch {
      continue
    }
    for (const id of ids) {
      let logs
      try {
        logs = readdirSync(join(root, workspace.name, id.name)).filter(name => SESSION_LOG.test(name))
      } catch {
        continue
      }
      if (logs.length === 0) continue
      result.sessions += 1
      result.logs += logs.length
      for (const log of logs) {
        // The log's own revision names the format: the v4 logs are the newer ones.
        const version = SESSION_LOG.exec(log)?.[1]
        formats.add(version === undefined ? 'dsh' : `dsh${version}`)
      }
    }
  }
  result.formats = [...formats].sort()
  return result
}

/** Whether the user's DSH home holds anything worth importing. */
export function hasSessions(from = userHome()) {
  return detectSessions(from).sessions > 0
}

/**
 * Remove the variable that points at the user's DSH home, at both levels. The machine level
 * needs administrator rights: without them the removal is skipped and reported, never fatal.
 * @param {{ read?: (name: string) => string | undefined, remove?: (name: string, level: 'user' | 'machine') => void, broadcast?: () => boolean, name?: string }} [io]
 *   read: read one value; remove: remove one value at one level; broadcast: tell the running
 *   programs that the environment changed; name: the variable to remove
 * @returns {{ removed: ('user' | 'machine')[], skipped: ('user' | 'machine')[], failed: ('user' | 'machine')[] }}
 */
export function removeDshHomeVariable(io = {}) {
  const removed = []
  const skipped = []
  const failed = []
  const name = io.name ?? DSH_HOME_VARIABLE
  for (const level of ['user', 'machine']) {
    const read = io.read ?? (level === 'user' ? defaultUserValue : defaultMachineValue)
    const remove = io.remove ?? (level === 'user' ? defaultUserRemove : defaultMachineRemove)
    let value
    try {
      value = read(name)
    } catch {
      value = undefined
    }
    if (value === undefined || value === '') continue
    try {
      remove(name, level)
      removed.push(level)
    } catch (error) {
      // The machine level without administrator rights is the expected case: it is reported,
      // not thrown, so the start goes on.
      if (level === 'machine') skipped.push(level)
      else failed.push(level)
    }
  }
  // The programs that are running now keep the old environment until they start again; the
  // broadcast is what lets them see the change right away.
  if (removed.length > 0) (io.broadcast ?? broadcastEnvironmentChange)()
  return { removed, skipped, failed }
}

/**
 * Remove the variable and say so when the machine level could not be removed. The machine level
 * needs administrator rights; without them the app goes on and the user is told what is left.
 * @param {{ show?: (options: object) => Promise<unknown>, read?: (name: string) => string | undefined, remove?: (name: string, level: 'user' | 'machine') => void }} [io]
 *   show: show the notice to the user; read and remove: as in removeDshHomeVariable
 * @returns {Promise<{ removed: ('user' | 'machine')[], skipped: ('user' | 'machine')[], failed: ('user' | 'machine')[] }>}
 */
export async function removeDshHomeVariableWithNotice(io = {}) {
  const result = removeDshHomeVariable({ read: io.read, remove: io.remove, broadcast: io.broadcast, name: io.name })
  if (result.removed.length > 0) {
    // The line the installer check reads: it says the variables are gone.
    console.log(`DeepSeek Bot: removed the ${DSH_HOME_VARIABLE} variable (${result.removed.join(', ')})`)
  }
  if (result.skipped.length === 0 && result.failed.length === 0) return result
  const show = io.show
  if (typeof show === 'function') {
    await show({
      type: 'warning',
      title: 'DeepSeek Bot',
      message: 'The system-wide DSH_HOME variable could not be removed.',
      detail: 'Removing it needs administrator rights. The variable still points DeepSeek Harness at '
        + 'your own data folder; you can remove it yourself with a right-click on "Environment Variables" '
        + 'in the system properties.',
      buttons: ['OK'],
    }).catch(() => undefined)
  }
  return result
}

// Windows reads and writes the variable through the registry.
const registryCommand = (args) => ({  command: 'reg',
  args,
  windowsHide: true,
})

function defaultUserValue(name) {
  const result = spawnSync(registryCommand(['query', 'HKCU\\Environment', '/v', name]), { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) return undefined
  const match = /REG_(?:SZ|EXPAND_SZ)\s+(\S+)/u.exec(result.stdout ?? '')
  return match?.[1]
}

function defaultMachineValue(name) {
  const result = spawnSync(registryCommand(['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', '/v', name]), { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) return undefined
  const match = /REG_(?:SZ|EXPAND_SZ)\s+(\S+)/u.exec(result.stdout ?? '')
  return match?.[1]
}

function defaultUserRemove(name) {
  const result = spawnSync(registryCommand(['delete', 'HKCU\\Environment', '/v', name, '/f']), { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(result.stderr ?? 'the variable could not be removed')
}

function defaultMachineRemove(name) {
  const result = spawnSync(registryCommand(['delete', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', '/v', name, '/f']), { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(result.stderr ?? 'the variable could not be removed')
}

// The environment of the running programs is a copy of the registry taken when they started.
// Without this broadcast a program that is already running keeps the old value until it starts
// again, so the variable would still point at the old home for everything that is open now.
const WM_SETTINGCHANGE = 0x1A
const HWND_BROADCAST = '0xffff'
const SMTO_ABORTIFHUNG = 0x0002

/**
 * Tell the running programs that the environment changed. The call is best-effort: a failure
 * only means the programs keep the old value until they start again, so it is never fatal.
 */
export function broadcastEnvironmentChange() {
  if (process.platform !== 'win32') return false
  const script = `
$signature = @'
using System;
using System.Runtime.InteropServices;
public static class DsBotEnvironmentBroadcast {
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)]
  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
}
'@
Add-Type -TypeDefinition $signature -ErrorAction SilentlyContinue
$outcome = [UIntPtr]::Zero
[void][DsBotEnvironmentBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$outcome)
`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
  return result.status === 0
}
