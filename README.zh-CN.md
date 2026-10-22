# slotboard

**AI 做的每个决定，都看得见、查得到、撤得回。**

[English](README.md) | 简体中文

AI 编程助手在回复里很诚实，但它留下的项目状态会悄悄走样：写 `config.ts` 时顺手把同步方案换了，一句没提；标着"暂定"的方案，三个会话后成了默认；TODO 说做完了，计划里却还没开始；文档只增不减，从没有哪份被标记作废。更麻烦的是前提变了的时候，比如"用户都用 Windows"其实不对，建立在这个前提上的决定没人回头去看。

slotboard 是一个 MCP server，加上一组 Claude Code / Codex hooks。它把每个决定记成**带版本的槽位**，写明理由和依赖的前提。前提一变，依赖它的决定会被自动标出来；每个回合结束时，你会收到一份简短的汇报，列出需要你拍板的问题。

- 🚦 **不打断工作流。** 只标记，不拒绝。唯一会真正停下的情况：AI 想推翻你亲口定过的产品或架构决定。
- 🔗 **像 lockfile 一样锁定依赖。** `arch/sync-backend` 依赖 `assum/user-os@1`。假设一升版本，同步方案就被标为前提已变，并用它自己的理由生成一个问题。
- 🕵️ **揪出藏在代码里的决定。** 用 git 快照比对改动，再映射到你配置的主题，"改了 `src/sync/**` 却什么都没记"会被发现。
- ✅ **看证据，不听声称。** `verify` 由 slotboard 自己执行命令，留下退出码和输出。没跑通就不算完成。
- 💬 **一句话回复。** 回 `1A` 或 `撤回 2`，AI 会连同你的原话一起记下。
- 📜 **只追加的历史。** 一份事件日志是唯一的真实数据，状态、过期标记、问题都从它推算。可以看 `STATUS.md`，也可以打开本地网页。
- 🌐 **语言和严格度由你定。** 安装时 AI 会先问你：记录用什么语言、记多细。

## 回合结束时你会看到

```
Needs your call (1; related work is paused)
1. arch/sync-backend is currently "OneDrive" because: users are all on Windows, which ships OneDrive.
   But assum/user-os, which it depends on, changed from "users are all on Windows" to "users are on macOS".
   Does this decision still hold? (A Still holds, keep it / B Needs a new decision) Just reply "1A".

Decisions I made for you (1; you can withdraw any of them)
2. platform/target-os: macOS 13+ (follows the user's OS)
If you disagree, reply "withdraw 2".

Everything else is done: config-dir-macos (verified on darwin 25.1.0 arm64, node v22.23.0)
```

汇报由 slotboard 自己生成，直接显示给你，AI 没有机会改写措辞。slotboard 自身的提示文字是英文的；决定、理由、任务这些内容，按你选的语言记录。

## 快速上手

