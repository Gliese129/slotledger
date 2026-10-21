---
name: slotboard
description: 项目里有 slotboard MCP（record/task/verify/ask/respond/brief 工具）时，用它记录决定、计划和任务，而不是写 PLAN/TODO/handoff 文档。做决定、改方案、发现前提变化、开始或完成工作、用户回复汇报编号时使用。
---

# 用 slotboard 记录项目状态

slotboard 把决定记成带版本的槽位。每个决定写明理由和前提，前提变了，依赖它的决定会被自动标记。它不会拦你，按下面做就行。

## 什么时候 record

做出或改变以下决定时，立刻 record，不要等到最后：

| 分类 | 什么算 | 例子 |
|---|---|---|
| product | 用户能感知的行为、默认值 | `product/autostart-default` 默认关闭 |
| arch | 方案选型、数据格式、对外接口 | `arch/sync-backend` 自建服务器 |
| platform | 目标系统、运行时版本 | `platform/target-os` macOS 13+ |
| assum | 你或用户依赖的事实判断 | `assum/user-os` 用户都用 macOS |
| dep | 新增一个库（diff 里也会自动识别） | `dep/better-sqlite3` |
| constraint | 不能动的东西，必须给 scope | `constraint/no-touch-legacy` |

变量命名、函数拆分、修 typo 这类实现细节不用记。

- **写清 rationale。** 前提变了会用它向用户提问。
- **写 depends。** 这个决定靠哪个假设或平台成立，就依赖谁。record 的返回值会推荐候选。
- **用户亲口说的，带 userQuote。** 这样才算用户的决定。
- **改用户定过的 product/arch 会被拒。** 先问用户，同意后带 userQuote 再写。

## 前提变了怎么办

不要停下来，也不要在代码里悄悄换方案。

1. 先把新事实 record 下来，例如 `assum/user-os` 改成 macOS。返回值会列出依赖它的决定。
2. 平台相关的代码照常改。
3. arch/product 类的决定会自动进入结尾汇报，交给用户拍板。在用户回答前，不要改这些方案对应的代码。
4. 其他类别你自己复查：仍成立就用相同的 value 再 record 一次（会锁定新的依赖版本），不成立就改。

## 任务

- `task` 用 slug 管理工作：开始时设 in_progress，写完设 implemented，不做了设 dropped。
- 完成要靠 `verify`：它会执行命令并留存证据。没跑过的不要说完成，只在某个环境验证过的，要写明环境。
- 计划、待办直接建成 task，不另写文档。

## 提问与回复

- 用户在场时，直接问用户；拿到回答后用 `respond` 记下，question 填 brief 里的问题 ID。
- 用户不在场时，用 `ask`，问题会出现在结尾汇报里。
- 用户回复汇报编号时用 `respond`，例如回复"1A"、"撤回 2"。userQuote 填用户原话。

## 结尾

slotboard 会在回合结束时自己生成汇报并显示给用户，你不用复述。如果它提醒你漏记了决定，补上；只是实现细节就直接结束。
