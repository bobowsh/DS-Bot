// electron-builder's beforePack hook. The native modules go into the package as npm installed them
// (npmRebuild: false), so they fit only the architecture of the Node that ran npm. An app built for
// another architecture would carry them and not start, so such a build stops here.
import { Arch } from 'electron-builder'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { preparePrimaryRuntime, runtimeTarget } from './prepare-runtime.mjs'
import { prepareFactorySkills } from './factory-skills-pack.mjs'
import { prepareBundledPlugins, packDataArchive } from './bundled-plugin.mjs'
import { prepareLanguageServers } from './factory-lsp-pack.mjs'
import { patchForPack } from './fs-writebytes-patch.mjs'

const WHERE = {
  darwin: { x64: 'on an Intel Mac, or under Rosetta with an x64 Node', arm64: 'on a Mac with Apple silicon' },
}

/** @returns {string | undefined} why this Node cannot build an app for `target` */
export function archProblem({ target, platform, host = process.arch, targets = [] }) {
  // electron-builder packs a universal app one architecture at a time: the hook only sees the
  // inner x64/arm64 builds, so a universal request is known from the requested targets.
  if (target === 'universal' || targets.includes('universal')) return 'A universal app would need the native modules of both architectures. Build one app per architecture.'
  if (target === host) return undefined
  const where = WHERE[platform]?.[target] ?? `with an ${target} Node`
  return `This Node runs on ${host}, so npm installed ${host} native modules, and an ${target} app with them would not start. Install the dependencies and build ${where}.`
}

/**
 * The Office payload the package ships next to the asar through extraResources; it must
 * match the package's own platform and architecture, which the arch check guarantees.
 * @param {*} context - electron-builder's beforePack context.
 * @returns {{ target: string, output: string, cache: string, version: string }}
 */
export function officeRuntimeRequest(context) {
  const target = runtimeTarget(context.electronPlatformName, Arch[context.arch])
  if (target === undefined) throw new Error(`No Office runtime payload for ${context.electronPlatformName} ${Arch[context.arch]}.`)
  // The context's packager is the PlatformPackager; the app directory lives on its Packager
  // (.info), exposed directly as projectDir. For this one-package app they are the same.
  const appDir = context.packager.appDir ?? context.packager.projectDir
  return {
    target,
    output: join(appDir, 'build', 'runtime'),
    cache: process.env.DS_BOT_RUNTIME_CACHE ?? join(appDir, 'build', 'runtime-cache'),
    version: context.packager?.appInfo?.version
      ?? JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
  }
}

/**
 * The factory manifest: the list of plugins and skills the build carries, kept by people in
 * app/factory.manifest.json. Every entry carries the version the package must ship.
 * @param {string} appDir - the app directory
 */
export function factoryManifest(appDir) {
  return JSON.parse(readFileSync(join(appDir, 'factory.manifest.json'), 'utf8'))
}

export async function beforePack(context, prepare = preparePrimaryRuntime, prepareSkills = prepareFactorySkills, preparePlugins = prepareBundledPlugins, prepareServers = prepareLanguageServers, packData = packDataArchive, patchFs = patchForPack) {
  const targets = []
  for (const archToNames of context.packager?.packagerOptions?.targets?.values() ?? [])
    for (const arch of archToNames.keys()) targets.push(Arch[arch])
  const problem = archProblem({ target: Arch[context.arch], platform: context.electronPlatformName, targets })
  if (problem !== undefined) throw new Error(problem)
  const appDir = context.packager.appDir ?? context.packager.projectDir
  // The byte channel the shadow write/edit needs has to be in the Host before anything ships.
  // Patching first means a moved anchor stops the build before the Office runtime is downloaded,
  // rather than after a slow pack that then carries an unpatched Host.
  patchFs(appDir)
  await prepare(officeRuntimeRequest(context))
  const manifest = factoryManifest(appDir)
  // The factory skills travel as plain folders in the data tree; each slug the manifest names
  // must be in the skills source folder with its SKILL.md, or the build stops.
  await prepareSkills(appDir, manifest.skills)
  // The plugins the app carries are resolved from the factory manifest. Each one is pulled at the
  // newest version its registry publishes, unless that version is older than the manifest's or
  // declares itself incompatible with this app's DSH; those ship at the pinned version instead
  // and the reason is logged. The plugins the manifest marks as shipped turned off travel as
  // well, but the first start keeps them out of the bundle list.
  const packed = await preparePlugins(appDir, manifest.plugins, undefined, manifest.disabledByDefault ?? [])
  // What went out, in one line: the build log has to answer "which plugin versions does this
  // package carry", and which of them the registry moved past what the manifest pinned.
  const shipped = factoryManifest(appDir).plugins ?? []
  const newer = (manifest.plugins ?? []).filter((entry, at) => shipped[at]?.name === entry.name && shipped[at].version !== entry.version)
  console.log(`LinkHarness: the package carries ${Array.isArray(packed) ? packed.length : shipped.length} factory plugins; ${newer.length} were pulled newer than the manifest pinned${newer.length === 0 ? '' : ` (${newer.map(entry => `${entry.name}@${entry.version}`).join(', ')})`}`)
  // The language servers travel as plain files too: they are native programs, so they go on
  // the Host's PATH rather than into a plugin.
  await prepareServers(appDir, manifest.languageServers ?? [])
  // Every part of the data tree is written by now, so it leaves the build as one archive. Packing
  // here and not inside preparePlugins is deliberate: the skills and the language servers are
  // written after the plugins, and an archive made earlier would miss them.
  await packData(appDir)
}
