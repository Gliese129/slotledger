#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Board } from "./board.js";
import { codexConfig, installCodex, installSkill } from "./codex.js";
import { EXPORT_FORMATS, type ExportFormat } from "./export.js";
import { CLI, launch, shellQuote } from "./launch.js";
import { startServer } from "./server.js";
import { linkSession } from "./session.js";
import { STRICTNESS_GUIDE, configCommand, isConfigured, validateSettings, writeSettings, type SettingsInput } from "./settings.js";
import { Store, resolveRoot } from "./store.js";
import { STRICTNESS, type Config } from "./types.js";
import { openBrowser, startWeb } from "./web.js";

interface HookInput {
  session_id: string;
  cwd?: string;
  hook_event_name?: string;
  source?: string;
  stop_hook_active?: boolean;
  prompt?: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const out = (o: unknown) => process.stdout.write(JSON.stringify(o));

async function hook(event: string, client: string): Promise<void> {
  let store = new Store(resolveRoot());
  try {
    const input: HookInput = JSON.parse((await readStdin()) || "{}");
    if (typeof input.session_id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(input.session_id)) throw new Error("Hook input needs a valid session_id");
    const root = resolveRoot(client === "codex" ? input.cwd ?? process.cwd() : process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd());
    store = new Store(root);
    const board = new Board(store);
    const session = input.session_id;
    switch (event) {
      case "session-start": {
        if (client !== "codex") linkSession(store, session);
        board.ensureSession(session, { name: client, version: "" });
        out({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: board.brief() } });
        break;
      }
      case "prompt": {
        const ctx = board.replyContext(session, input.prompt ?? "");
        if (ctx) out({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ctx } });
        break;
      }
      case "stop": {
        board.ensureSession(session, { name: client, version: "" });
        const r = board.stop(session, !!input.stop_hook_active);
        if (r.block) out({ decision: "block", reason: r.block });
        else if (r.message) out({ systemMessage: r.message });
        break;
      }
      case "session-end":
        board.sessionEnd(session);
        break;
      default:
        throw new Error(`Unknown hook: ${event}`);
    }
  } catch (err) {
    // Fail open: a hook error must never block the coding agent.
    store.logError(`hook:${event}`, err);
  }
}

function mergeJson(path: string, patch: (cur: any) => any): void {
  const cur = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(patch(cur), null, 2) + "\n");
}

function appendLine(path: string, line: string): void {
  const cur = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (cur.split("\n").includes(line)) return;
  writeFileSync(path, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + line + "\n");
}

function flags(args: string[]): { positional: string[]; get: (name: string) => string | undefined } {
  const positional: string[] = [];
  const named = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) named.set(args[i], args[++i]);
    else positional.push(args[i]);
  }
  return { positional, get: (name) => named.get(name) };
}

function clientFrom(f: ReturnType<typeof flags>, allowBoth = false): string {
  const client = f.get("--client") ?? "claude-code";
  const allowed = allowBoth ? ["claude-code", "codex", "both"] : ["claude-code", "codex"];
  if (!allowed.includes(client)) throw new Error(`--client must be one of: ${allowed.join(", ")}`);
  return client;
}

function settingsFrom(f: ReturnType<typeof flags>): SettingsInput {
  const input = { language: f.get("--language"), strictness: f.get("--strictness") };
  const err = validateSettings(input);
  if (err) {
    console.error(err);
    process.exit(1);
  }
  return input;
}

function settingsSummary(config: Config): string {
  if (isConfigured(config)) return `- Recording: language ${config.language}, strictness ${config.strictness}`;
  return [
    "- Not set yet: " + [!config.language && "language", !config.strictness && "strictness"].filter(Boolean).join(", "),
    "  Ask the user which language records should be written in and how strict recording should be",
    `  (${STRICTNESS.map((s) => `${s}: ${STRICTNESS_GUIDE[s].summary}`).join("; ")}), then run:`,
    `  ${configCommand()}`,
    "  Until then, each session's brief asks the AI to do this.",
  ].join("\n");
}

