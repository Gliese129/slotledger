import type { Store } from "./store.js";

/**
 * Hooks and the MCP server are both children of the same CC process, and CC injects CLAUDE_PID.
 * The SessionStart hook writes session_id to run/session-<CLAUDE_PID>.json; the server reads it by the same pid.
 */
export function ownerPid(): string {
  return process.env.CLAUDE_PID ?? String(process.ppid);
}

export function linkSession(store: Store, session: string): void {
  store.writeRun(`session-${ownerPid()}.json`, { session, at: new Date().toISOString() });
}

/** Without a link file, fall back to the env var, then to the connection ID */
export function currentSession(store: Store, connectionId: string): { id: string; via: "hook" | "env" | "connection" } {
  const linked = store.readRun<{ session: string }>(`session-${ownerPid()}.json`);
  if (linked?.session) return { id: linked.session, via: "hook" };
  if (process.env.CLAUDE_CODE_SESSION_ID) return { id: process.env.CLAUDE_CODE_SESSION_ID, via: "env" };
  return { id: connectionId, via: "connection" };
}
