// #12 E 组：最小 ustar + gzip 打包器，造出 factory-update 的 readTgz 能解的 tgz。
// 与 DS-Bot-issue12/app/test/factory-update.test.mjs 的 makeArchive 同口径。
import { gzipSync } from 'node:zlib'

/** @param {{ path: string, body: Buffer }[]} files 归档内路径，一律在 package/ 下 */
export function makeArchive(files) {
  const blocks = []
  for (const file of files) {
    const header = Buffer.alloc(512)
    header.write(file.path.slice(0, 99), 0, 'utf8')
    header.write('0000644\0', 100, 'utf8')
    header.write(String(file.body.length.toString(8)).padStart(11, '0') + '\0', 124, 'utf8')
    header.write('0', 156, 'utf8')
    header.write('ustar\0', 257, 'utf8')
    header.write('00', 263, 'utf8')
    header.fill(' ', 148, 156)
    let checksum = 0
    for (const byte of header) checksum += byte
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8')
    blocks.push(header, file.body, Buffer.alloc(512 - (file.body.length % 512 || 512)))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

/** 一个插件包：package.json（带 name/version）+ 若干文件。 */
export function pluginArchive(name, version, extra = {}) {
  const files = [
    { path: 'package/package.json', body: Buffer.from(JSON.stringify({ name, version }), 'utf8') },
  ]
  for (const [path, content] of Object.entries(extra)) {
    files.push({ path: `package/${path}`, body: Buffer.from(content, 'utf8') })
  }
  return makeArchive(files)
}

/** 一个不能 gunzip 的坏包，用于解包失败断言。 */
export const brokenArchive = () => Buffer.from('not a gzip archive', 'utf8')
