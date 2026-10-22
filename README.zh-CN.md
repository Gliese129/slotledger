# Slot Ledger

**AI 做的每个决定，都可见、可查、可撤回。**

[English](README.md) | 简体中文

用 AI 推进项目时，决定往往散落在对话和代码里：某个方案在一次修改中被换掉，对话里没有提；标着"暂定"的做法，几个会话之后成了默认；计划文档和实际进度对不上；当初的前提被推翻了，依赖它的决定却没有人回头检查。

Slot Ledger 由一个 MCP server 和一组 Claude Code / Codex hooks 组成。AI 每做出或修改一个决定，就记成一个带版本的条目，写明理由和它依赖的前提。前提变化时，依赖它的决定和任务会被标出来；每个回合结束时，你会看到一份简短的汇报，列出需要你确认的事项。

- **不打断工作**：发现问题只做标记，AI 照常工作。只有当 AI 要修改你亲自定下的目标或做法时才会被拦下，先征求你的同意。
- **追踪决定之间的依赖**：每个决定都记下它依据的前提和当时的版本。例如"同步方案"依赖"用户使用的操作系统"这条假设，假设的内容一改，同步方案就会被标为前提已变，并生成一个问题请你确认。确认仍然成立不会产生新版本，也不会继续往下游传。
- **改了代码却没有记录时提醒**：对比会话开始和回合结束时的 git 快照，按你配置的主题检查。如果 `src/sync/` 下有改动，而本次会话没有记录任何与 sync 相关的决定，回合结束前会提醒 AI 自查。检查只看文件路径、不看内容，是否需要补记由 AI 判断；主题配置得越细，提醒越准确。
- **完成需要证据，并注明来源**：能用命令验证的，由 Slot Ledger 执行命令并保存退出码和输出；无法用命令验证的（如评测报告、真机检查），记录为引用（本地文件会计算哈希）或你本人的验收原话。三种来源分开显示，引用是否通过由 AI 判断，不会显示成 Slot Ledger 执行过。没有证据的任务不会标为已验证。
- **不限于软件开发**：分类按决定的作用划分（目标、做法、环境等），研究、写作和项目规划也可以使用同一套记录、复查和汇报。
- **历史可追溯**：所有记录保存在一份只追加的事件日志中，状态、过期标记和问题都由它推算得出。可以查看 `STATUS.md`，也可以在本地网页中浏览和操作。
- **语言和记录粒度可配置**：安装时 AI 会询问记录使用的语言和严格度。

## 回合结束时的汇报

```
Needs your call (1; related work is paused)
1. approach/sync-backend is currently "OneDrive" because: users are all on Windows, which ships OneDrive.
   But assum/user-os, which it depends on, changed from "users are all on Windows" to "users are on macOS".
   Does this decision still hold? (A Still holds, keep it / B Needs a new decision) Just reply "1A".

Decisions I made for you (1; you can withdraw any of them)
2. env/target-os: macOS 13+ (follows the user's OS)
If you disagree, reply "withdraw 2".

Everything else is done: config-dir-macos (verified on darwin 25.1.0 arm64, node v22.23.0)
```

直接回复编号即可，例如 `1A` 或 `撤回 2`，AI 会查出编号对应的内容，并连同你的原话一起记录。在你回答之前，AI 不应改动与待确认事项相关的工作。

在 Claude Code 中，汇报由 hook 直接显示给你，不经过 AI 转述。Slot Ledger 自身的提示文字是英文；决定、理由、任务等内容按你选择的语言记录。

## 快速开始

### 依赖

