# Slot Ledger

**Every decision your AI makes: visible, traceable, and revocable.**

English | [简体中文](README.zh-CN.md)

When an AI agent moves a project forward, its decisions end up scattered across conversations and code. An approach gets replaced during an edit and the conversation never mentions it. A choice marked "temporary" becomes the default a few sessions later. The plan and the actual progress drift apart. A premise turns out to be wrong, and nobody goes back to check the decisions that relied on it.

Slot Ledger is an MCP server plus a set of Claude Code and Codex hooks. Each time the AI makes or changes a decision, it is recorded as a versioned entry with its rationale and the premises it depends on. When a premise changes, the decisions and tasks that rest on it are flagged, and at the end of each turn you get a short report listing what needs your confirmation.

- **Doesn't interrupt the work**: problems are flagged, and the AI keeps working. The AI is stopped only when it tries to change a goal or approach you decided yourself, and has to ask you first.
- **Tracks dependencies between decisions**: each decision records the premises it relies on and their versions. For example, if the sync approach depends on the assumption about which operating system users run, changing that assumption marks the sync approach as having a changed premise and raises a question for you. Confirming that it still holds creates no new version and goes no further downstream.
- **Reminds the AI when code changed but nothing was recorded**: git snapshots from the start of the session and the end of the turn are compared against the topics you configure. If files under `src/sync/` changed and this session recorded no decision related to sync, the AI is asked to check before the turn ends. The check looks at file paths, not contents, and the AI decides whether anything needs recording; the finer your topics, the more precise the reminder.
- **Completion needs evidence, with its source**: work a command can check is verified by Slot Ledger running the command and keeping the exit code and output. Work a command can't check, such as an evaluation report or a test on a real device, is recorded as a reference (local files are hashed) or as your acceptance in your own words. The three sources are shown separately; whether a reference passes is the AI's judgment and is never shown as something Slot Ledger ran. Tasks without evidence are never marked verified.
- **Not limited to software**: categories describe the role a decision plays (goal, approach, environment, and so on), so research, writing, and planning projects can use the same records, reviews, and reports.
- **Traceable history**: everything lives in an append-only event log, and status, staleness flags, and questions are all derived from it. You can read `STATUS.md` or browse and act on it in a local web view.
- **Configurable language and level of detail**: during setup, the AI asks which language to keep records in and how strict recording should be.

## The end-of-turn report

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

Reply with the numbers, such as `1A` or `withdraw 2`, and the AI records your answer with your exact words. Until you answer, the AI shouldn't change work related to the open items.

In Claude Code, the hook shows the report to you directly, without the AI rewording it. Slot Ledger's own messages are in English; decisions, rationales, and tasks are recorded in the language you choose.

## Quick start

### Requirements

