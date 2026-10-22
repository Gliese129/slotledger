import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Board } from "../src/board.js";
import { createServer } from "../src/server.js";
import { currentSession } from "../src/session.js";
import { Store } from "../src/store.js";

const cli = resolve("dist/cli.js");
let root: string;
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CLAUDE") && !["SLOTLEDGER_ROOT", "SLOTLEDGER_CLIENT", "CODEX_THREAD_ID"].includes(key))),
  // A codex installed on this machine would change init's default
  PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
};
function write(path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}
function run(...args: (string | Record<string, string>)[]) {
  const extra = typeof args.at(-1) === "object" ? args.pop() as Record<string, string> : {};
  return execFileSync(process.execPath, [cli, ...args as string[]], { cwd: root, env: { ...env, ...extra }, encoding: "utf8" });
}
function hook(event: string, input: object) {
  const output = execFileSync(process.execPath, [cli, "hook", event, "--client", "codex"], {
    cwd: root, env: { ...env, CLAUDE_PROJECT_DIR: "/unused-claude-project" },
    input: JSON.stringify({ session_id: "codex-1", cwd: root, ...input }), encoding: "utf8",
  });
  return output ? JSON.parse(output) : null;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "slotledger-codex-")));
  execFileSync("git", ["init", "-q"], { cwd: root });
  write(".gitignore", ".project/\nSTATUS.md\n");
  write("src/main.ts", "export {};\n");
  write(".project/config.json", JSON.stringify({ language: "English", strictness: "balanced", topics: [{ id: "core", paths: ["src/**"] }] }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("Codex setup", () => {
  it("merges TOML and hooks, installs the skill, and is safe to rerun", () => {
    write(".codex/config.toml", 'model = "existing-model"\n[mcp_servers.other]\ncommand = "other"\n[mcp_servers.slotledger]\nurl = "https://old.example/mcp"\ndisabled_tools = ["verify"]\n');
    write(".codex/hooks.json", JSON.stringify({ description: "existing hooks", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo keep-me" }, { type: "command", command: "slotledger hook stop" }] }] } }));
    run("init", "--client", "codex");
    const first = readFileSync(join(root, ".codex/config.toml"), "utf8");
    const hooks = readFileSync(join(root, ".codex/hooks.json"), "utf8");
    run("init", "--client", "codex");
    expect(readFileSync(join(root, ".codex/config.toml"), "utf8")).toBe(first);
    expect(readFileSync(join(root, ".codex/hooks.json"), "utf8")).toBe(hooks);
    const config = parse(first) as any;
    expect(config.model).toBe("existing-model");
    expect(config.mcp_servers.other.command).toBe("other");
    expect(config.mcp_servers.slotledger).toMatchObject({ command: process.execPath, args: [cli], cwd: root, disabled_tools: ["verify"], env: { SLOTLEDGER_ROOT: root, SLOTLEDGER_CLIENT: "codex" } });
    expect(config.mcp_servers.slotledger.url).toBeUndefined();
    const parsed = JSON.parse(hooks);
    expect(parsed.hooks.Stop.flatMap((g: any) => g.hooks)).toHaveLength(2);
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe("echo keep-me");
    expect(parsed.hooks.SessionEnd[0].hooks[0].timeout).toBe(3);
    expect(existsSync(join(root, ".agents/skills/slotledger/SKILL.md"))).toBe(true);
    expect(existsSync(join(root, ".claude"))).toBe(false);
    expect(existsSync(join(root, ".mcp.json"))).toBe(false);
  });

  it("sets up Claude Code alone by default and supports both clients", () => {
    const out = run("init");
    expect(out).toContain("Clients: Claude Code (no sign of Codex");
    expect(existsSync(join(root, ".claude/settings.json"))).toBe(true);
    expect(existsSync(join(root, ".codex"))).toBe(false);
    run("init", "--client", "both");
    expect(existsSync(join(root, ".codex/hooks.json"))).toBe(true);
    expect(existsSync(join(root, ".mcp.json"))).toBe(true);
  });

  it("adds Codex without --client when the project or PATH points to it", () => {
    write("AGENTS.md", "# Agents\n");
    expect(run("init")).toContain("Clients: Claude Code and Codex (found AGENTS.md");
    expect(existsSync(join(root, ".codex/hooks.json"))).toBe(true);
    expect(existsSync(join(root, ".claude/settings.json"))).toBe(true);

    rmSync(join(root, "AGENTS.md"));
    rmSync(join(root, ".codex"), { recursive: true });
    write("bin/codex", "#!/bin/sh\n");
    expect(run("init", { PATH: join(root, "bin") + delimiter + env.PATH })).toContain("found codex on PATH");
    expect(existsSync(join(root, ".codex/hooks.json"))).toBe(true);

    rmSync(join(root, ".codex"), { recursive: true });
    expect(run("init", "--client", "claude-code", { PATH: join(root, "bin") + delimiter + env.PATH })).toContain("Clients: Claude Code\n");
    expect(existsSync(join(root, ".codex"))).toBe(false);
  });

  it("rejects invalid TOML and client names before installing", () => {
    write(".codex/config.toml", "not valid toml");
    for (const client of ["codex", "typo"]) {
      const result = spawnSync(process.execPath, [cli, "init", "--client", client], { cwd: root, env });
      expect(result.status).not.toBe(0);
    }
    expect(readFileSync(join(root, ".codex/config.toml"), "utf8")).toBe("not valid toml");
    expect(existsSync(join(root, ".gitattributes"))).toBe(false);
  });
});

describe("Codex lifecycle", () => {
  it("uses per-request threads over inherited environment and Claude links", () => {
    const store = new Store(root);
    store.writeRun(`session-${process.ppid}.json`, { session: "unrelated-claude" });
    vi.stubEnv("CODEX_THREAD_ID", "codex-env");
    vi.stubEnv("SLOTLEDGER_CLIENT", "codex");
    expect(currentSession(store, "conn-1", { threadId: "codex-request" })).toEqual({ id: "codex-request", via: "request" });
    expect(currentSession(store, "conn-2").id).toBe("codex-env");
    vi.stubEnv("CODEX_THREAD_ID", "");
    expect(currentSession(store, "conn-3")).toEqual({ id: "conn-3", via: "connection" });
    expect(currentSession(store, "conn-4", { threadId: "../../outside" }).id).toBe("conn-4");
    vi.stubEnv("SLOTLEDGER_CLIENT", "claude-code");
    vi.stubEnv("CLAUDE_PID", "2147483647");
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "claude-env");
    vi.stubEnv("CODEX_THREAD_ID", "codex-env");
    expect(currentSession(store, "conn-5")).toEqual({ id: "claude-env", via: "env" });
  });

  // spawns a hook process per step, so a busy machine can take several seconds
  it("runs Codex hooks with git detection, report replies, compaction and session end", { timeout: 30000 }, () => {
    expect(hook("session-start", {}).hookSpecificOutput.hookEventName).toBe("SessionStart");
    write("src/main.ts", "export const changed = true;\n");
    expect(hook("stop", {}).decision).toBe("block");
    expect(hook("stop", { stop_hook_active: true }).systemMessage).toContain("core");
    const board = new Board(new Store(root));
    board.record("codex-1", { key: "approach/test", value: "A", rationale: "test" });
    hook("stop", { stop_hook_active: true });
    expect(hook("prompt", { prompt: "withdraw 1" }).hookSpecificOutput.additionalContext).toContain("approach/test");
    hook("session-start", { source: "compact" });
    expect(board.store.readEvents().filter((e) => e.type === "session.started")).toHaveLength(1);
    expect(board.load().state.sessions.get("codex-1")!.client.name).toBe("codex");
    hook("session-end", {});
    expect(board.store.readEvents().some((e) => e.type === "session.ended")).toBe(true);
    expect(hook("stop", { session_id: "../../bad" })).toBeNull();
  });

  it("keeps MCP calls and hook reports on the same thread, including after reconnect", async () => {
    hook("session-start", {});
    const board = new Board(new Store(root));
    for (let connection = 0; connection < 2; connection++) {
      const server = createServer(root);
      const client = new Client({ name: "codex", version: "test" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const call = (name: string, args: Record<string, unknown> = {}, threadId = "codex-1") => client.callTool({ name, arguments: args, _meta: { threadId } });
      try {
        await call("brief");
        if (!connection) await call("record", { key: "approach/test", value: "A", rationale: "test" });
        const report = await call("checkpoint", { continued: true });
        expect(JSON.stringify(report)).toContain(connection ? "No new findings" : "approach/test");
        if (!connection) {
          expect(JSON.stringify(await call("brief", { prompt: "withdraw 1" }))).toContain("1 = decision");
          expect((await call("respond", { item: 1, withdraw: true, userQuote: "withdraw 1" })).isError).toBeFalsy();
        }
        await call("task", { slug: "other", title: "Other thread" }, "codex-2");
      } finally {
        await client.close();
        await server.close();
      }
    }
    expect([...board.load().state.sessions.keys()].sort()).toEqual(["codex-1", "codex-2"]);
    expect(board.store.readEvents().filter((e) => e.type === "slot.versioned").every((e) => e.actor.kind === "agent" && e.actor.session === "codex-1")).toBe(true);
  });

  it("detects undeclared changes using MCP alone when hooks are disabled", async () => {
    const server = createServer(root);
    const client = new Client({ name: "codex", version: "test" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const call = (name: string, args = {}) => client.callTool({ name, arguments: args, _meta: { threadId: "without-hooks" } });
    try {
      await call("brief");
      write("src/main.ts", "export const changed = true;\n");
      expect(JSON.stringify(await call("checkpoint"))).toContain("core");
      expect(JSON.stringify(await call("checkpoint", { continued: true }))).toContain("no matching decision");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
