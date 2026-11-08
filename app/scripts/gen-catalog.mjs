// Generate the factory plugin catalog from the intranet Gitea repositories and the npm registry,
// instead of maintaining plugins.json by hand. Prints the proposed catalog and writes it only
// with --write, so a human can review the diff before pushing.
//
// Usage:
//   node scripts/gen-catalog.mjs                 # print the proposed catalog
//   node scripts/gen-catalog.mjs --write         # write to the Gitea catalog clone
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const ORG = 'dshplugin'
const API = 'http://192.168.1.10:3000/api/v1'
const REG = 'http://192.168.1.10:3000/api/packages/dshplugin/npm/'
const CATALOG_CLONE = 'E:/dsbot-work/gitea-mirror/_catalog_clone/plugins.json'
const cred = JSON.parse(readFileSync('D:/Users/bobowsh/.dsh/storages/dsh-gitea-credentials/dsh-bot.json', 'utf8'))
const auth = ['-H', `Authorization: token ${cred.token}`]

function getJson(url, useAuth = false) {
  const args = ['-s', '-m', '20']
  if (useAuth) args.push(...auth)
  args.push(url)
  return JSON.parse(execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 1 << 26 }))
}

// The catalog's human-facing fields, keyed by the npm package name. These are editorial (category
// and bilingual description) and stay in this generator, not in the repositories.
const editorial = {
  'dsh-chat-import': ['session', 'Import conversation history from 25+ AI coding agents into DSH as resumable sessions.', '把 25+ AI 编程 Agent 的聊天记录导入 DSH 继续对话。'],
  'dsh-xdpool': ['model', 'Aggregate free model quotas from many providers into one DSH pool.', '把多家的免费模型额度接进 DSH 同一个池。'],
  'dshmarket': ['market', 'The plugin market inside DSH: browse, search and one-click install.', 'DSH 内置插件市场：浏览、搜索、一键安装。'],
  'dsh-better-sidebar': ['ui', 'A better sidebar: file tree, editor, changes, tasks and side chat.', '更好的侧边栏：文件树、编辑器、变更、任务与侧聊合一。'],
  'dsh-computer-use-win': ['tool', 'Windows desktop operation through UI Automation.', '通过 UIA 操作 Windows 桌面。'],
  'dsh-screenshot-native': ['tool', 'Native screenshots on Windows.', 'Windows 原生截图。'],
  'ds-harness-remote': ['remote', 'P2P remote access: reach DSH from a phone or the web.', 'P2P 远程访问：手机或网页连进 DSH。'],
  'dsh-plugin-guide': ['dev', 'A skill-form guide for building DSH plugins.', '以技能形式提供的 DSH 插件开发指南。'],
  'dsh-client-ui-git-graph': ['ui', 'Git branches and commit graph in the DSH UI.', 'DSH 界面里的 Git 分支与提交图。'],
  'dsh-rule-manager': ['config', 'Manage DSH rules: global AGENTS.md, project rules and LLM-assisted splitting.', '统一管理 DSH 规则：全局 AGENTS.md、项目规则、LLM 辅助拆分。'],
  'dsh-tool-activator': ['config', 'Load base tools by default and activate the rest on demand.', '默认只加载基础工具，其余按需激活。'],
  'dsh-aide': ['editor', 'AIDE: a local IDE inside DSH.', 'AIDE：DSH 内的本地 IDE。'],
  'skillhub-dsh': ['market', 'SkillHub skill market for DSH (fork, peer range widened for 0.2.2-rc.1).', 'DSH 的 SkillHub 技能市场（fork 版，已放宽 peer 范围）。'],
}

// Gitea repo name -> catalog name (scoped packages keep their scope in the catalog).
const repoToName = {
  'dsh-client-ui-git-graph': '@linxin666/dsh-client-ui-git-graph',
  'skillhub-dsh': '@astron-team/skillhub-dsh',
}

