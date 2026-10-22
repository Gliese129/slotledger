import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Snapshot } from "./types.js";

function git(root: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

/** Working-tree snapshot through a temporary index, leaving the user's staging area alone. Null outside a git repo. */
export function snapshot(root: string): Snapshot | null {
  const dir = mkdtempSync(join(tmpdir(), "slotledger-"));
  try {
    let head: string | null = null;
    try { head = git(root, ["rev-parse", "--verify", "-q", "HEAD"]); } catch { head = null; }
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    git(root, head ? ["read-tree", head] : ["read-tree", "--empty"], env);
    git(root, ["add", "-A"], env);
    return { head, tree: git(root, ["write-tree"], env) };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface Change {
  status: "A" | "M" | "D";
  path: string;
}

export function changedFiles(root: string, from: string, to: string): Change[] {
  if (from === to) return [];
  try {
    const out = git(root, ["diff-tree", "-r", "--no-renames", "--name-status", from, to]);
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [s, ...p] = l.split("\t");
        return { status: (s[0] === "A" || s[0] === "D" ? s[0] : "M") as Change["status"], path: p.join("\t") };
      });
  } catch {
    return [];
  }
}
