// The factory seed: the resources the installer ships with are put under the data location
// on first launch, so a fresh install opens on a ready-made Bot team. ds-bot reads the team
// from <dataDir>/factory/factory-team.json (src/host/factory-seed.js). The factory skills and
// plugins travel inside the data tree itself (data/skills/, data/profiles/), so the installer
// or the first start puts them in place without any network use; the seed below is the only
// resource that is version-checked and copied on first launch.
import { cp, mkdir } from 'node:fs/promises'
import * as nodeFs from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const seedFile = dataDir => join(dataDir, 'factory', 'factory-team.json')

/** The version a factory seed declares, or undefined when there is none to read. */
function seedVersion(path) {
  try {
    const version = JSON.parse(nodeFs.readFileSync(path, 'utf8'))?.version
    return version === undefined || version === null ? undefined : String(version)
  } catch {
    return undefined
  }
}

/** Whether `candidate` is a newer seed version than `installed`. Plain numbers compare as numbers. */
function newerSeed(candidate, installed) {
  if (installed === undefined) return true
  const a = Number(candidate)
  const b = Number(installed)
  if (Number.isFinite(a) && Number.isFinite(b)) return a > b
  return String(candidate) > String(installed)
}

export async function installFactoryResources({ dataDir, resourcesDir, signal }) {
  const result = { seedCopied: false }
  const bundledSeed = join(resourcesDir, 'factory', 'factory-team.json')
  // A seed that ships a newer version replaces the one already installed: an upgrade must be able
  // to renew the factory team. The copy is skipped while the versions match, so a seed the user
  // edited in place is left alone, and one that carries a version ahead of the installer's keeps
  // winning. ds-bot refreshes the seeded Bots when this version moves (src/host/factory-seed.js).
  if (existsSync(bundledSeed) && newerSeed(seedVersion(bundledSeed), existsSync(seedFile(dataDir)) ? seedVersion(seedFile(dataDir)) : undefined)) {
    await mkdir(join(dataDir, 'factory'), { recursive: true, signal })
    await cp(bundledSeed, seedFile(dataDir), signal)
    result.seedCopied = true
  }
  return result
}