// The original author's repository, kept by hand: the Gitea copy is a mirror, and the catalog's
// `upstream` field must point at the source a human would sync from, not back at the mirror.
const upstreamOf = {
  'dsh-chat-import': 'https://github.com/Nwflower/dsh-chat-import',
  'dsh-xdpool': 'https://github.com/XDTrees/dsh-xdpool',
  'dshmarket': 'https://github.com/dsh-market/dsh-market',
  'dsh-better-sidebar': 'https://github.com/omdsh-dev/DSH-better-sidebar',
  'dsh-computer-use-win': 'https://github.com/Yu-tao-Li/dsh-computer-use-win',
  'dsh-screenshot-native': 'https://github.com/lenrendre/dsh-screenshot-native',
  'ds-harness-remote': 'https://github.com/liguobao/ds-harness-remote',
  'dsh-plugin-guide': 'https://github.com/PerryLink/dsh-plugin-guide',
  'dsh-client-ui-git-graph': 'https://github.com/zhu1090093659/dsh-web',
  'dsh-rule-manager': 'https://github.com/wzz3034026545/dsh-rule-manager',
  'dsh-tool-activator': 'https://github.com/hairyf/dsh-tool-activator',
  'dsh-aide': 'https://github.com/PrismScopes/dsh-aide',
  'skillhub-dsh': 'https://github.com/iflytek/skillhub',
}

const repos = getJson(`${API}/orgs/${ORG}/repos?limit=100`, true)
const packages = getJson(`${API}/packages/${ORG}?type=npm&limit=100`, true)
const published = new Map(packages.map(p => [p.name, p.version]))

const plugins = []
for (const repo of repos) {
  if (repo.name === 'dsh-catalog') continue
  const name = repoToName[repo.name] ?? repo.name
  const npm = published.get(repo.name)
  if (npm === undefined) { console.error(`skip ${repo.name}: not published to the npm registry`); continue }
  const ed = editorial[repo.name]
  if (ed === undefined) { console.error(`skip ${repo.name}: no editorial entry`); continue }
  const [category, en, zh] = ed
  const upstream = upstreamOf[repo.name] ?? repo.html_url
  plugins.push({
    name,
    owner: ORG,
    url: upstream,
    npm: repo.name,
    registry: REG,
    category,
    description: { en, zh },
    page: upstream,
    added: '2026-11-07',
    installedVersion: npm,
    tag: `v${npm}`,
    source: repo.name === 'dsh-client-ui-git-graph' ? 'forked-from-monorepo' : 'mirror',
    upstream,
  })
}
plugins.sort((a, b) => a.name.localeCompare(b.name, 'en'))

const old = existsSync(CATALOG_CLONE) ? JSON.parse(readFileSync(CATALOG_CLONE, 'utf8')) : { plugins: [] }
// Preserve fields that are not derivable from the repositories (status / installedVersion overrides).
for (const p of plugins) {
  const prev = old.plugins.find(x => x.name === p.name)
  if (prev?.status !== undefined) p.status = prev.status
  if (prev?.installedVersion === null) p.installedVersion = null
  if (prev?.note !== undefined) p.note = prev.note
}

const catalog = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  registry: REG,
  org: ORG,
  count: plugins.length,
  plugins,
}
const text = `${JSON.stringify(catalog, null, 2)}\n`

if (process.argv.includes('--write')) {
  writeFileSync(CATALOG_CLONE, text, 'utf8')
  console.log(`wrote ${plugins.length} plugins to ${CATALOG_CLONE}`)
} else {
  console.log(text)
  const oldNames = old.plugins.map(p => p.name).sort()
  const newNames = plugins.map(p => p.name).sort()
  console.log('\n--- diff of names ---')
  console.log('removed:', oldNames.filter(n => !newNames.includes(n)).join(', ') || '(none)')
  console.log('added  :', newNames.filter(n => !oldNames.includes(n)).join(', ') || '(none)')
  console.log(`old ${oldNames.length} -> new ${newNames.length}`)
}