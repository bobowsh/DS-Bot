// #12 E 组：目录文件 SHA256 指纹，比对「未变 / 已替换 / 已回滚」。
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export function fingerprint(dir) {
  const out = {}
  const walk = current => {
    let entries
    try { entries = readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) { walk(path); continue }
      try {
        out[relative(dir, path).replace(/\\/gu, '/')] = createHash('sha256').update(readFileSync(path)).digest('hex')
      } catch { /* 打不开就记为不可读 */ out[relative(dir, path).replace(/\\/gu, '/')] = '<unreadable>' }
    }
  }
  walk(dir)
  return out
}

export function sameFingerprint(a, b) {
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort()
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k])
}

/** 读一个插件目录的 package.json version，读不到返回 undefined。 */
export function installedVersion(dir) {
  try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version } catch { return undefined }
}

/** 目录是否存在且非空（用于「未卸载」断言）。 */
export function existsWithFiles(dir) {
  try { return statSync(dir).isDirectory() && readdirSync(dir).length > 0 } catch { return false }
}
