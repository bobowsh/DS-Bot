// The factory plugins' runtime assets: some packages are not bundled into lib — the code
// locates real files inside them at runtime (`require.resolve("X/package.json")` for a font,
// an icon theme, Monaco's build tree, the pdf worker). A plugin that promises such assets in
// factory.assets.json must carry them in its own node_modules, or the packaged app breaks in
// ways no build-time test catches. Run after a pack: it fails loudly, naming what is missing.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const appDir = process.argv[2] ?? join(import.meta.dirname, '..')

/** The packaged data tree: build/data when run before packing, dist-pack/win-unpacked/data after. */
export function dataTree(appDir) {
  const unpacked = join(appDir, 'dist-pack', 'win-unpacked', 'data')
  if (existsSync(join(unpacked, 'profiles'))) return unpacked
  return join(appDir, 'build', 'data')
}

/**
 * Check every plugin that declares runtime assets against the packaged tree.
 * @param {string} appDir - the app directory
 * @param {object} [assets] - the declaration, read from factory.assets.json by default
 * @param {string} [dataDir] - the packaged data tree, worked out from appDir by default
 * @returns {{ ok: boolean, checked: number, missing: { plugin: string, asset: string }[] }}
 */
export function checkRuntimeAssets(appDir, assets = JSON.parse(readFileSync(join(appDir, 'factory.assets.json'), 'utf8')), dataDir = dataTree(appDir)) {
  const missing = []
  let checked = 0
  for (const [name, { runtimeAssets }] of Object.entries(assets.plugins ?? {})) {
    const nodeModules = join(dataDir, 'profiles', 'ds-bot', 'node_modules', ...name.split('/'), 'node_modules')
    for (const asset of runtimeAssets ?? []) {
      checked++
      if (!existsSync(join(nodeModules, ...asset.split('/'), 'package.json'))) {
        missing.push({ plugin: name, asset })
      }
    }
  }
  return { ok: missing.length === 0, checked, missing }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === import.meta.filename) {
  const result = checkRuntimeAssets(appDir)
  if (result.ok) {
    console.log(`LinkHarness: all ${result.checked} runtime assets are in place`)
  } else {
    for (const { plugin, asset } of result.missing) {
      console.error(`LinkHarness: the factory plugin ${plugin} is missing its runtime asset ${asset}`)
    }
    process.exit(1)
  }
}