1. Node.js 20+
2. git
3. [Claude Code](https://claude.com/claude-code) 或 [Codex](https://developers.openai.com/codex/)

### 安装

在要跟踪的项目目录中运行：

```bash
npx slotledger init --language 中文 --strictness balanced
```

`init` 会把 MCP server 写入 `.mcp.json`，把 hooks 写入 `.claude/settings.json`，把 skill 安装到 `.claude/skills/slotledger/SKILL.md`，并创建 `.project/config.json`。之后新开一个 Claude Code 会话即可生效。如果省略 `--language` 或 `--strictness`，AI 会在第一个会话中询问你。

如果项目中有 `.codex/` 或 `AGENTS.md`，或者 PATH 中能找到 `codex` 命令，`init` 会同时接入 Codex，并在输出中说明安装了哪些客户端及原因。也可以用 `--client claude-code`、`--client codex` 或 `--client both` 手动指定：

```bash
npx slotledger init --client codex --language 中文 --strictness balanced
```

对于 Codex，`init` 会把 MCP 配置合并进 `.codex/config.toml`，把生命周期 hooks 写入 `.codex/hooks.json`，并把 skill 安装到 `.agents/skills/slotledger/SKILL.md`。已有的服务配置和其他 hooks 会保留，但 TOML 的排版和注释会被重新生成。之后在 Codex 中信任该项目、审阅并信任 hooks，再新开会话。参见官方的 [MCP 配置](https://developers.openai.com/codex/mcp)和 [hooks 说明](https://learn.chatgpt.com/docs/hooks)。

Codex 的 MCP 请求通过 `threadId` 与 hooks 共用同一个会话，重连后仍能沿用。未启用 hooks 时，AI 需要在编辑前调用 `brief`、在每个回合结束前调用 `checkpoint`；收到漏记提醒并处理后，再调用 `checkpoint({ continued: true })`，并把汇报原样展示给你。这条降级路径依赖 AI 主动调用工具；拿不到线程 ID 时，会退回到按 MCP 连接区分会话。

### 版本与升级

通过 npx 运行时，`init` 会锁定当时的版本：hooks 和 MCP server 通过 `npm exec` 启动 `slotledger@<该版本>`，即使清除了 npx 缓存也能正常运行，只是之后第一次启动会重新下载。升级时重新运行 `npx slotledger@latest init`。如果是全局安装（`npm i -g slotledger`）或从源码构建，`init` 会直接使用那一份。

### 配置主题

为了让"改了代码却没有记录"的检查更准确，可以在 `.project/config.json` 中把路径划分到主题：

```json
{
  "topics": [
    { "id": "sync", "paths": ["src/sync/**"] },
    { "id": "platform", "paths": ["src/platform/**", "scripts/install*"] }
  ]
}
```

建议把 `.project/events.jsonl` 和代码一起提交，这样项目状态会随分支和回滚一起变化。`init` 已为它设置了 `merge=union`，并行分支合并时不会产生冲突。

## 工具

| 工具 | AI 何时调用 |
|---|---|
| `record` | 做出或修改一个决定。值改变时生成新版本；前提变化但值不变时，再记录一次表示确认仍成立，不生成新版本。可以用 `unaffected` 一次标出受改动牵连、但实际不受影响的决定和任务。 |
| `task` | 开始、推进、改名、暂缓或放弃一项工作，用 slug 引用。可以写 `handoff` 交接说明，它会锁定所依据决定的版本。 |
| `split` | 一个决定包含几件会各自变化的事时，把它拆成更细的几个，并让依赖它的决定和任务指向各自真正需要的部分。一次可以拆分多个。 |
| `archive` | 批量归档已完成或已放弃的任务、退役决定，使它们不再出现在 brief 中，并列出已经没有任何地方使用的决定。 |
| `verify` | 声明某项工作完成之前，提供一种证据：Slot Ledger 执行的命令（run）、其他地方产生的证据如报告或作业 ID（ref，本地文件会计算哈希）、或人的验收原话（human）。 |
| `ask` | 你不在时需要你决定的问题，会进入汇报。 |
| `respond` | 记录你对汇报的回复（`1A`、`撤回 2`）或对问题的回答。 |
| `brief` | 只读：当前生效的决定、过期标记、待回答的问题和任务。 |
| `checkpoint` | 没有 hooks 时检查 git 改动，返回回合结束的提醒或汇报。 |
| `export` | 只读：把同样的状态导出为 Markdown 或 JSON，供团队共享文档使用。 |

决定按分类命名，分类按作用而不是领域划分，适用于不同类型的项目：

| 分类 | 记录什么 | 软件 | 研究、写作 |
|---|---|---|---|
| `goal/` | 要达成什么、怎样算成功 | 默认行为 | 研究问题、成功判据、读者 |
| `approach/` | 怎么做 | 架构、数据格式 | 目标函数、实验方案、结构 |
| `env/` | 受什么环境约束 | 目标系统、运行时 | 集群、判题器版本、投稿格式 |
| `assum/` | 依赖的事实 | 用户的系统 | 数据重叠、已有结果 |
| `dep/` | 使用的外部资源 | 库 | 数据集、模型、文献 |
| `constraint/` | 限制，需写明范围 | 不能改动的代码 | 预算、字数 |

旧的前缀 `product/`、`arch/`、`platform/` 仍然可用，分别等同于 `goal/`、`approach/`、`env/`，旧日志无需迁移。执行细节不需要记录。

## Hooks

| Hook | 作用 |
|---|---|
| SessionStart | 记录会话开始，保存工作区快照，并向 AI 提供 brief。 |
| Stop | 比对工作区改动，先提醒 AI 一次遗漏的记录，再向你显示汇报。 |
| SessionEnd | 记录会话结束，并刷新 `STATUS.md`。 |

## 严格度

| 档位 | 记录哪些决定 | 回合结束时的检查 |
|---|---|---|
| `strict` | goal、approach、env、assum | 每项发现提醒一次；已实现但未验证的任务也会被提醒 |
| `balanced`（默认） | goal、approach、env，以及它们依赖的假设 | 每项发现提醒一次 |
| `loose` | 只记录 goal 和 approach | 不打断 AI，发现只出现在汇报中 |

可以随时修改：`npx slotledger config --strictness loose`。

## 命令

使用 `npx slotledger …` 运行；全局安装（`npm i -g slotledger`）后可以省略 `npx`。

```bash
slotledger                 # 运行 MCP server（stdio）
slotledger init [dir] [--client claude-code|codex|both] [--language L] [--strictness S]
slotledger config [--language L] [--strictness S]
slotledger status          # 输出 brief 并刷新 STATUS.md
slotledger web [--open]    # 本地网页：查看、批准、否决、编辑、删除
slotledger export [--format markdown|json]   # 导出项目状态，供团队共享文档使用
```

## 与团队共享

如果希望团队也能看到项目状态，可以让 AI 把它写入共享文档（Notion、wiki，或任何 AI 有连接器的地方）。AI 调用 `export` 并把输出原样写入，整页覆盖或按 key 逐条覆盖，使文档始终与 Slot Ledger 一致。队友在文档中评论或修改时，AI 先把这些内容记入 Slot Ledger（`record`、`respond` 或 `ask`），再重新导出。Slot Ledger 始终是唯一的数据来源；这条规则写在工具说明和 `SKILL.md` 中，属于约定，不是强制同步。

## 工作原理

- `.project/events.jsonl` 是只追加的日志，也是唯一的真实数据。当前状态由所有事件依次推算得出，每次读取时重新计算。
- 每个条目的 key 不变，变化的是值的版本。每个版本记录理由、来源（你还是 AI），以及它依赖的条目当时的版本。
- 只有上游的值改变，或被退役、删除、否决时，依赖它的内容才会被标为前提已变，并且只向下传递一层。确认某个决定仍然成立只会重新锁定它的前提，不生成新版本，因此更下游的内容不会被再次询问；任务会等待它所依据的决定复查完成，不需要单独处理。
- 上游决定被删除，或退役后没有其他决定接替时，AI 会看到依赖它的完整链条，并必须对每个直接下游做出选择：没有它也成立，就去掉这条依赖；否则一起退役或放弃。不能通过重新确认把依赖悄悄去掉。
- 任务在状态之外还有生命周期：live（正常）、suspended（暂缓，不出现在列表和提醒中）、archived（已归档）。
- `split` 用更细的几个决定替换原来的决定，并把依赖它的内容指向各自需要的部分，不会触发复查；拆分之后，修改其中一部分只会影响依赖这一部分的内容。
- 前提是否过期、确认状态（`proposed` 待确认、`decided` 已确认、连续 N 个会话无人反对后的 `accepted_by_default` 默认接受、`rejected` 已否决）以及由此产生的问题，都是推算得出的，不单独存储。
- hooks 和 MCP server 出错时不会阻塞：AI 照常工作，brief 中会注明哪些内容没有同步。

## 当前状态与已知限制

当前版本为 0.2。本仓库自身就在 Slot Ledger 的跟踪下开发。已知限制：

- 自动的回合检查需要启用并信任 hooks；没有 hooks 时，需要 AI 主动调用 `brief` 和 `checkpoint`。
- 同一个工作区中多个会话的文件改动无法区分归属。本会话期间如果有其他会话在活动，文件类的发现不再提醒 AI，而是放进给你的汇报，并注明可能来自那个会话。尚不能区分人的修改和 AI 的修改。
- 依赖针对的是整个决定。如果下游分别依赖其中不同的部分，AI 会用 `split` 把它拆开；拆分之前，可以用 `unaffected` 一次处理一处改动的影响。
- `.project/config.json` 中的 `requires` 记录能正确读取日志的最低版本，版本更旧时会在 brief 中提示升级。0.1.x 没有这项检查，因此同一个仓库的协作者应一起升级到 0.2。

## 开发

```bash
git clone https://github.com/Gliese129/slotledger.git
cd slotledger
npm install
npm test      # 先构建，再运行 vitest
node dist/cli.js init /path/to/project   # 在其他项目中试用本地构建
```
