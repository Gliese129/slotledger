import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../src/store.js";

// Runs dist/session.js in a grandchild process (node wrapped in sh, like npx would) and reports what it resolved
function resolveFromGrandchild(root: string, extraEnv: Record<string, string> = {}): { id: string; via: string } {
  const dist = resolve("dist/session.js");
  const store = resolve("dist/store.js");
  const script = `import("${dist}").then(async (s) => { const { Store } = await import("${store}"); console.log(JSON.stringify(s.currentSession(new Store(${JSON.stringify(root)}), "conn-x"))); })`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE") && !["CODEX_THREAD_ID", "SLOTLEDGER_CLIENT"].includes(k)));
  const out = execFileSync("sh", ["-c", `"${process.execPath}" -e '${script}'; :`], { env: { ...env, ...extraEnv }, encoding: "utf8" });
  return JSON.parse(out.trim());
}

describe("session linking", () => {
  it("finds the link file through an extra process in between", () => {
    const root = mkdtempSync(join(tmpdir(), "slotledger-session-"));
    // This test process plays CC: its pid is the grandparent of the node process, with sh in between
    new Store(root).writeRun(`session-${process.pid}.json`, { session: "cc-session-1" });
    expect(resolveFromGrandchild(root)).toEqual({ id: "cc-session-1", via: "hook" });
  });

  it("prefers the link file over CLAUDE_CODE_SESSION_ID, which goes stale after /clear", () => {
    const root = mkdtempSync(join(tmpdir(), "slotledger-session-"));
    new Store(root).writeRun(`session-${process.pid}.json`, { session: "after-clear" });
    expect(resolveFromGrandchild(root, { CLAUDE_CODE_SESSION_ID: "before-clear" })).toEqual({ id: "after-clear", via: "hook" });
  });

  it("falls back to the env var, then to the connection ID", () => {
    const root = mkdtempSync(join(tmpdir(), "slotledger-session-"));
    expect(resolveFromGrandchild(root, { CLAUDE_CODE_SESSION_ID: "env-session" })).toEqual({ id: "env-session", via: "env" });
    expect(resolveFromGrandchild(root)).toEqual({ id: "conn-x", via: "connection" });
  });
});
