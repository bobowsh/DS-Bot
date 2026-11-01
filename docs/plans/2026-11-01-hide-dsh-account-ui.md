# 桌面应用里关掉 DSH 自带的欢迎、登录与 API key 界面

- 日期：2026-11-01
- 状态：方案已定，与代码在同一个 PR 实施
- 相关：（待提 PR）

## 为什么

桌面应用自己的首启流程（`app/src/first-run.mjs`）已经负责欢迎、数据位置和导入团队，
模型和密钥也由 DS Bot 的设置页管（模型行 `llm-deepseek` / `llm-deepseek-account` 由
导入的 `cordis.patch.yml` 和 `.credentials.yaml` 供给）。DSH 自家还有一套
账号/密钥/新手引导界面在页面里挂着，对桌面应用是重复且误导的入口。

这三个界面都来自**同一个 UI 插件行**（证据来自包的实现与 README）：
`app/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml` 挂 `deepseek-account`，
`dsh-web-app/cordis.patch.yml` 里挂着 UI 行：

```yaml
L144: - id: ui-settings-account
L145:   name: '@deepseek-ai/dsh-client-ui-settings-account'
```

`dsh-client-ui-settings-account` 的实现里同时承载：

- 新手引导（`onboardingWelcome`「欢迎使用」/「Welcome to」，`step: "welcome"` … `"done"`，
  每 profile 记一次——就是打包检查里那个 Continue 弹框）；
- 账号登录（`SignInDialog`，自带"改用 API key"按钮 `addApiKey`）；
- 模型凭据引导里的账号选择（`AccountOnboarding` 的 `useAccount` / `useApiKey`）；
- 侧栏账号菜单（README：「Account settings display DeepSeek login state …」）。

## 已定的行为

### 禁用方式

- 运行时（服务端）的 `deepseek-account`、`account-controller` 行**不禁**，模型链路不受影响。
- **只禁 UI 行**：用 DSH 官方的行级 `disabled` 机制。补丁条目按 `id` 匹配后逐键覆盖
  （`dsh-app-boot` 的 `applyEntryPatches`），带 `name` 防止将来包名变更时静默错配：

  ```yaml
  - id: ui-settings-account
    name: '@deepseek-ai/dsh-client-ui-settings-account'
    disabled: true
  ```

- 落地为第三个 reconcile 补丁，沿用 `office-patch.mjs` / `search-patch.mjs` 的既有模式：
  新文件 `app/src/own-ui-patch.mjs` 维护 `<DSH_HOME>/profiles/own-ui.patch.yml`，
  通过 `runProfile` 的 `patchFiles` 传入。**每次启动都写**（app 永久不要这些界面），
  内容幂等；compos 后的组合里没有这一行（DSH 升级删了行）就不写。
- 补丁**只在团队 profile 挂**（与 office 一致），first-run 检查的 `import-check` profile 不挂：
  它只读会话，账号 UI 不在其页面里显示；且两个 profile 若都写同一处会互相覆盖路径。
- 插件页开关依然有效：用户以后想临时看这些界面，可在插件页打开——
  下次启动会被对齐回关闭。

### 与其他界面的关系

- 模型选择照旧走 DS Bot 的界面（`bt-model-chip`）和 `ui-settings-models`。
- DeepSeek 侧的账号状态展示、登录、密钥录入在桌面应用里**没有入口**——这是需求本身；
  用插件版或 DSH Web 可继续用。
- 打包检查（`check-packed.mjs`）里的 Continue 关闭逻辑保留：幂等，onboarding 不出现时无操作。

## 不做什么

- 不禁服务端行（`deepseek-account`、`account-controller`），不动模型提供的运行时行
  （`llm-deepseek`、`llm-deepseek-account`）。
- 不改 DSH 的包，不 patch DSH 内部——只用 profile 补丁层。
- 不隐藏 `ui-settings-models` 或 DS Bot 自己的模型/密钥 UI。
- 不做"按用户设置开关"的入口：桌面应用就默认关闭，用户要这些界面用网页版。

## 已知限制

- DSH 未来版本若改了行 `id` 或包名（`name` 补丁会因 mismatch 跳过并告警），
  需要同步更新本文档与 `own-ui-patch.mjs`。
- 引导状态存于 profile/本地存储；禁用不清理旧的已见状态，回滚后欢迎页仍按"已看过"记录。

## 变更

- 2026-11-01：初稿，随代码一起实施。