1. Node.js 20+
2. git
3. [Claude Code](https://claude.com/claude-code) or [Codex](https://developers.openai.com/codex/)

### Installation

Run this in the project you want to track:

```bash
npx slotledger init --language English --strictness balanced
```

`init` writes the MCP server to `.mcp.json`, the hooks to `.claude/settings.json`, and the skill to `.claude/skills/slotledger/SKILL.md`, and creates `.project/config.json`. Start a new Claude Code session and it takes effect. If you leave out `--language` or `--strictness`, the AI asks you in the first session.

If the project has `.codex/` or `AGENTS.md`, or `codex` is on your PATH, `init` also sets up Codex, and its output says which clients it installed and why. To choose yourself, pass `--client claude-code`, `--client codex`, or `--client both`:

```bash
npx slotledger init --client codex --language English --strictness balanced
```

For Codex, `init` merges the MCP server into `.codex/config.toml`, writes the four lifecycle hooks to `.codex/hooks.json`, and installs the skill to `.agents/skills/slotledger/SKILL.md`. Existing server settings and other hooks are kept, but TOML formatting and comments are regenerated. Then trust the project in Codex, review and trust the hooks, and start a new session. See the official [MCP configuration](https://developers.openai.com/codex/mcp) and [hooks](https://learn.chatgpt.com/docs/hooks) documentation.

Codex MCP requests share a session with the hooks through their `threadId`, which carries over across reconnections. Without hooks, the AI needs to call `brief` before editing and `checkpoint` before finishing each turn; after handling a reminder, it calls `checkpoint({ continued: true })` and shows you the report verbatim. `brief({ prompt: "1A" })` resolves the numbers in a reply. This fallback depends on the AI calling the tools; without a thread ID, sessions fall back to the MCP connection.

### Versions and upgrades

When run through npx, `init` pins the version it was run with: hooks and the MCP server start `slotledger@<that version>` through `npm exec`, so they keep working after the npx cache is cleared, at the cost of one download on the next start. To upgrade, run `npx slotledger@latest init` again. When installed globally (`npm i -g slotledger`) or built from source, `init` uses that copy directly.

### Configuring topics

To make the "code changed but nothing was recorded" check more precise, assign paths to topics in `.project/config.json`:

```json
{
  "topics": [
    { "id": "sync", "paths": ["src/sync/**"] },
    { "id": "platform", "paths": ["src/platform/**", "scripts/install*"] }
  ]
}
```

We recommend committing `.project/events.jsonl` with your code, so the project state follows branches and reverts. `init` sets `merge=union` for it, so parallel branches merge without conflicts.

## Tools

| Tool | When the AI calls it |
|---|---|
| `record` | To make or change a decision. A new value creates a new version; recording the same value after a premise changed confirms it still holds, without a new version. `unaffected` marks, in one call, the decisions and tasks a change touches that aren't actually affected by it. |
| `task` | To start, advance, rename, suspend, or drop a piece of work, by slug. A `handoff` note for whoever picks the task up is locked to the versions of the decisions it rests on. |
| `split` | To break a decision that holds several things that change independently into finer ones, pointing each decision and task that relied on it at the parts it actually needs. Several decisions can be split in one call. |
| `archive` | To archive finished or abandoned tasks and retire decisions in bulk, taking them out of the brief, and to list decisions nothing uses any more. |
| `verify` | Before claiming work is done, with one kind of evidence: a command Slot Ledger runs (run), evidence produced elsewhere such as a report or a job ID (ref; local files are hashed), or a person's acceptance in their own words (human). |
| `ask` | To put a question to you while you're away; it goes into the report. |
| `respond` | To record your reply to the report (`1A`, `withdraw 2`) or your answer to a question. |
| `brief` | Read-only: live decisions, staleness flags, open questions, and tasks. |
| `checkpoint` | Without hooks: checks git changes and returns the end-of-turn reminder or report. |
| `export` | Read-only: the same state as Markdown or JSON, for a shared team document. |

Decisions are keyed by category. Categories describe the role a decision plays rather than a domain, so they fit different kinds of projects:

| Category | What it records | Software | Research, writing |
|---|---|---|---|
| `goal/` | What is wanted and what counts as success | Default behavior | Research question, success criterion, audience |
| `approach/` | How it's done | Architecture, data formats | Objective, experiment plan, structure |
| `env/` | The environment it's bound to | Target OS, runtime | Cluster, checker version, venue format |
| `assum/` | Facts being relied on | Users' OS | Data overlap, prior results |
| `dep/` | External resources it uses | Libraries | Datasets, models, sources |
| `constraint/` | Limits, with a scope | Code not to touch | Budget, word limit |

The earlier prefixes `product/`, `arch/`, and `platform/` still work as aliases of `goal/`, `approach/`, and `env/`; older logs need no migration. Execution details aren't recorded.

## Hooks

| Hook | What it does |
|---|---|
| SessionStart | Records the start of the session, snapshots the working tree, and gives the AI the brief. |
| UserPromptSubmit | When your message looks like a reply to report numbers, tells the AI what those numbers refer to. |
| Stop | Compares the working tree, reminds the AI once about missed records, then shows you the report. |
| SessionEnd | Records the end of the session and refreshes `STATUS.md`. |

## Strictness

| Level | Decisions recorded | End-of-turn check |
|---|---|---|
| `strict` | goal, approach, env, assum | One reminder per finding, including tasks implemented but not verified |
| `balanced` (default) | goal, approach, env, and the assumptions they rest on | One reminder per finding |
| `loose` | goal and approach only | Never interrupts the AI; findings only appear in the report |

You can change it at any time: `npx slotledger config --strictness loose`.

## Commands

Run these with `npx slotledger …`; after a global install (`npm i -g slotledger`) you can drop `npx`.

```bash
slotledger                 # run the MCP server (stdio)
slotledger init [dir] [--client claude-code|codex|both] [--language L] [--strictness S]
slotledger config [--language L] [--strictness S]
slotledger status          # print the brief and refresh STATUS.md
slotledger web [--open]    # local web view: review, approve, reject, edit, delete
slotledger export [--format markdown|json]   # project state for a shared team document
```

## Sharing with your team

To keep your team informed, ask the AI to write the project state into a shared document (Notion, a wiki, or anything it has a connector for). The AI calls `export` and writes the output as is, replacing the whole page or each entry under its key, so the document always matches Slot Ledger. When a teammate comments on or edits the document, the AI first records that in Slot Ledger (`record`, `respond`, or `ask`) and then exports again. Slot Ledger remains the only source of truth; this rule is written in the tool descriptions and `SKILL.md`, so it is a convention, not an enforced sync.

## How it works

- `.project/events.jsonl` is an append-only log and the only real data. The current state is derived from the events in order and recomputed on every read.
- An entry's key never changes; its value moves forward in versions. Each version records its rationale, its source (you or the AI), and the versions of the entries it depended on at the time.
- Only a new value, or a retired, deleted, or rejected one, marks what rests on it as having a changed premise, and only one level down. Confirming that a decision still holds re-locks its premises without a new version, so nothing further downstream is asked again; tasks wait for the review of the decisions they're based on instead of needing their own.
- When an upstream decision is deleted, or retired with nothing replacing it, the AI sees the full chain that rests on it and must choose for each direct dependent: if it stands without it, the dependency is removed; otherwise it is retired or dropped too. Re-confirming can't remove the dependency silently.
- Tasks have a lifecycle separate from their status: live, suspended (on hold, out of the task list and reminders), or archived.
- `split` replaces a decision with finer ones and points what depended on it at the parts it needs, without triggering a review; after a split, changing one part only affects what depends on that part.
- Whether a premise is stale, the confirmation state (`proposed`, `decided`, `accepted_by_default` after N sessions without objection, `rejected`), and the questions they raise are all derived, never stored.
- Hooks and the MCP server fail open: if Slot Ledger hits an error, the AI keeps working and the brief notes what wasn't synced.

## Status and known limitations

The current version is 0.2. This repository is itself developed with Slot Ledger tracking it. Known limitations:

- The automatic end-of-turn checks require enabled, trusted hooks. Without them, the AI has to call `brief` and `checkpoint` itself.
- Changed files can't be attributed to one session when several work in the same working tree. If another session was active during this one, file findings go into your report instead of reminding the AI, marked as possibly coming from that session. Human edits can't yet be told apart from AI edits.
- A dependency covers a whole decision. When dependents rely on different parts of one, the AI splits it with `split`; until then, `unaffected` handles the effects of a change in one call.
- `requires` in `.project/config.json` records the oldest version that reads the log correctly, and older versions show an upgrade notice in the brief. 0.1.x doesn't have this check, so everyone working on a repository should upgrade to 0.2 together.

## Development

```bash
git clone https://github.com/Gliese129/slotledger.git
cd slotledger
npm install
npm test      # builds, then runs vitest
node dist/cli.js init /path/to/project   # try your local build in another project
```
