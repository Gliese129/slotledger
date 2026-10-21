import { execFileSync } from "node:child_process";
import type { Store } from "./store.js";

/**
 * Hooks and the MCP server are both descendants of the same CC process.
 * CC injects CLAUDE_PID into hooks (not into the MCP server), so the SessionStart hook writes
 * session_id to run/session-<CLAUDE_PID>.json and the server looks for that file along its
 * ancestor chain. Walking the chain keeps this working when the server is wrapped in npx or sh.
 */
export function ownerPid(): string {
  return process.env.CLAUDE_PID ?? String(process.ppid);
}

export function linkSession(store: Store, session: string): void {
  store.writeRun(`session-${ownerPid()}.json`, { session, at: new Date().toISOString() });
}

let cachedAncestors: number[] | null = null;

/** Parent, grandparent, ... up to (not including) pid 1. Ancestors don't change, so this is computed once. */
export function ancestors(maxDepth = 8): number[] {
  if (cachedAncestors) return cachedAncestors;
  const out: number[] = [];
  let pid = process.ppid;
  while (pid > 1 && out.length < maxDepth) {
    out.push(pid);
    try {
      pid = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
    } catch {
      break;
    }
  }
  return (cachedAncestors = out);
}

/**
 * The link file comes first: it follows /clear, while CLAUDE_CODE_SESSION_ID is fixed when the server spawns.
 * Without a link file, fall back to the env var, then to the connection ID.
 */
export function currentSession(store: Store, connectionId: string): { id: string; via: "hook" | "env" | "connection" } {
  const pids = process.env.CLAUDE_PID ? [Number(process.env.CLAUDE_PID)] : ancestors();
  for (const pid of pids) {
    const linked = store.readRun<{ session: string }>(`session-${pid}.json`);
    if (linked?.session) return { id: linked.session, via: "hook" };
  }
  if (process.env.CLAUDE_CODE_SESSION_ID) return { id: process.env.CLAUDE_CODE_SESSION_ID, via: "env" };
  return { id: connectionId, via: "connection" };
}
