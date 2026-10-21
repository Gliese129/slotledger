#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Board } from "./board.js";
import { startServer } from "./server.js";
import { linkSession } from "./session.js";
import { Store, resolveRoot } from "./store.js";
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

async function hook(event: string): Promise<void> {
  const input: HookInput = JSON.parse((await readStdin()) || "{}");
  const root = resolveRoot(process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd());
  const store = new Store(root);
  const board = new Board(store);
  const session = input.session_id;
  try {
    switch (event) {
      case "session-start": {
        linkSession(store, session);
        board.ensureSession(session, { name: "claude-code", version: "" });
        out({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: board.brief() } });
        break;
      }
      case "prompt": {
        const ctx = board.replyContext(session, input.prompt ?? "");
        if (ctx) out({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ctx } });
        break;
      }
      case "stop": {
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
    // Fail open: a hook error must never block CC
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

function init(target: string): void {
  const root = resolveRoot(resolve(target));
  const self = fileURLToPath(import.meta.url);
  // Use node by absolute path: hooks and the MCP server may not have node on PATH (e.g. nvm only applies in interactive shells)
  const node = process.execPath;
  const cmd = (sub: string) => `${JSON.stringify(node)} ${JSON.stringify(self)} hook ${sub}`;

  mkdirSync(join(root, ".project"), { recursive: true });
  const cfg = join(root, ".project", "config.json");
  if (!existsSync(cfg)) writeFileSync(cfg, JSON.stringify({ topics: [], acceptAfterSessions: 3 }, null, 2) + "\n");
  appendLine(join(root, ".gitattributes"), ".project/events.jsonl merge=union");
  appendLine(join(root, ".gitignore"), ".project/run/");

  mergeJson(join(root, ".mcp.json"), (c) => ({
    ...c,
    mcpServers: { ...(c.mcpServers ?? {}), slotboard: { command: node, args: [self] } },
  }));

  const hooks: Record<string, string> = { SessionStart: "session-start", UserPromptSubmit: "prompt", Stop: "stop", SessionEnd: "session-end" };
  mergeJson(join(root, ".claude", "settings.json"), (c) => {
    const h = { ...(c.hooks ?? {}) };
    for (const [ev, sub] of Object.entries(hooks)) {
      const kept = (h[ev] ?? []).filter((g: any) => !JSON.stringify(g).includes("slotboard") && !JSON.stringify(g).includes(self));
      h[ev] = [...kept, { hooks: [{ type: "command", command: cmd(sub), timeout: 30 }] }];
    }
    const allow = new Set([...(c.permissions?.allow ?? []), "mcp__slotboard__brief"]);
    return { ...c, hooks: h, enabledMcpjsonServers: [...new Set([...(c.enabledMcpjsonServers ?? []), "slotboard"])], permissions: { ...(c.permissions ?? {}), allow: [...allow] } };
  });

  console.log(`slotboard is set up in ${root}
- .project/config.json: define topics and their paths for more accurate undeclared-change checks
- .mcp.json, .claude/settings.json: the MCP server and hooks
- Consider copying skill/SKILL.md to .claude/skills/slotboard/
- Run \`slotboard web\` to view the project state in a browser`);
}

const [sub, arg] = process.argv.slice(2);
if (!sub || sub === "serve") {
  await startServer();
} else if (sub === "hook") {
  await hook(arg);
} else if (sub === "init") {
  init(arg ?? process.cwd());
} else if (sub === "status") {
  const board = new Board(new Store(resolveRoot()));
  board.writeStatus();
  console.log(board.brief());
} else if (sub === "web") {
  const args = process.argv.slice(3);
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const port = flag("--port");
  const board = new Board(new Store(resolveRoot()));
  const { url } = await startWeb(board, { port: port ? Number(port) : undefined, host: flag("--host") });
  console.log(`slotboard web: ${url}  (read-only; Ctrl+C to stop)`);
  if (args.includes("--open")) openBrowser(url);
} else {
  console.error("Usage: slotboard [serve] | init [dir] | status | web [--port N] [--open] | hook <session-start|prompt|stop|session-end>");
  process.exit(1);
}