function init(target: string, settings: SettingsInput, client: string): void {
  const root = resolveRoot(resolve(target));
  const [command, ...args] = launch();
  const cmd = (sub: string, agent: string) => launch(["hook", sub, "--client", agent]).map(shellQuote).join(" ");
  // Ours: hook commands and servers this or an earlier install wrote, including from before the rename
  const ours = (text: string) => text.includes(CLI) || /slot(ledger|board)\b/.test(text);
  // Parse existing TOML before writing any files so invalid config leaves setup untouched.
  const codex = client !== "claude-code" ? codexConfig(root, command, args) : undefined;

  mkdirSync(join(root, ".project"), { recursive: true });
  const cfg = join(root, ".project", "config.json");
  if (!existsSync(cfg)) writeFileSync(cfg, JSON.stringify({ topics: [], acceptAfterSessions: 3 }, null, 2) + "\n");
  const config = writeSettings(root, settings);
  appendLine(join(root, ".gitattributes"), ".project/events.jsonl merge=union");
  appendLine(join(root, ".gitignore"), ".project/run/");

  if (client !== "codex") mergeJson(join(root, ".mcp.json"), (c) => {
    const { slotboard: _, ...servers } = c.mcpServers ?? {};
    return { ...c, mcpServers: { ...servers, slotledger: { command, args, env: { SLOTLEDGER_ROOT: root, SLOTLEDGER_CLIENT: "claude-code" } } } };
  });

  const hooks: Record<string, string> = { SessionStart: "session-start", UserPromptSubmit: "prompt", Stop: "stop", SessionEnd: "session-end" };
  if (client !== "codex") mergeJson(join(root, ".claude", "settings.json"), (c) => {
    const h = { ...(c.hooks ?? {}) };
    for (const [ev, sub] of Object.entries(hooks)) {
      const kept = (h[ev] ?? []).filter((g: any) => !ours(JSON.stringify(g)));
      h[ev] = [...kept, { hooks: [{ type: "command", command: cmd(sub, "claude-code"), timeout: 30 }] }];
    }
    const allow = new Set([...(c.permissions?.allow ?? []).filter((p: string) => p !== "mcp__slotboard__brief"), "mcp__slotledger__brief"]);
    const enabled = new Set([...(c.enabledMcpjsonServers ?? []).filter((s: string) => s !== "slotboard"), "slotledger"]);
    return { ...c, hooks: h, enabledMcpjsonServers: [...enabled], permissions: { ...(c.permissions ?? {}), allow: [...allow] } };
  });
  if (client !== "codex") installSkill(join(root, ".claude", "skills", "slotledger"));

  if (codex !== undefined) {
    installCodex(root, codex);
    mergeJson(join(root, ".codex", "hooks.json"), (c) => {
      const h = { ...(c.hooks ?? {}) };
      for (const [ev, sub] of Object.entries(hooks)) {
        const kept = (h[ev] ?? []).map((group: any) => ({
          ...group,
          hooks: (group.hooks ?? []).filter((handler: any) => !(ours(handler.command ?? "") && /\bhook\b/.test(handler.command ?? ""))),
        })).filter((group: any) => group.hooks.length);
        h[ev] = [...kept, { hooks: [{ type: "command", command: cmd(sub, "codex"), timeout: ev === "SessionEnd" ? 3 : 30 }] }];
      }
      return { ...c, hooks: h };
    });
  }

  console.log(`slotledger is set up in ${root}
- .project/config.json: define topics and their paths for more accurate undeclared-change checks
${client !== "codex" ? "- .mcp.json, .claude/settings.json: the Claude Code MCP server and hooks\n- .claude/skills/slotledger/SKILL.md: installed the skill\n" : ""}${codex !== undefined ? "- .codex/config.toml, .codex/hooks.json: the Codex MCP server and hooks\n- .agents/skills/slotledger/SKILL.md: installed the shared skill\n- Trust this project and review/trust its hooks in Codex, then start a new session\n- Without hooks, call brief before edits and checkpoint before finishing each turn\n" : ""}\
- Run \`slotledger web\` to view the project state in a browser
${settingsSummary(config)}`);
}

const [sub, arg] = process.argv.slice(2);
if (!sub || sub === "serve") {
  await startServer();
} else if (sub === "hook") {
  await hook(arg, clientFrom(flags(process.argv.slice(4))));
} else if (sub === "init") {
  const f = flags(process.argv.slice(3));
  init(f.positional[0] ?? process.cwd(), settingsFrom(f), clientFrom(f, true));
} else if (sub === "config") {
  const f = flags(process.argv.slice(3));
  const input = settingsFrom(f);
  const root = resolveRoot(f.positional[0] ? resolve(f.positional[0]) : undefined);
  const config = input.language || input.strictness ? writeSettings(root, input) : new Store(root).readConfig();
  console.log(settingsSummary(config));
} else if (sub === "status") {
  const board = new Board(new Store(resolveRoot()));
  board.writeStatus();
  console.log(board.brief());
} else if (sub === "export") {
  const format = flags(process.argv.slice(3)).get("--format") ?? "markdown";
  if (!(EXPORT_FORMATS as readonly string[]).includes(format)) {
    console.error(`--format must be one of: ${EXPORT_FORMATS.join(", ")}`);
    process.exit(1);
  }
  process.stdout.write(new Board(new Store(resolveRoot())).export(format as ExportFormat));
} else if (sub === "web") {
  const args = process.argv.slice(3);
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const port = flag("--port");
  const board = new Board(new Store(resolveRoot()));
  const { url } = await startWeb(board, { port: port ? Number(port) : undefined, host: flag("--host") });
  console.log(`slotledger web: ${url}  (read-only; Ctrl+C to stop)`);
  if (args.includes("--open")) openBrowser(url);
} else {
  console.error("Usage: slotledger [serve] | init [dir] [--client claude-code|codex|both] [--language L] [--strictness strict|balanced|loose] | config [--language L] [--strictness S] | status | export [--format markdown|json] | web [--port N] [--open] | hook <session-start|prompt|stop|session-end> [--client claude-code|codex]");
  process.exit(1);
}
