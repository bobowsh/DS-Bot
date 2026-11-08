// #12 E 组：路由表 mock fetch。最长前缀命中；未命中按断网处理。
// 断网口径：进程级死端口代理（HTTPS_PROXY=http://127.0.0.1:1），不改系统网络配置。
// 这里让任何非白名单请求直接失败，等价于死端口，但不依赖 OS 代理设置。
export const DEAD_PROXY = 'http://127.0.0.1:1'

/** 路由表 → fetch 实现。route: { prefix, body?, status?, buffer? } */
export function fakeFetch(routes) {
  return async (url) => {
    const entry = routes
      .filter(route => String(url).startsWith(route.prefix))
      .sort((a, b) => b.prefix.length - a.prefix.length)[0]
    if (entry === undefined) {
      return { ok: false, status: 0, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) }
    }
    const body = entry.body
    return {
      ok: entry.status === undefined ? true : entry.status < 400,
      status: entry.status ?? 200,
      json: async () => body,
      arrayBuffer: async () => {
        const buffer = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body ?? {}))
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
      },
    }
  }
}

/** 只放行白名单前缀，其余一律拒绝；用于「断网」场景。 */
export function offlineFetch(allow = []) {
  return async (url) => {
    const allowed = allow.some(prefix => String(url).startsWith(prefix))
    return {
      ok: false,
      status: 0,
      json: async () => ({}),
      arrayBuffer: async () => new ArrayBuffer(0),
      _offline: !allowed,
    }
  }
}
