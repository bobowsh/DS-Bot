import { realpathSync } from 'node:fs'

// The path Windows hands the packaged app can carry 8.3 short names or junctions: the
// same exe then reads as a different path, so the single-instance lock compares unlike
// strings and every absolute path the Host builds (profile includes, plugin roots) mixes
// short and long forms. Callers relaunch on the returned path; undefined means execPath
// is already canonical (or cannot be resolved).
export function canonicalExecPath(execPath, realpath = realpathSync.native) {
  try {
    const real = realpath(execPath)
    // Windows does not care about the case of a path: the same file reads as a different string
    // in a different case, and that is not a path worth restarting for.
    const same = process.platform === 'win32'
      ? real.toLowerCase() === execPath.toLowerCase()
      : real === execPath
    return same ? undefined : real
  } catch {
    return undefined
  }
}
