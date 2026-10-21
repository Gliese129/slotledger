import type { Store } from "./store.js";

/**
 * hook 和 MCP server 都是同一个 CC 进程的子进程，CC 会注入 CLAUDE_PID。
 * SessionStart hook 把 session_id 写到 run/session-<CLAUDE_PID>.json，server 按同一个 pid 读。
 */
export function ownerPid(): string {
  return process.env.CLAUDE_PID ?? String(process.ppid);
}

export function linkSession(store: Store, session: string): void {
  store.writeRun(`session-${ownerPid()}.json`, { session, at: new Date().toISOString() });
}

/** 读不到关联文件时退回环境变量，再退回连接 ID */
export function currentSession(store: Store, connectionId: string): { id: string; via: "hook" | "env" | "connection" } {
  const linked = store.readRun<{ session: string }>(`session-${ownerPid()}.json`);
  if (linked?.session) return { id: linked.session, via: "hook" };
  if (process.env.CLAUDE_CODE_SESSION_ID) return { id: process.env.CLAUDE_CODE_SESSION_ID, via: "env" };
  return { id: connectionId, via: "connection" };
}
