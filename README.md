# 学习提问 · dsh-study-ask

在 DSH 主对话里**选中一段文字 → 点「提问」**，右侧栏开出一个「提问对话」，与主学习对话**分屏并排**；提问对话**不会出现在左侧会话列表里**，也不再是「每次提问新建一个会话」。

> 适用：DSH `0.2.1-rc.3` 桌面版 / Web（原生右侧栏 `@deepseek-ai/dsh-client-ui-sidebar-right`）。纯客户端插件，无宿主逻辑、无构建链。

## 为什么做它

用 DSH 学习时，一段长回答里总有想追问的细节，但直接在主对话里问会把正在学的内容顶走。已有插件（如 `dsh-sidebar-qa`）能划词追问，但**每问一次就在左栏新建一个 `❓` 会话**，很快就堆满列表。

本插件把提问会话收进侧边栏：

| | 行为 |
|---|---|
| 每个主对话 | 只有**一个**提问会话，第一次提问时创建，之后一直复用（同一话题的追问累积在同一线程里） |
| 左侧列表 | 提问会话**不显示**（`display:none`，不删除数据） |
| 右侧栏 | 提问对话以原生对话形态出现：流式回答、Markdown、输入框、模型选择、停止、审批全部复用 DSH 本体 |
| 主对话 | 完全不动：不新增消息、不滚动、不打断 |

## 用法

1. 在主对话里选中一段文字 → 浮出「提问」按钮 → 点击。
2. 右侧栏出现「提问对话」，引文已按 `> 引用` 格式填进输入框。
3. 接着写你的问题，回车发送；继续追问就在同一个提问对话里接着问。
4. 想再开提问对话：点输入框左侧的「❓ 提问对话」（当前主对话没有提问会话时会自动创建）。
5. 关掉右侧栏 tab 不影响数据；下次点「提问对话」会重新打开同一个会话。

## 实现要点

```text
选中文字
  → 浮层「提问」按钮（只认 [data-slot="conversation.session"] 里的选区，排除输入框和右栏）
  → ensureQuestionSession(mainId)
       · 先算确定性 id：session-<uuidv5(mainId)>，存在就直接复用（重启后也能认回）
       · 再查 Cookie 映射（Cookie 按 host 隔离、不按端口，而桌面版每次 --port 0 随机端口）
       · 都没有才创建：ctx.sessions.create({ sessionId: 确定性id, workspaceId | cwd })
  → ctx.sidebarRight.openResource('dsh-resource://studyask/session/<id>')
  → 本插件注册的 studyask 资源 provider（ctx.sessions.retain）
  → `sidebar.right.pane.tab` 席位 + `sidebar.right.pane.tab.title`
  → 内嵌 `conversation.content`（variant: embedded），与官方 subagent 侧栏同构
  → conversation.input.shell(questionId).actions.setDraft() 写入引文
```

### 为什么不用 localStorage 记「主对话 → 提问会话」

桌面版宿主固定用 `--port 0` 启动（见 `dsh-desktop-host` 的 `args: ["--port","0"]`），每次启动端口都不同；而 `localStorage` 按 origin（含端口）隔离，重启即丢。所以映射改由**两层持久化**保证：

1. **确定性会话 id**：提问会话的 id 是 `session-<uuidv5(主会话id)>`，创建时向宿主申请这个 id；重启后遍历会话列表重算一遍就能认回，不依赖任何存储。
2. **Cookie 兜底**：`dsh_study_ask_map`，按 host 隔离、不随端口变化，用于宿主没接受申请 id 的情况。

两条路都失效时才会新建提问会话；旧提问会话仍留在数据里（只是左栏隐藏）。

### 选区里的公式

KaTeX 每个公式都会同时渲染一份视觉 HTML 和一份视觉隐藏的 MathML，所以直接用 `selection.toString()` 取引文会得到「每个符号一行 + 再重复一遍」的乱码。本插件改为从 DOM 克隆选区再重写：

- 选区落在某个公式内部 → 整个公式以 `$TeX$` 引用；
- 选区跨过公式 → 每个 `.katex` 节点替换成它的 `annotation`（TeX 源码），再取文本，公式只出现一次。

例如选中上面那段会得到：

```text
> $y(x,t) = A\cos\left[\omega t + \varphi_p - k\,(x - x_p)\right] \quad(\text{沿 } +x)$
>
> （沿 −x 传播则把减号换加号。）操作要点：先确定参考点在传播方向的上游还是下游……
```

- **隐藏左栏行**：注入一张样式表，规则为 `[data-row-key="session:<id>"]{display:none!important}`，只覆盖本插件登记的提问会话；会话数据、日志、上下文全部保留。
- **入口**：`conversation.input.left` 的「❓ 提问对话」按钮 + 选区浮层。
- **重复打开**：同一提问会话在右栏按 `contentId` 去重，聚焦已有 tab。

## 安装

```bash
# 本地目录（开发）
dsh plugin --profile desktop add "link:D:/Projects/PluginsCreation/dsh-study-ask"

# 装完重启 DeepSeek Harness（宿主侧要重新组合 profile）
```

卸载：

```bash
dsh plugin --profile desktop remove dsh-study-ask
```

## 已知限制

- 提问会话是**真实 DSH 会话**，只是被 CSS 隐藏在左栏；`data-row-key` 这一 DOM 约定变化时需要同步（已随 0.2.1-rc.3 实测）。
- 工作区分组的「展开其余 N 个会话」计数可能仍把它算进去（仅数字，不显示行）。
- 不做「把回答回填主对话」「学习笔记导出」——需要的话可以在这套结构上继续加。
- 与 `dsh-sidebar-qa` 同时启用会出现两个划词入口，二选一。

## 文件

```
dsh-study-ask/
├── package.json        # dsh.bundle.patch + dsh.client(platform: web) + exports["./client"]
├── cordis.patch.yml    # 把插件作为一行插进 profile 的 bundle 栈
├── lib/index.js        # 宿主半区：空插件（只为让 client 半区被服务）
└── lib/client.js       # 浏览器半区：资源协议 / tab / 内嵌对话 / 选区浮层 / 隐藏列表
```

MIT
