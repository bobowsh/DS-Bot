# issue #2 方案：出厂插件与 skills 走 data 目录（明文目录，不做 tgz）

分支：`feat/issue-2-data-packaging`（基于 dev-me `ab54422e`）

## 一、目标布局

**构建时**（暂存，extraFiles 的源）：
```
app/dist-pack/data/
  plugins/<name>/          明文目录（插件本体 + 其依赖 node_modules）
  skills-repo/             git 仓库（.git 在内）
```

**安装后**（`<安装根>\data`，即 (a) 的活动数据目录）：
```
<安装根>\data\plugins\<name>\
<安装根>\data\skills-repo\
```

## 二、机制

electron-builder 的 `extraFiles` 落在 `$INSTDIR` 下（安装根），因此：
- `extraFiles: [{ from: build/data, to: data }]` → 安装到 `<安装根>\data`
- **但 $INSTDIR 是 `D:\LinkBot\app`（程序目录），data 必须落在它的上一级 `D:\LinkBot\data`**
  → NSIS 需要在安装后把 `app\data` 移到 `..\data`。这动的是用户活动数据目录，风险高。

**改用 NSIS 直接放置**：extraFiles 的 `to` 不支持 `..`。因此采用**白名单式安装**：
- extraFiles 只带 `build/data/plugins` 与 `build/data/skills-repo` 到 `$INSTDIR\data\...`
- 安装后由 NSIS 宏把整个 `data` 目录移动到 `..\data`（即安装根的 data）
- **白名单**：只搬 `plugins\` 与 `skills-repo\` 两个子目录，不碰 `data\` 下其他任何字节（用户的 bot/profiles/sessions）

## 三、NSIS 白名单与升级安全（硬约束 1、2）

安装器宏 `customInstall`：
1. 目标 `<安装根>\data\plugins` 与 `<安装根>\data\skills-repo`
2. **skills-repo 覆盖保护**：目标已有 `.git` 且工作区被改动（`git status --porcelain` 非空或 HEAD 与出厂提交不同）→ **跳过覆盖**，只记日志（NSIS 日志 + 安装器输出）
3. plugins 覆盖：只覆盖 `BUNDLED_PLUGINS` 清单内的目录，清单外的一律不动
4. 其余 `data\` 内容（bot/、profiles/、sessions/…）**一个字节都不碰**

## 四、首启逻辑（app 侧）

`src/import-plugin.mjs`：
- `installImportPlugin` 改为**从目录复制**（不再解 tgz）：源 `<dataDir>/plugins/<name>`（即活动数据目录里的出厂副本），目标 `profile/node_modules/<name>`
- 版本比较逻辑不变（`newerVersion`）；同版本跳过
- **禁用语义不变**（硬约束 3）：profile manifest 的 `dependencies` 有、`bundles` 无 = 用户禁用 → 不写回 bundles

`src/main.mjs`：
- `bundledPlugins(resourcesDir)` 改为扫 `<dataDir>/plugins/*` 目录，读各目录 package.json 的 name/version
- 首启顺序：先确保 `<dataDir>/plugins` 有出厂副本（安装器已放好；若缺则从安装目录的 `data\plugins` 补），再拷进 profile

`src/factory.mjs`：
- skills-repo 源从 `resourcesDir/skills-repo` 改为 `<安装根>\data\skills-repo`（活动数据目录里那份）

## 五、构建脚本改动

`scripts/bundled-plugin.mjs`：
- `prepareBundledPlugins` 改为**产出明文目录**到 `build/data/plugins/<name>/`（去掉 tar 打包），保留 stagePlugin 的依赖收集逻辑
- `bundledPluginArchive` 删除

`scripts/skills-repo-git.mjs`：
- 生成的 git 仓库目录从 `resources/skills-repo` 改为 `build/data/skills-repo`

`electron-builder.yml`：
- 删 `extraResources` 里的 `bundled-plugins`、`skills-repo` 两项
- 删 `resources/factory`？——**不删**：factory seed（factory-team.json）是出厂团队种子，与「插件/技能」不同物，且首启要复制到 data/factory。它是单文件，留在 resources 无妨（需求五已定形态）。**待确认**
- 新增 `extraFiles: [{ from: build/data, to: data }]`

## 六、风险与验收

- **风险 A**：NSIS 移动目录到 `..` 涉及用户活动目录 → 用白名单只搬两个子目录，且搬之前检查目标存在同名用户目录的情况
- **风险 B**：明文目录约 1800 文件 → 体积 +5~8 MiB（issue 已确认接受），实测报数
- **验收自测**（硬要求）：造一个「已有用户数据的 data 目录」（bot/、profiles/、sessions/ 各有文件），跑安装器，**前后对比这三个目录的文件清单与哈希，证明零改动**（贴原始输出）
- 禁用语义验收：禁用某出厂插件 → 重启 → 仍禁用

## 七、待确认

1. `resources/factory`（出厂团队种子）是否也挪进 data？（issue 只提插件与 skills）
2. 安装器移动 data 的时机：装完立刻移动，还是首次启动由 app 移动？（前者更符合「即刻可用」）
