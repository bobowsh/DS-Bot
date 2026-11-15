// The DOM probe starts the real application, so it may only ever touch
// throwaway folders: it must never write into an installed app's own data, and
// never into the user's DSH home.
//
// The guard lives in its own module so a test can reach it without starting the
// application.

/**
 * The folders the probe may use, and why not.
 *
 * @param {{ home?: string, shellData?: string, userProfile?: string, dshHome?: string }} folders
 * @returns {string} the reason the probe must not start, or '' when the folders are safe
 */
export function unsafeFolders({ home, shellData, userProfile = '', dshHome = '' } = {}) {
  if (home === undefined || shellData === undefined) return 'set DS_BOT_HOME and DS_BOT_SHELL_DATA to throwaway folders'
  const lower = value => value.replace(/[\\/]+$/u, '').toLowerCase()
  if (userProfile !== '' && lower(home) === lower(userProfile)) return 'DS_BOT_HOME must not be the user profile folder'
  if (dshHome !== '' && lower(home) === lower(dshHome)) return 'DS_BOT_HOME must not be the DSH home'
  if (dshHome !== '' && lower(shellData) === lower(dshHome)) return 'DS_BOT_SHELL_DATA must not be the DSH home'
  if (lower(home) === lower(shellData)) return 'DS_BOT_HOME and DS_BOT_SHELL_DATA must be different folders'
  return ''
}
