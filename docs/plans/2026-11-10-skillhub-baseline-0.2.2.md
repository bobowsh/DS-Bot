# 技能装不上：宿主依赖基线不匹配

## 结论（2026-11-11 最终）

**不需要改第三方插件源码。** 用官方 `@astron-team/skillhub-dsh@0.6.3` 即可，
它本来就支持本机宿主。

官方 0.6.3 的源码（上游 tag `dsh-v0.6.3`）：

```ts
export const supportedDshVersions = ['0.2.0-rc.2', '0.2.1-rc.2', '0.2.1-rc.5', '0.2.2-rc.1'] as const;

export const cordisFamilies = [
  { '@deepseek-ai/cordis': '4.0.4', '@deepseek-ai/cordis-plugin-loader': '1.0.5', ... },
  { '@deepseek-ai/cordis': '4.0.5', '@deepseek-ai/cordis-plugin-loader': '1.0.6', ... },
  { '@deepseek-ai/cordis': '4.1.0', '@deepseek-ai/cordis-plugin-loader': '1.1.0',
    '@deepseek-ai/cordis-plugin-include': '1.1.0', '@deepseek-ai/cordis-plugin-timer': '1.2.0' },
] as const;

export function supportsCordis(release: string, version: string): boolean {
  if (release === '0.2.2-rc.1') return version === '4.1.0';
  ...
}
```

本机宿主正是 `dsh 0.2.2-rc.1` 配 `cordis 4.1.0`，
`supportsCordis('0.2.2-rc.1', '4.1.0')` 返回 `true`，写入门禁放行。

## 本机宿主的实际版本

从已安装 `D:\LinkBot\app\resources\app.asar` 解包后读出：

| 依赖 | 版本 |
|---|---|
| `@deepseek-ai/dsh` / `dsh-app-boot` | `0.2.2-rc.1` |
| `@deepseek-ai/dsh-fs` / `dsh-home-paths` / `dsh-sandbox` / `dsh-sandbox-policy` / `dsh-session` / `dsh-session-query` / `dsh-skill-filesystem` / `dsh-tools` / `dsh-typert-protocol` | `0.2.2-rc.1` |
| `@deepseek-ai/cordis` | `4.1.0` |
| `@deepseek-ai/cordis-plugin-loader` | `1.1.0` |
| `@deepseek-ai/cordis-plugin-include` | `1.1.0` |
| `@deepseek-ai/cordis-plugin-timer` | `1.2.0` |

11 个 Client 模块（`dsh-api-gateway`、`dsh-client-ui-layout` 等）的版本也全是 `0.2.2-rc.1`。

## 根因

出厂清单打的是 `skillhub-dsh@0.6.2`，它的 peer 只到 `dsh 0.2.1-rc.5` 与 `cordis 4.0.5`，
不含本机宿主版本。宿主判定不兼容，插件不加载，安装链路一次都没开始：

- `data\skillhub\operations\host.json` 的 mtime 停在 **11-08**（一次写操作都没有）
- `main.log` 里没有任何 SkillHub 记录

服务端本身完全正常，五个端点全 200：

```
GET /api/v1/skills                              -> 200  2939B
GET /api/v1/skills/global/ub-mode                -> 200
GET /api/v1/skills/global/ub-mode/versions       -> 200
GET .../resolve                                  -> 200
GET .../download?version=20261108.022844         -> 200  2745B
```

## 修法

1. `app/factory.manifest.json`：`@astron-team/skillhub-dsh` 由 `0.6.2` 改为 `0.6.3`（PR #39）。
2. 内网 npm registry 提供**官方原版** `0.6.3`（shasum `8a238ad3…`，与 npm 官方一致），打包时从内网拉取。

## 验收标准

- [x] 内网 registry 的 `0.6.3` 与 npm 官方逐字节一致（SHA256 `1679cca3…`，`lib/index.js` 266,983 字节）
- [x] 用户 profile 里的插件是官方 0.6.3（`supportsCordis` 存在、`matchCordisFamily` 不存在、无调试标记）
- [x] 内网 fork 仓库 `dshplugin/skillhub-dsh` 的 main 已还原为官方 `dsh-v0.6.3` 源码（提交 `3074622`）
- [ ] **重打 0.3.2 包后装机**：技能中心点安装，`data\skillhub\operations\host.json` mtime 更新、`data\skills\` 出现新技能目录

最后一条是真正的落地验收，尚未做。

## 边界与教训

- **不改第三方插件源码**（AGENTS.md 硬规矩）。第三方插件的问题，先看官方版本是否已修。
- **不覆盖官方版本号**。此前把改过的插件用官方版本号 `0.6.3` 发到内网 registry，
  等于篡改版本号，装上去的包不是官方那个。改动的插件应使用自己的版本号。
- 判定「宿主不兼容」时，先分别确认两层：**peer 范围**（装不装得上）与
  **插件内部的基线校验**（装得上之后能不能写）。本例两层都要看清。

## 相关

- 上游 tag：`dsh-v0.6.3`（`https://github.com/iflytek/skillhub`）
- 内网 fork：`dshplugin/skillhub-dsh`（main 已在 `3074622` 还原为官方 0.6.3 源码）
- 交接清单：`docs/handover-2026-11-11.md`
