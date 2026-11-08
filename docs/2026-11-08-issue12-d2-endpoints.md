# #12 · D2 端点兼容实测报告

- 目标服务：内网 iflytek SkillHub `http://192.168.1.10:8081`（`GET /v3/api-docs` → 200，`SkillHub API 0.1.0-beta.7`，208 个路径）
- 官方源码：`github.com/iflytek/skillhub` 的 `cli/`，Apache-2.0
- 实测脚本（临时、可复跑）：`E:\dsbot-work\tmp\issue12-d2-probe.mjs`、`issue12-d2-m4.mjs`、`issue12-d1-openapi.mjs`、`issue12-file-endpoint.mjs`
- 结论口径：只看真实状态码与响应体，不把推断当事实

## 一、验收第一条：4 个平铺端点的实测（对象别搞混）

**口径纠正**：这 4 个平铺路径是 #12 原文「验收第一条（全案唯一风险点）」里
**官方 iflytek SkillHub 插件的预期协议**（担心开源版与腾讯 hosted 版协议有出入），
**不是** `pn1024/dsh-skill-market` 的端点。`dsh-skill-market` 在 issue 原文里早已拍板
「**仅作兜底参考，不入清单**」——它该不该进清单不需要再讨论。

| 平铺路径（插件原版预期） | 实测 | 说明 |
|---|---|---|
| `GET /api/skills` | **401** Authentication required | 匿名不可读 |
| `POST /api/v1/skills/batch` | **401** Authentication required | 匿名不可写 |
| `GET /api/v1/skills/{slug}/file` | **400** `Namespace not found: {slug}` | 把 slug 当成 namespace |
| `GET /api/v1/download?slug=` | **302 → `/api/v1/skills/global/{slug}/download` → 200** `application/zip` | 这条通；非法 slug 时 400 |

根因是**路径结构对不上**：平铺路径不带 namespace 段，内网这台是
`/api/v1/skills/{namespace}/{slug}/...`，响应统一包 `{code,msg,data}`。
issue 预判「开源版协议与腾讯 hosted 版不同」是对的。

**验收第一条的答案**：我们出厂的 fork 版 `skillhub-dsh`（`@astron-team/skillhub-dsh`，
`registryUrl` 指向 8081）说的就是**带 namespace 的开源版契约**，下面第二节逐个端点实测全通，
**不需要再 fork 改字段映射**。

## 二、`skillhub-dsh` 说的契约（本机实测全通）

| 端点 | 实测 | 响应形状 |
|---|---|---|
| `GET /api/v1/skills` | 200 | `{items:[{slug,displayName,...,latestVersion}],nextCursor}`，**不带** `{data}` 包裹 |
| `GET /api/cli/v1/skills/search?q=mermaid&limit=5` | 200 | `{code,msg,data:{items:[{namespace,slug,latestVersion,summary}],total,limit}}` |
| `GET /api/web/skills?q=&page=0&size=12&sort=newest` | 200 | `{code,msg,data:{items:[...],total,page,size}}` |
| `GET /api/cli/v1/skills/global/pretty-mermaid/resolve` | 200 | `{data:{namespace,slug,version,versionId,fingerprint,downloadUrl}}` |
| `GET /api/v1/skills/global/pretty-mermaid` | 200 | `{data:{id,slug,displayName,ownerId,...}}` |
| `GET /api/v1/skills/global/pretty-mermaid/versions?page=0&size=5` | 200 | `{data:{items:[{version,status,changelog,publishedAt,downloadAvailable}],...}}` |
| `GET /api/web/labels` | 200 | `{data:[]}` |
| `GET .../versions/{version}/file?path=SKILL.md` | 200 | `application/octet-stream`，SKILL.md 正文 |

`skillhub-dsh` 的 `RegistryAdapter.json()` 用 `z.object({data: schema}).parse()` 解析
（fork 源码 `E:\dsbot-work\gitea-mirror\skillhub-dsh\src\host\registry-adapter.ts` 的 L201-208），
所以除列表接口外，带 `{data}` 包裹的路径与它完全对得上；`documentation()` 走
`.../versions/{version}/file?path=SKILL.md`（同文件 L156-161），**带 namespace + version 两段**。

## 三、file 端点的复查（路径形状，不是端点坏）

一度测到 `GET /api/v1/skills/global/grilling/file?path=SKILL.md`（**无 version 段**）异常，
怀疑端点坏。复查结果（同一技能 `grilling`，真实 version `20261108.022746`）：

| 路径 | 实测 | 说明 |
|---|---|---|
| `.../global/grilling/file?path=SKILL.md`（**无 version 段**） | **401** Authentication required | 本次是 401 不是 500；匿名被拒，服务端状态有波动，但都不可用 |
| `.../global/grilling/versions/20261108.022746/file?path=SKILL.md` | **200** `application/octet-stream` / 1987 B | 内容即 `--- name: grilling ...` 的 SKILL.md |
| `.../api/web/skills/global/grilling/versions/{v}/file?path=SKILL.md` | **200** / 1987 B | 同上 |
| `.../global/grilling/download` | **200** `application/zip` / 1061 B | zip 内含 `SKILL.md` |
| `.../versions/{v}/download` | **200** `application/zip` / 1061 B | 同上 |
| `GET /api/cli/v1/skills/global/grilling/resolve` | 200 | `{data:{version,downloadUrl,...}}` |

**结论：file 端点没坏，是路径少带了 version 段。** 正确形状必须是
`/api/v1/skills/{namespace}/{slug}/versions/{version}/file?path=SKILL.md`。
因此：
- **C5（技能更新比对文件）** 仍可走 `resolve → documentation(version)`，或 `download` 解 zip；
  两者都可用，不必被迫改设计。
- **D1** 发布前预检用的是本地 `SKILL.md` frontmatter 校验，不依赖这个端点。
- B2 否决结论不变。

## 四、D1 发布契约（供复跑）

- 登录：`POST /api/v1/auth/local/login` → 200，返回 `{data:{userId,displayName,platformRoles:["SUPER_ADMIN"]}}`，
  并下放 `SESSION` / `XSRF-TOKEN` cookie；**不返回 Bearer token**。
- 官方 CLI 用 `Authorization: Bearer <token>`（device flow 或 `--token`/`SKILLHUB_TOKEN`），
  token 由用户在 Web `http://192.168.1.10:3001` 生成。
- 发布：`POST /api/cli/v1/skills/{namespace}/publish/validate`（`--dry-run`）→
  `POST /api/cli/v1/skills/{namespace}/publish`，multipart `file`(zip) + `visibility`(大写)。
- 限流：publish 接口级，连发返回 `{"ok":false,"message":"Rate limit exceeded"}`，
  无 `Retry-After` 头；`GET /api/v1/skills` 不受影响。只补发服务端缺失的 slug，退避 20s 以上。
- 判断发布结果用全量 `GET /api/v1/skills` 的 `items[].slug`；
  `?page=1&limit=3` 会返回空列表（分页参数与清单不一致），不能据此判定。

## 五、D1 实测结果

`login` → `publish --dry-run`（4/4 `valid:true`）→ `publish`（2/4 成功，2 个撞限流）
→ 退避补齐 4/4 → `GET /api/v1/skills` 复核含 `dsh-profile-plugin-ops / grilling / review-skill / ub-mode`。
可复跑脚本：`app/scripts/import-skills.mjs`；离线 CLI 与操作技能：`E:\dsbot-work\skillhub-cli\`。
