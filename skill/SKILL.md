---
name: slotledger
description: When the project has the slotledger MCP (record/task/verify/ask/respond/brief tools), use it to record decisions, plans, and tasks instead of writing PLAN/TODO/handoff documents. Use it when making a decision, changing an approach, noticing a premise has changed, starting or finishing work, or when the user replies to report numbers.
---

# Recording project state with slotledger

slotledger stores decisions as versioned slots. Each decision states its rationale and premises; when a premise changes, the decisions that depend on it are flagged automatically. It won't block you; just follow the steps below.

## Setting up

Before installing slotledger into a project (or when brief says the settings aren't set), ask the user two things, then pass the answers to `slotledger init` or `slotledger config` (brief prints the exact command):

1. **Language**: which language decisions, rationales, task titles and questions should be written in. slotledger's own messages stay in English.
2. **Strictness**:
   - strict: record every goal, approach, env and assum decision; tasks count as done only after verify.
   - balanced (default): record goal, approach and env decisions and the assumptions they rest on.
   - loose: only goal and approach decisions; the end-of-turn check never interrupts you.

Follow the language and strictness that brief shows for the project.

For Codex, install with `slotledger init --client codex` (or `--client both` for Codex and Claude Code). This writes project-local MCP and hooks config and installs this skill under `.agents/skills/slotledger/`. Codex must trust the project and its hook definitions before the hooks run.

Call `brief` before editing when hooks are unavailable; this establishes the session's git baseline. When the user replies with a report number, pass their reply as `brief({ prompt: "1A" })` to read the numbered items before calling `respond`.

## When to record

Record as soon as you make or change one of these decisions, not at the end. Categories name the role a decision plays, so they fit software, research, writing and planning alike:

| Category | What counts | Software | Research, writing, planning |
|---|---|---|---|
| goal | What is wanted and what counts as success | `goal/autostart-default` off by default | `goal/success-metric` top-1 accuracy ≥ 90% on the held-out set; `goal/audience` first-year students |
| approach | How it's done: design, method, experiment plan, structure | `approach/sync-backend` self-hosted server | `approach/loss-function` label-smoothed cross-entropy; `approach/experiment-matrix` 2×2 ablation |
| env | The environment the work is bound to | `env/target-os` macOS 13+ | `env/checker-version` grader v2.1; `env/venue-format` conference template |
| assum | Facts you or the user are relying on | `assum/user-os` users are all on macOS | `assum/test-overlap` the test set shares sources with training data |
| dep | Something external the work uses (also detected from the diff for libraries) | `dep/better-sqlite3` | `dep/eval-dataset`, `dep/base-model` |
| constraint | Something that must not be touched or exceeded; needs scope | `constraint/no-touch-legacy` | `constraint/gpu-budget`, `constraint/word-limit` |

The old prefixes `product/`, `arch/` and `platform/` still work and mean `goal/`, `approach/` and `env/`. Execution details like variable names, function splits, typo fixes, or a single run's hyperparameter tweak don't need recording.

- **Write a clear rationale.** It is used to question the user when a premise changes.
- **Fill in depends.** Depend on whichever assumption or environment the decision rests on. The record result suggests candidates.
- **If the user said it, include userQuote.** Only then does it count as the user's decision.
- **Changing a goal/approach decision the user made is refused.** Ask the user first; once they agree, write it with userQuote.
- **Reuse keys.** Before adding a key, search with `brief({ query: "..." })`. Updating an existing key makes a new version. A new key that looks like an existing one is held back once with the similar keys listed: reuse one, merge with `replaces: [old keys]`, or pass `new: true` if it really is separate.
- **Merge duplicates** when brief lists them: record the one to keep with `replaces`. The old keys are retired and the decisions that depended on them are re-pointed, keeping their status.

## When a premise changes

Don't stop, and don't quietly switch approaches in the code.

1. Record the new fact first, e.g. change `assum/user-os` to macOS. The result lists the decisions that depend on it.
2. Adjust the work that depends only on the fact itself as usual.
3. goal/approach decisions go into the end-of-turn report automatically for the user to decide. Until the user answers, don't change the work behind those decisions.
4. Review the other categories yourself: if one still holds, record it again with the same value (this locks the new dependency versions); if not, change it.

## Tasks

- `task` tracks work by slug. Each task has exactly one status: todo, in_progress, implemented, needs_review, verified, dropped. Set in_progress when you start, implemented when the work is done, dropped if it's abandoned.
- needs_review is set by slotledger when a decision in the task's basedOn changes, even if the task was verified; the old pass stays in its history. Pick one way out:
  - **re-verify** with `verify`: a pass re-locks basedOn to the current decisions;
  - **confirm it still holds**: `task({ slug, basedOn: [keys], note: "why it still holds" })` re-locks basedOn and returns the task to its earlier status;
  - **drop it** with status dropped.
  If a decision it rests on has a changed premise of its own, settle that decision first.
- Done means `verify`, with one of three kinds of evidence. Each is shown with its source, so be honest about which one you have:
  - **run** (`cmd`): slotledger runs the command and keeps the exit code and output. Use it whenever a command can check the work, including scripts that check a report's metrics.
  - **ref** (`refs`, `summary`, `passed`): the evidence was produced elsewhere, e.g. an evaluation report, a run receipt, a job on a cluster scheduler, a URL. Local files get hashed so the evidence names the exact version; add key numbers in `metrics`. The pass is your reading of it, so say what it shows, not more.
  - **human** (`userQuote`, `scope`, `passed`): a person checked it themselves, e.g. on a real device or by reading the draft. Use their exact words and say what the check covered. People can also accept a task in the web view.
- Don't call anything done without evidence; if it was only checked in one environment or on one input, say which.
- Turn plans and todos straight into tasks instead of separate documents.

## Questions and replies

- If the user is around, ask them directly; record the answer with `respond`, passing the question ID from brief as question.
- If the user isn't around, use `ask`; the question appears in the end-of-turn report.
- When the user replies to report numbers, e.g. "1A" or "withdraw 2", use `respond`. userQuote is the user's exact words.

## Shared team docs

The team may follow the project in a shared doc (Notion, a wiki, or similar) that you write through its connector. slotledger stays the source of truth; the doc is a copy.

- **Writing:** call `export` (markdown for pages, json for databases) and write its output as is. Replace the whole page, or each entry under its heading (slot key, question ID, task slug). Don't summarize, reword, or add your own entries; if something is missing, record it in slotledger first, then export again.
- **Reading:** when the doc has a teammate's edit or comment, record it in slotledger before you act on it:
  - a decision someone stated → `record` with their words in userQuote (goal/approach changes still need the user's agreement)
  - an answer to a listed question → `respond` with the question ID
  - anything that needs the user's call → ask the user, or `ask`
- After recording, export again and overwrite the doc, so their edit shows up as slotledger's version.

## Wrapping up

With lifecycle hooks, slotledger builds the end-of-turn report itself and shows it to the user, so don't repeat it. If it reminds you of a decision you missed, record it; if it's only an execution detail, just finish.

Without lifecycle hooks, call `checkpoint` before finishing each turn. If it returns a nudge, address any missing records and call `checkpoint({ continued: true })` to get the report. Show that report verbatim to the user; "No new findings" needs no mention. This fallback relies on you calling the tools; it cannot automatically continue a turn or display a report outside your response.

The user can see everything in a browser with `slotledger web`, and act there too. Brief tags what a person did: `human-edit` (they rewrote it in the web view), `human-approved` (they approved your proposal), `human-rejected` (they rejected it), `human-decided` (they decided it some other way). Treat tagged decisions as the user's: ask before changing them. A decision the user deleted simply isn't there any more; don't try to recover it.
