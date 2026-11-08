# AGENTS.md

本文件给在本仓库里干活的 AI 编码代理看。人类贡献者请看 [CONTRIBUTING.md](CONTRIBUTING.md)，那里有同样的规矩，写得更细。

## 这个项目是什么

DS Bot 是一支由长期存在的 Bot 组成的团队，构建在 DeepSeek Harness（DSH）之上。它分两部分：

- `ds-bot/`：Bot 功能本身，写成 DSH 插件。这个插件在 DSH Desktop、DSH Web 和桌面应用里都能跑。
- `app/`：Windows、macOS、Linux 的桌面应用。它用自己锁定的 DSH 版本加载 `ds-bot` 插件，跑在自己的 profile 和自己的 `DSH_HOME` 里，并从用户的 DSH 导入已有团队。

Bot 团队：

- 每个 Bot 都是一个长期存在的身份，它的工作在 DSH Session 里跑：自己的私聊一个、它所在的每个群一个、上下文满了再开一个新的（旧的仍可读）。每一轮都走 DSH 正常的 agent 循环、工具和模型路由。
- 团队是协作的：Bot 之间能互相发消息、共享群聊、能看到彼此在干什么。但每个 Bot 仍各自独立跑，互不干扰。
- Bot 有清晰且互不相同的角色。Main Bot 权限最高：它创建、修改、移除其他 Bot。其他 Bot 没有这些权限。Main Bot 可以有多个。
- 用户可以定制每个 Bot（名字、角色标签、指令、模型、形象）。
- 行为必须可靠：Bot 依据证据行动，不越出自己的目标，结果可被核查。

## 硬规矩

1. **基于 DSH 构建，绝不改它。** Bot 功能只用文档里有的插件 API。桌面应用只通过文档里的入口（`@deepseek-ai/dsh/profile-boot`、`dsh` 命令行）启动 DSH。绝不修改 DeepSeek Harness，也不要依赖 DSH 安装目录里的文件。DSH 里缺东西就停下来说清楚，不许用打补丁的方式绕过去。
2. **不许有密钥。** 绝不写入、打印或提交 API key、token、cookie 或 `DSH_HOME` 的内容。测试用假模型（`ds-bot/dev/mock-llm.mjs`），它不需要 key。
3. **允许复制其他产品的代码。** 当复制是最快且正确的做法时，可以复制代码（包括应用里自带的 DSH 宿主包）。界面相关的工作，优先调用宿主导出且可调用的组件，而不是复制一份——这样我们的界面能一直跟宿主一致，不会漂成仿制品；只复制宿主没有导出的东西。要写明复制的代码来自哪里：源码注释或 `NOTICE` 文件里的一条记录。要指名 DS Bot 连接的第三方产品（比如 Bot 运行的 agent 命令行），用该产品的官方 logo，并在 `NOTICE` 里列出它的来源和归属方。
4. **`client.js` 是生成物。** 改 `ds-bot/src/client/`，然后跑 `npm run build`，两个文件一起提交。绝不手改 `client.js`。
5. **不许动用户自己的 DSH 数据。** 桌面应用的数据在自己的 `DSH_HOME` 里；它的导入只读 `~/.dsh`，绝不往那里写。测试台的数据在 `.dsh-test-<name>/` 里。绝不让测试指向 `~/.dsh`、指向桌面应用的数据，或指向用户自己在跑的 DSH。

## 常用命令

在 `ds-bot/` 下跑。单元测试和 linter 会用 `dev/harness/` 里的 `@deepseek-ai/*` 包，这些包由 `npm run harness` 按 `dev/harness/package.json` 里写的 DSH 版本从 npm 装上。`DSH_HARNESS` 可以改为指向另一个安装，或指向一个 DeepSeek Harness 源码检出。测试台需要在 `../deepseek-harness`（或 `DSH_HARNESS`）有一个检出，版本按 README 里写的。

```sh
npm ci                                 # 仅构建工具（esbuild）
npm run harness                        # 一次：装测试和 linter 要用的 DSH 包
npm run build                          # src/client → client.js
npm test                               # 单元测试；client.js 过期也会失败
node scripts/build-client.mjs --check  # 检查 client.js 与 src/client 一致
npm run lint                           # oxlint
CONTEXT_WINDOW=100000 CHECK_RATIO=0.45 dev/bench.sh smoke 3096 8796 reset && node dev/smoke.mjs smoke 3096   # 冒烟测试
dev/bench.sh smoke 3096 8796 stop
```

`npm test`、`--check`、`npm run lint` 全过才算改完；CI 在每个 PR 上跑这三项。改了 `index.js` 或 `src/host/` 的，还要跑冒烟测试。每个测试台用空闲端口，结束时要停掉你自己起的每个测试台和进程。

### 打包桌面应用

