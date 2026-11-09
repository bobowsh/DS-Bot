// The factory skills that the SkillHub knows about: the plugin judges "installed" by the
// metadata it keeps beside a skill (.skillhub/metadata.json), so a skill that ships with the
// app needs that file to be recognized. The metadata names the version the SkillHub published,
// so it is read from there — a file written from a guess would make the plugin offer an update
// that does not exist.
//
// A skill the SkillHub does not hold (it was never published, or the intranet cannot be reached)
// gets no metadata: the plugin then shows it as not installed, which is the truth.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** The registry the factory skills are published to. */
export const SKILLHUB_REGISTRY = process.env.SKILLHUB_REGISTRY?.trim() || 'http://192.168.1.10:8081'

/** The namespace the factory skills are published under. */
export const SKILLHUB_NAMESPACE = process.env.SKILLHUB_NAMESPACE?.trim() || 'global'

/**
 * The skills the registry holds, with their versions.
 * @param {string} registry - the registry root
 * @param {typeof fetch} [fetchImpl] - the fetch to use
 * @returns {Promise<Map<string, string>>} slug -> version
 */
export async function publishedSkills(registry = SKILLHUB_REGISTRY, fetchImpl = globalThis.fetch) {
  const published = new Map()
  try {
    const response = await fetchImpl(`${registry}/api/v1/skills`, { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) return published
    const body = await response.json()
    for (const item of body.data?.items ?? body.items ?? []) {
      if (typeof item?.slug === 'string' && typeof item?.version === 'string') published.set(item.slug, item.version)
    }
  } catch {
    // A registry that cannot be reached means no skill is known to be published.
  }
  return published
}

/**
 * The metadata file the SkillHub plugin reads for a skill.
 * @param {{ slug: string, version: string, registry: string, namespace: string }} entry
 */
export function skillhubMetadata({ slug, version, registry, namespace }) {
  return `${JSON.stringify({
    registry,
    namespace,
    slug,
    version,
    source: 'skillhub',
    schemaVersion: 1,
  }, undefined, 2)}\n`
}

/**
 * Write the metadata beside the skills the registry holds, so the plugin recognizes them as
 * installed. A skill the registry does not hold is left alone.
 * @param {string} skillsDir - the folder the skills live in
 * @param {Map<string, string>} published - slug -> version
 * @param {{ registry?: string, namespace?: string }} [options]
 * @returns {Promise<string[]>} the slugs that got metadata
 */
export async function writeSkillhubMetadata(skillsDir, published, { registry = SKILLHUB_REGISTRY, namespace = SKILLHUB_NAMESPACE } = {}) {
  const marked = []
  for (const [slug, version] of published) {
    const dir = join(skillsDir, slug)
    if (!existsSync(join(dir, 'SKILL.md'))) continue
    await mkdir(join(dir, '.skillhub'), { recursive: true })
    await writeFile(join(dir, '.skillhub', 'metadata.json'), skillhubMetadata({ slug, version, registry, namespace }), 'utf8')
    marked.push(slug)
  }
  return marked
}
