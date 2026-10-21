---
name: slotboard
description: When the project has the slotboard MCP (record/task/verify/ask/respond/brief tools), use it to record decisions, plans, and tasks instead of writing PLAN/TODO/handoff documents. Use it when making a decision, changing an approach, noticing a premise has changed, starting or finishing work, or when the user replies to report numbers.
---

# Recording project state with slotboard

slotboard stores decisions as versioned slots. Each decision states its rationale and premises; when a premise changes, the decisions that depend on it are flagged automatically. It won't block you; just follow the steps below.

## Setting up

Before installing slotboard into a project (or when brief says the settings aren't set), ask the user two things, then pass the answers to `slotboard init` or `slotboard config` (brief prints the exact command):

1. **Language**: which language decisions, rationales, task titles and questions should be written in. slotboard's own messages stay in English.
2. **Strictness**:
   - strict: record every product, arch, platform and assum decision; tasks count as done only after verify.
   - balanced (default): record product, arch and platform decisions and the assumptions they rest on.
   - loose: only product and arch decisions; the end-of-turn check never interrupts you.

Follow the language and strictness that brief shows for the project.

## When to record

Record as soon as you make or change one of these decisions, not at the end:

| Category | What counts | Example |
|---|---|---|
| product | Behavior or defaults the user can notice | `product/autostart-default` off by default |
| arch | Design choices, data formats, external interfaces | `arch/sync-backend` self-hosted server |
| platform | Target OS, runtime versions | `platform/target-os` macOS 13+ |
| assum | Facts you or the user are relying on | `assum/user-os` users are all on macOS |
| dep | A new library (also detected from the diff) | `dep/better-sqlite3` |
| constraint | Something that must not be touched; needs scope | `constraint/no-touch-legacy` |

Implementation details like variable names, function splits, or typo fixes don't need recording.

- **Write a clear rationale.** It is used to question the user when a premise changes.
- **Fill in depends.** Depend on whichever assumption or platform the decision rests on. The record result suggests candidates.
- **If the user said it, include userQuote.** Only then does it count as the user's decision.
- **Changing a product/arch decision the user made is refused.** Ask the user first; once they agree, write it with userQuote.

## When a premise changes

Don't stop, and don't quietly switch approaches in the code.

1. Record the new fact first, e.g. change `assum/user-os` to macOS. The result lists the decisions that depend on it.
2. Change platform-specific code as usual.
3. arch/product decisions go into the end-of-turn report automatically for the user to decide. Until the user answers, don't change the code behind those decisions.
4. Review the other categories yourself: if one still holds, record it again with the same value (this locks the new dependency versions); if not, change it.

## Tasks

- `task` tracks work by slug: set in_progress when you start, implemented when the code is written, dropped if it's abandoned.
- Done means `verify`: it runs a command and keeps the evidence. Don't call anything done that hasn't been run; if it was only verified in one environment, say which.
- Turn plans and todos straight into tasks instead of separate documents.

## Questions and replies

- If the user is around, ask them directly; record the answer with `respond`, passing the question ID from brief as question.
- If the user isn't around, use `ask`; the question appears in the end-of-turn report.
- When the user replies to report numbers, e.g. "1A" or "withdraw 2", use `respond`. userQuote is the user's exact words.

## Wrapping up

slotboard builds the end-of-turn report itself and shows it to the user, so don't repeat it. If it reminds you of a decision you missed, record it; if it's only an implementation detail, just finish.

The user can see everything in a browser with `slotboard web`.
