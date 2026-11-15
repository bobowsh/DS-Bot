// The language servers the app ships. They are native programs (or scripts that need a node),
// so they cannot be imported like a plugin: they travel as plain files under the data
// directory's lsp/ folder and go on the Host's PATH, where an editor plugin that looks for a
// server finds them.
//
// The source is the local server folder (DS_BOT_LSP_SRC, by default <repo>/../dsh-lsp): the
// build never reaches the network for them. A server the manifest names but the folder does
// not carry stops the build, so a package never ships without the server it promises.
import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The folder inside the shipped data directory the language servers are written to. */
export const bundledLspDir = appDir => join(appDir, 'build', 'data', 'lsp')

/** The folder the language servers are taken from: the environment, else beside the repo. */
export function defaultLspSrc(appDir) {
  const fromEnv = process.env.DS_BOT_LSP_SRC?.trim()
  if (fromEnv) return fromEnv
  return join(dirname(dirname(appDir)), 'dsh-lsp')
}

/**
 * Put the language servers the manifest lists into the data directory the installer ships.
 * @param {string} appDir - the app directory
 * @param {{ name: string }[]} entries - the manifest's language server entries
 * @param {string} [lspSrc] - the local folder the servers are taken from
 */
export async function prepareLanguageServers(appDir, entries, lspSrc = defaultLspSrc(appDir)) {
  await rm(bundledLspDir(appDir), { recursive: true, force: true })
  await mkdir(bundledLspDir(appDir), { recursive: true })
  const made = []
  for (const { name } of entries) {
    const from = join(lspSrc, name)
    if (!existsSync(from)) {
      throw new Error(`The language server ${name} resolved to nothing: ${from} does not exist. The build stops instead of shipping without it.`)
    }
    const to = join(bundledLspDir(appDir), name)
    await cp(from, to, { recursive: true })
    made.push(to)
  }
  return made
}

/**
 * The language servers the factory manifest lists.
 * @param {string} appDir - the app directory
 */
export function manifestLanguageServers(appDir) {
  const manifest = JSON.parse(readFileSync(join(appDir, 'factory.manifest.json'), 'utf8'))
  return manifest.languageServers ?? []
}
