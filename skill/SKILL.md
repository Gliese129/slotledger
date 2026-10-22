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

For Codex, install with `slotboard init --client codex` (or `--client both` for Codex and Claude Code). This writes project-local MCP and hooks config and installs this skill under `.agents/skills/slotboard/`. Codex must trust the project and its hook definitions before the hooks run.

Call `brief` before editing when hooks are unavailable; this establishes the session's git baseline. When the user replies with a report number, pass their reply as `brief({ prompt: "1A" })` to read the numbered items before calling `respond`.

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
- **Reuse keys.** Before adding a key, search with `brief({ query: "..." })`. Updating an existing key makes a new version. A new key that looks like an existing one is held back once with the similar keys listed: reuse one, merge with `replaces: [old keys]`, or pass `new: true` if it really is separate.
- **Merge duplicates** when brief lists them: record the one to keep with `replaces`. The old keys are retired and the decisions that depended on them are re-pointed, keeping their status.

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

## Shared team docs

The team may follow the project in a shared doc (Notion, a wiki, or similar) that you write through its connector. slotboard stays the source of truth; the doc is a copy.

- **Writing:** call `export` (markdown for pages, json for databases) and write its output as is. Replace the whole page, or each entry under its heading (slot key, question ID, task slug). Don't summarize, reword, or add your own entries; if something is missing, record it in slotboard first, then export again.
- **Reading:** when the doc has a teammate's edit or comment, record it in slotboard before you act on it:
  - a decision someone stated → `record` with their words in userQuote (product/arch changes still need the user's agreement)
  - an answer to a listed question → `respond` with the question ID
  - anything that needs the user's call → ask the user, or `ask`
- After recording, export again and overwrite the doc, so their edit shows up as slotboard's version.

## Wrapping up

With lifecycle hooks, slotboard builds the end-of-turn report itself and shows it to the user, so don't repeat it. If it reminds you of a decision you missed, record it; if it's only an implementation detail, just finish.

Without lifecycle hooks, call `checkpoint` before finishing each turn. If it returns a nudge, address any missing records and call `checkpoint({ continued: true })` to get the report. Show that report verbatim to the user; "No new findings" needs no mention. This fallback relies on you calling the tools; it cannot automatically continue a turn or display a report outside your response.

The user can see everything in a browser with `slotboard web`, and act there too. Brief tags what a person did: `human-edit` (they rewrote it in the web view), `human-approved` (they approved your proposal), `human-rejected` (they rejected it), `human-decided` (they decided it some other way). Treat tagged decisions as the user's: ask before changing them. A decision the user deleted simply isn't there any more; don't try to recover it.
