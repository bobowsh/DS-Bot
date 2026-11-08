// electron-builder's beforePack hook. The native modules go into the package as npm installed them
// (npmRebuild: false), so they fit only the architecture of the Node that ran npm. An app built for
// another architecture would carry them and not start, so such a build stops here.
import { Arch } from 'electron-builder'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { preparePrimaryRuntime, runtimeTarget } from './prepare-runtime.mjs'
import { prepareFactorySkills } from './factory-skills-pack.mjs'
import { prepareBundledPlugins } from './bundled-plugin.mjs'

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

export async function beforePack(context, prepare = preparePrimaryRuntime, prepareSkills = prepareFactorySkills, preparePlugins = prepareBundledPlugins) {
  const targets = []
  for (const archToNames of context.packager?.packagerOptions?.targets?.values() ?? [])
    for (const arch of archToNames.keys()) targets.push(Arch[arch])
  const problem = archProblem({ target: Arch[context.arch], platform: context.electronPlatformName, targets })
  if (problem !== undefined) throw new Error(problem)
  await prepare(officeRuntimeRequest(context))
  const appDir = context.packager.appDir ?? context.packager.projectDir
  const manifest = factoryManifest(appDir)
  // The factory skills travel as plain folders in the data tree; each slug the manifest names
  // must be in the skills source folder with its SKILL.md, or the build stops.
  await prepareSkills(appDir, manifest.skills)
  // The plugins the app carries are resolved from the factory manifest: the intranet registry
  // first, the local development folder when it cannot be reached, the build stops on neither.
  await preparePlugins(appDir, manifest.plugins)
}