`app/` 把 `ds-bot` 当 `file:` 依赖，npm 在安装时会把它**复制**进 `app/node_modules/ds-bot`：改 `ds-bot/` 永远不会更新那份副本。没重新安装就打出来的包，带的是旧插件，症状是打包后的应用能正常启动但缺少这次的改动。

在 `app/` 里每次 `npm run pack` / `npm run dist` 之前：

```sh
npm ci                                                                          # 把 ds-bot/ 重新复制进 node_modules
node -e "console.log(require('./node_modules/ds-bot/package.json').version)"     # 必须等于 ds-bot/package.json 里的版本
```

绝不许用 `npm install --legacy-peer-deps` 来绕过这件事：它会重新解析整棵依赖树，把 `@electron/windows-sign` 和 `electron-winstaller` 甩掉，打包直接坏掉。完整发布流程见 [docs/dev/release-checklist.md](docs/dev/release-checklist.md)。

## 分支、PR 与 issue

完整流程在 [CONTRIBUTING.md](CONTRIBUTING.md#how-we-work)。代理必须遵守的部分：

- 从最新的 `dev-me` 拉分支，分支名用 `fix/<issue>-<名字>`、`feat/<issue>-<名字>`、`docs/<名字>` 或 `chore/<名字>`。分支名绝不以 `dev/` 开头。PR 一律开向 `dev-me`（它是本仓库的默认分支）；只有发版和热修才进 `main`。
- **任何人都不许直接在 `dev-me` 上提交**，必须走分支 + PR。合并权在项目所有者，代理只开 PR，不合并。
- 分支落后就先合并 `dev-me` 对齐最新基线，别在旧基线上开 PR。绝不 rebase 已推送的分支，绝不 force-push。
- 填好 PR 模板。用 `Fixes #<编号>` 关联 issue；修 bug 的要说清修的是哪个 bug。用户能感知的改动写在 Changelog 栏，不要直接改 `CHANGELOG.md`。
- 一个 PR 只做一件事：只含本通道或本 issue 的改动，不夹带别的活。发现夹带要拆开。
- PR 正文要写全：改了什么、**验收证据（真实的命令输出与数字）**、Changelog、与 issue 的关联。证据只贴真实输出，不写「应该可以」；测试数字、lint、`--check` 三项都要有。跑不了的要说清为什么、卡在哪一步。
- 没做完的必须如实标注：用 `BLOCKED` / `skip` / 「未验证」写清，并说明解除条件。绝不许把 skip 当通过，把预跑当正式验收。每次追加提交后同步更新 PR 正文，别让正文里的数字停在旧口径。
- 带 `maintainer` 标签的 issue 或 PR 不要开工，它们等维护者处理。已经被别人认领的 issue 不要抢。
- 改动行为之前，先读 `docs/plans/` 里对应的设计（还有 `docs/vision.md`）；界面相关的还要读 `docs/design/ui-standard.md`。改动已经定下来的设计需要维护者同意；新的大功能要把设计说明放进同一个 PR。
- 不要在没有证据的情况下关闭 issue：合入的 PR 或提交、它重复的那个 issue，或者不修的原因，三者之一必须写清楚。
- 给 issue 分诊，按 [.agents/skills/issue-triage/SKILL.md](.agents/skills/issue-triage/SKILL.md) 做。
- 给界面改动录演示 GIF，按 [.agents/skills/record-browser-gif/SKILL.md](.agents/skills/record-browser-gif/SKILL.md) 做。

## 目录结构

- `ds-bot/index.js` 和 `ds-bot/src/host/`：服务端（花名册与存储、工具、轮次与投递、群、对话分段与搜索索引、图片、浏览器桥、`api/bot` 通道）。
- `ds-bot/src/client/`：浏览器端（侧栏、聊天、面板、主题、形象、Bot 浏览器面板）。
- `ds-bot/web-search.js`：`auto` 网页搜索提供方，与 Bot 团队代码无关。
- `ds-bot/test/`：单元测试与测试数据。`ds-bot/dev/`：测试用的 DSH 包（`harness/`）、假模型、测试台、冒烟测试、形象生成器、Linux 下的 Desktop 脚本。
- `app/`：桌面应用（Electron 主进程与窗口、首次启动与导入、安装器与更新）。

## 代码风格

- 跟着你改动周围的代码写。函数保持小，名字保持朴素。
- 只有当代码本身看不出原因时才写注释：隐藏的约束、不变式、绕行方案。不要描述代码在做什么。
- **提交信息用中文**（团队以中文工作）：主题行用祈使句，原因写进正文。提交保持小。代码里的标识符、API 名和文件名仍用英文。
- 提这个改动的人就是提交作者。不要把 AI 工具或 bot 设为作者或提交者，也不要给它们加 `Co-authored-by` 行。
- 插件里给用户看的文案用英文。改其中一个时，README 和 README.zh.md 要同步更新。
