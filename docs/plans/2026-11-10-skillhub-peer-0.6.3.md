# skillhub-dsh 升到 0.6.3：0.6.2 与我们的宿主彻底不兼容

## 要解决什么

**技能中心装不上技能**（用户 2026-11-10 报）。现象：点「安装」没有任何反应，`D:\LinkBot\data\skillhub\operations\host.json` 的 mtime 仍停在 11-08，`main.log` 里也没有任何 SkillHub 记录——说明**安装链路根本没有开始**，不是中途失败。

## 根因（实测，不是推断）

宿主是 `@deepseek-ai/dsh@0.2.2-rc.1`、`@deepseek-ai/cordis@4.1.0`（从已装 `app.asar` 的 `package.json` 读出）。

出厂清单打的 `@astron-team/skillhub-dsh` 是 **0.6.2**，它的 peer 依赖范围：

| 依赖 | 宿主实际 | 0.6.2 要求 | 0.6.3 要求 |
|---|---|---|---|
| `@deepseek-ai/cordis` | **4.1.0** | `4.0.4 \|\| 4.0.5` ❌ | 加 `4.1.0` ✅ |
| 11 个 `@deepseek-ai/dsh-*` | **0.2.2-rc.1** | 只到 `0.2.1-rc.5` ❌ | 加 `0.2.2-rc.1` ✅ |

宿主的兼容性检查判定不兼容 → **插件被禁用、根本不加载** → 界面上看不出"安装失败"，是功能整体没启动。这解释了为什么 `host.json` 不更新、日志里没有记录。

这也和小柚子（DSH开发）独立查到的「DSH 依赖基线不匹配，插件直接禁用写入」一致。

## 怎么做

`app/factory.manifest.json` 一行：

```diff
-    { "name": "@astron-team/skillhub-dsh", "version": "0.6.2" },
+    { "name": "@astron-team/skillhub-dsh", "version": "0.6.3" },
```

内网 Gitea npm registry（`http://192.168.1.10:3000/api/packages/dshplugin/npm/`）**已有 0.6.3**，打包时的解析优先走内网，不需要联网。

## 验收标准

1. 打出的包里 `data/profiles/ds-bot/node_modules/@astron-team/skillhub-dsh/package.json` 的 version 是 **0.6.3**
2. 装机启动后，宿主不再因 peer 不兼容禁用该插件（`main.log` 里没有 skillhub 相关的 incompatible 记录）
3. 技能中心点「安装」后 `D:\LinkBot\data\skillhub\operations\host.json` 的 mtime 更新
4. 目标技能出现在 `data/skills/<slug>/`（或用「已安装」列表能看到）

## 已拍板

- 用升级插件版本解决，**不改宿主、不给插件打补丁**（符合 AGENTS.md「Build on DSH; never patch it」）。
- 不为这一个 peer 范围去 fork 第三方（0.6.3 官方已支持）。

## 开放问题

- 内网 Gitea 上的 `dshplugin/skillhub-dsh` 仓库目前是 0.6.2 的快照；0.6.3 只在 npm registry 里有。要不要把仓库也升到 0.6.3（保留完整历史）——留给后续，不阻塞本次修复。

Refs #12
