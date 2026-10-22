# slotboard

**Every decision your AI makes: visible, traceable, revocable.**

English | [简体中文](README.zh-CN.md)

AI coding agents are honest in their replies, but the project state they leave behind drifts. A sync backend gets swapped inside `config.ts` without a word. A "temporary" choice becomes the default three sessions later. The TODO says done while the plan says not started. Docs pile up and none are ever retired. And when a premise changes — "our users are on Windows" turns out to be wrong — nobody goes back to the decisions that rested on it.

slotboard is an MCP server plus Claude Code and Codex hooks that records each decision as a **versioned slot** with its rationale and the premises it depends on. When a premise changes, everything built on it is flagged automatically, and you get a short report at the end of the turn with the questions that need you.

- 🚦 **Never blocks your flow.** It flags instead of refusing. The only hard stop is the AI trying to override a product or architecture decision you made yourself.
- 🔗 **Dependencies locked like a lockfile.** `arch/sync-backend` depends on `assum/user-os@1`. Bump the assumption and the sync decision goes stale, with a question generated from its own rationale.
- 🕵️ **Catches decisions hidden in code.** A git snapshot diff is mapped to your topics, so "changed `src/sync/**` but recorded nothing" gets noticed.
- ✅ **Evidence, not claims.** `verify` runs the command itself and keeps the exit code and output. Nothing is "done" until it passes.
- 💬 **One-line answers.** Reply `1A` or `withdraw 2`; the AI records it with your exact words.
- 📜 **Append-only history.** One event log is the source of truth; status, staleness and questions are all derived from it. Read it as `STATUS.md` or in a local web view, where you can also approve, reject, edit or delete decisions yourself.
- 🌐 **Your language, your strictness.** On setup the AI asks which language to keep records in and how much to record.

## What you see at the end of a turn

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

slotboard writes this report itself and shows it to you directly, so the AI can't soften it.

## Quick start

Requirements: Node.js 20+, git, and [Claude Code](https://claude.com/claude-code) or [Codex](https://developers.openai.com/codex/). slotboard isn't on npm yet, so build it from source:

```bash
git clone https://github.com/Gliese129/slotboard.git
cd slotboard
npm install
npm run build
```

Then, in the project you want to track:

```bash
node /path/to/slotboard/dist/cli.js init --language English --strictness balanced
mkdir -p .claude/skills/slotboard
cp /path/to/slotboard/skill/SKILL.md .claude/skills/slotboard/
```

`init` writes the MCP server to `.mcp.json`, the hooks to `.claude/settings.json`, and creates `.project/config.json`. Start a new Claude Code session and it's live. If you leave out `--language` or `--strictness`, the AI asks you in the first session.

For Codex, run this in the project you want to track:

```bash
node /path/to/slotboard/dist/cli.js init --client codex --language English --strictness balanced
```

This merges the MCP server into `.codex/config.toml`, installs the four lifecycle hooks in `.codex/hooks.json`, and copies the skill to `.agents/skills/slotboard/SKILL.md`. Existing server settings and unrelated hooks are preserved; TOML formatting and comments are rewritten. Use `--client both` to install both clients. Trust the project and review/trust the hooks in Codex, then start a new session. See [Codex MCP configuration](https://developers.openai.com/codex/mcp) and [hooks](https://learn.chatgpt.com/docs/hooks).

Codex MCP calls use their per-request `threadId` to share the hook session, including across reconnections. Without hooks, call `brief` before editing and `checkpoint` before finishing each turn; after a nudge, call `checkpoint({ continued: true })` and show the report verbatim. `brief({ prompt: "1A" })` resolves reply numbers. This fallback depends on the agent calling these tools; without a thread ID, sessions fall back to the MCP connection.

For sharper "undeclared change" checks, tell slotboard which paths belong to which topic:

```json
{
  "topics": [
    { "id": "sync", "paths": ["src/sync/**"] },
    { "id": "platform", "paths": ["src/platform/**", "scripts/install*"] }
  ]
}
```

Commit `.project/events.jsonl` with your code: the state then follows branches and reverts, and `init` sets `merge=union` so parallel branches merge cleanly.

## Tools the AI gets

| Tool | When the AI calls it |
|---|---|
| `record` | It makes or changes a decision. Same key again means a new version. |
| `task` | It starts, advances, or drops a piece of work, by slug. |
| `verify` | Before claiming something works. slotboard runs the command and keeps the evidence. |
| `ask` | It needs your call while you're away. The question goes into the report. |
| `respond` | You reply to the report (`1A`, `withdraw 2`) or answer a question. |
| `brief` | Read-only: live decisions, stale flags, open questions, tasks. |
| `checkpoint` | Check git changes and return the end-of-turn nudge or report when hooks are unavailable. |
| `export` | Read-only: the same state as Markdown or JSON, for a shared team doc. |

Decisions are keyed by category: `product/`, `arch/`, `platform/`, `assum/`, `dep/`, `constraint/`. Implementation details aren't recorded.

## Hooks

| Hook | What it does |
|---|---|
| SessionStart | Starts the session, snapshots the working tree, injects the brief. |
| UserPromptSubmit | When you reply with report numbers, tells the AI what they refer to. |
| Stop | Diffs the working tree. Nudges the AI once about missed records, then shows you the report. |
| SessionEnd | Closes the session and refreshes `STATUS.md`. |

## Strictness

| Level | What to record | End-of-turn check |
|---|---|---|
| `strict` | product, arch, platform, assum | Nudges once per finding, including tasks left at implemented without verify |
| `balanced` (default) | product, arch, platform, and the assumptions they rest on | Nudges once per finding |
| `loose` | product and arch only | Never interrupts the AI; findings only appear in the report |

Change it any time with `slotboard config --strictness loose`.

## Commands

```bash
slotboard                 # run the MCP server (stdio)
slotboard init [dir] [--client claude-code|codex|both] [--language L] [--strictness S]
slotboard config [--language L] [--strictness S]
slotboard status          # print the brief and refresh STATUS.md
slotboard web [--open]    # local web view: review, approve, reject, edit, delete
slotboard export [--format markdown|json]   # project state for a shared team doc
```

## Sharing with your team

To keep a team in the loop, ask the AI to put the project state in your shared docs (Notion, a wiki, anything it has a connector for). It calls `export` and writes the output as is, overwriting the page or each entry under its key, so the doc always matches slotboard. When a teammate comments or edits there, the AI records that in slotboard first (`record`, `respond`, or `ask`) and then exports again. slotboard stays the source of truth; this rule lives in the tool description and `SKILL.md`, so it is a convention, not an enforced sync.

## How it works

- `.project/events.jsonl` is an append-only log and the only real data. Current state is a fold over it, recomputed on every read.
- A slot's key never changes; its value moves forward in versions. Each version records its rationale, its source (you or the AI), and the exact versions of the slots it depends on.
- Stale premises, confirmation state (`proposed`, `decided`, `accepted_by_default` after N sessions without objection, `rejected`), and the questions they raise are derived, never stored.
- Hooks and the MCP server fail open: if slotboard errors, the AI keeps working and the brief notes what wasn't synced.

## Status

v0, and it works on itself: this repo is developed with slotboard tracking it. Known gaps:

- Automatic lifecycle checks require enabled, trusted hooks. Without them, the agent must call `brief` and `checkpoint`.
- With two sessions in the same working tree, each one is blamed for the other's changes. Telling human edits from AI edits isn't implemented yet.
- A task's `basedOn` can't be re-pinned after creation, so it keeps its review flag once a decision it rests on changes.

## Development

```bash
npm install
npm test      # builds, then runs vitest
```
