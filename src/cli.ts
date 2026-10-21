#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Board } from "./board.js";
import { startServer } from "./server.js";
import { linkSession } from "./session.js";
import { Store, resolveRoot } from "./store.js";

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
        throw new Error(`未知 hook：${event}`);
    }
  } catch (err) {
    // 工具故障时放行：hook 出错绝不阻塞 CC
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
  // 用绝对路径的 node：hook 和 MCP server 的 PATH 不一定有 node（比如 nvm 只在交互 shell 里生效）
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

  console.log(`slotboard 已接入 ${root}
- .project/config.json：在 topics 里配置主题和路径，未声明改动检查会更准
- .mcp.json、.claude/settings.json：MCP server 与 hooks
- 建议把 skill/SKILL.md 复制到 .claude/skills/slotboard/`);
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
} else {
  console.error("用法：slotboard [serve] | init [dir] | status | hook <session-start|prompt|stop|session-end>");
  process.exit(1);
}