需要 Node.js 20+、git，以及 [Claude Code](https://claude.com/claude-code) 或 [Codex](https://developers.openai.com/codex/)。slotboard 还没发布到 npm，先从源码构建：

```bash
git clone https://github.com/Gliese129/slotboard.git
cd slotboard
npm install
npm run build
```

然后在要跟踪的项目里运行：

```bash
node /path/to/slotboard/dist/cli.js init --language 中文 --strictness balanced
mkdir -p .claude/skills/slotboard
cp /path/to/slotboard/skill/SKILL.md .claude/skills/slotboard/
```

`init` 会把 MCP server 写进 `.mcp.json`，把 hooks 写进 `.claude/settings.json`，并创建 `.project/config.json`。新开一个 Claude Code 会话就生效了。如果没带 `--language` 或 `--strictness`，AI 会在第一个会话里问你。

Codex 用户在要跟踪的项目里运行：

```bash
node /path/to/slotboard/dist/cli.js init --client codex --language 中文 --strictness balanced
```

它会把 MCP 配置合并进 `.codex/config.toml`，把四个生命周期 hooks 写入 `.codex/hooks.json`，并安装 skill 到 `.agents/skills/slotboard/SKILL.md`。已有的服务设置和其他 hooks 会保留，TOML 的排版和注释会重新生成。`--client both` 可同时安装两个客户端。在 Codex 中信任项目、审阅并信任 hooks，然后新开会话。参见官方 [MCP 配置](https://developers.openai.com/codex/mcp)和 [hooks 说明](https://learn.chatgpt.com/docs/hooks)。

Codex MCP 请求通过 `threadId` 和 hooks 共用会话，重连后也能沿用。未启用 hooks 时，AI 应在编辑前调用 `brief`，每回合结束前调用 `checkpoint`；遇到漏记提醒时处理后再调用 `checkpoint({ continued: true })`，把报告原样展示给用户。`brief({ prompt: "1A" })` 可读取回复编号。这条降级路径依赖 AI 主动调用工具；拿不到线程 ID 时则退回到按 MCP 连接区分会话。

想让"未声明改动"检查更准，就告诉 slotboard 哪些路径属于哪个主题：

```json
{
  "topics": [
    { "id": "sync", "paths": ["src/sync/**"] },
    { "id": "platform", "paths": ["src/platform/**", "scripts/install*"] }
  ]
}
```

建议把 `.project/events.jsonl` 和代码一起提交：这样项目状态会跟着分支和回滚走。`init` 已经设置了 `merge=union`，并行分支合并时不会冲突。

## AI 拿到的工具

| 工具 | AI 什么时候调用 |
|---|---|
| `record` | 做出或改变一个决定。同一个 key 再记一次就是升版本。 |
| `task` | 开始、推进或放弃一项工作，用 slug 引用。 |
| `verify` | 声称某样东西能用之前。由 slotboard 执行命令并留存证据。 |
| `ask` | 你不在时需要你拍板，问题会进汇报。 |
| `respond` | 你回复了汇报（`1A`、`撤回 2`）或回答了问题。 |
| `brief` | 只读：生效的决定、过期标记、待回答问题、任务。 |
| `checkpoint` | 没有 hooks 时检查 git 改动，返回回合结束提醒或报告。 |
| `export` | 只读：同样的状态，导出成 Markdown 或 JSON，给团队共享文档用。 |

决定按分类命名：`product/`、`arch/`、`platform/`、`assum/`、`dep/`、`constraint/`。实现细节不记。

## Hooks

| Hook | 做什么 |
|---|---|
| SessionStart | 开始会话、给工作区拍快照、注入 brief。 |
| UserPromptSubmit | 你用汇报编号回复时，告诉 AI 这些编号指的是什么。 |
| Stop | 比对工作区改动。先提醒 AI 一次漏记的内容，再给你看汇报。 |
| SessionEnd | 结束会话，刷新 `STATUS.md`。 |

## 严格度

| 档位 | 记什么 | 回合结束时的检查 |
|---|---|---|
| `strict` | product、arch、platform、assum | 每个发现提醒一次，停在 implemented 没 verify 的任务也会被提醒 |
| `balanced`（默认） | product、arch、platform，以及它们依赖的假设 | 每个发现提醒一次 |
| `loose` | 只记 product 和 arch | 不打断 AI，发现只出现在汇报里 |

随时可以改：`slotboard config --strictness loose`。

## 命令

```bash
slotboard                 # 运行 MCP server（stdio）
slotboard init [dir] [--client claude-code|codex|both] [--language L] [--strictness S]
slotboard config [--language L] [--strictness S]
slotboard status          # 打印 brief 并刷新 STATUS.md
slotboard web [--open]    # 本地网页：查看、批准、否决、编辑、删除
slotboard export [--format markdown|json]   # 导出项目状态，给团队共享文档用
```

## 和团队共享

想让团队也看到项目状态，就让 AI 把它放进你们的共享文档（Notion、wiki，任何它有连接器的地方）。AI 调用 `export`，把输出原样写进去，整页或按 key 逐条覆盖，所以文档始终和 slotboard 一致。队友在文档里评论或改动时，AI 先把这些记进 slotboard（`record`、`respond` 或 `ask`），再重新导出。slotboard 仍是唯一的真实数据；这条规则写在工具说明和 `SKILL.md` 里，是约定，不是强制同步。

## 原理

- `.project/events.jsonl` 是只追加的日志，也是唯一的真实数据。当前状态是把所有事件按顺序折叠出来的，每次读取都重新计算。
- 槽位的 key 永远不变，变的是值的版本。每个版本记下理由、来源（你还是 AI），以及它依赖的槽位当时的确切版本。
- 前提是否过期、确认状态（`proposed` 提议中、`decided` 已确认、连续 N 个会话没人反对后的 `accepted_by_default` 默认接受、`rejected` 已否决），以及由此产生的问题，全部是推算出来的，从不存储。
- hooks 和 MCP server 出错时一律放行：AI 照常工作，brief 里会注明哪些没同步上。

## 现状

v0，而且已经用在它自己身上：这个仓库就是在 slotboard 的跟踪下开发的。已知不足：

- 自动生命周期检查需要启用并信任 hooks；没有 hooks 时需要 AI 主动调用 `brief` 和 `checkpoint`。
- 同一个工作区同时开两个会话时，会把对方的改动算到自己头上。区分人改的还是 AI 改的，也还没做。
- 任务创建后不能重新锁定 `basedOn`，所以它依赖的决定一变，复查标记就会一直留着。

## 开发

```bash
npm install
npm test      # 先构建，再跑 vitest
```
