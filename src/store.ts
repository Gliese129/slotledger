import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { join } from "node:path";
import type { Actor, AnyEvent, Config, EventDataMap, EventType } from "./types.js";

// CC sets CLAUDE_PROJECT_DIR for both hooks and the MCP server; the server's cwd isn't guaranteed to be the project
export function resolveRoot(cwd = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()): string {
  if (process.env.SLOTBOARD_ROOT) return process.env.SLOTBOARD_ROOT;
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return cwd;
  }
}

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastTime = 0;
let lastRand: number[] = [];

/** ULID, monotonic within the same millisecond so event IDs sort */
export function ulid(now = Date.now()): string {
  let rand: number[];
  if (now === lastTime) {
    rand = lastRand.slice();
    for (let i = rand.length - 1; i >= 0; i--) {
      if (rand[i] < 31) { rand[i]++; break; }
      rand[i] = 0;
    }
  } else {
    rand = Array.from(randomBytes(16), (b) => b % 32);
  }
  lastTime = now;
  lastRand = rand;
  let t = "";
  let n = now;
  for (let i = 0; i < 10; i++) { t = B32[n % 32] + t; n = Math.floor(n / 32); }
  return t + rand.map((r) => B32[r]).join("");
}

export function shortHash(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 10);
}

export class Store {
  readonly dir: string;
  readonly runDir: string;
  readonly eventsPath: string;

  constructor(readonly root: string) {
    this.dir = join(root, ".project");
    this.runDir = join(this.dir, "run");
    this.eventsPath = join(this.dir, "events.jsonl");
  }

  readEvents(): AnyEvent[] {
    if (!existsSync(this.eventsPath)) return [];
    const out: AnyEvent[] = [];
    for (const line of readFileSync(this.eventsPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip bad lines so one corrupt line can't take down the rest */ }
    }
    // merge=union can scramble line order; sort back into time order by ULID
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  append<T extends EventType>(type: T, actor: Actor, data: EventDataMap[T], cause?: string): AnyEvent {
    mkdirSync(this.dir, { recursive: true });
    const ev = { id: ulid(), type, at: new Date().toISOString(), actor, ...(cause ? { cause } : {}), data } as AnyEvent;
    // one O_APPEND write per line, so concurrent appends from several processes never interleave
    appendFileSync(this.eventsPath, JSON.stringify(ev) + "\n");
    return ev;
  }

  readConfig(): Config {
    const p = join(this.dir, "config.json");
    const def: Config = { topics: [], acceptAfterSessions: 3 };
    if (!existsSync(p)) return def;
    try {
      return { ...def, ...JSON.parse(readFileSync(p, "utf8")) };
    } catch {
      return def;
    }
  }

  readRun<T>(name: string): T | null {
    const p = join(this.runDir, name);
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
  }

  writeRun(name: string, value: unknown): void {
    mkdirSync(this.runDir, { recursive: true });
    writeFileSync(join(this.runDir, name), JSON.stringify(value, null, 2));
  }

  /** Fail open: log the error, and brief reports "not synced" */
  logError(where: string, err: unknown): void {
    try {
      mkdirSync(this.runDir, { recursive: true });
      const msg = err instanceof Error ? err.stack ?? err.message : String(err);
      appendFileSync(join(this.runDir, "errors.log"), `${new Date().toISOString()} [${where}] ${msg}\n`);
    } catch { /* can't even write the log; give up */ }
  }

  errorCount(): number {
    const p = join(this.runDir, "errors.log");
    if (!existsSync(p)) return 0;
    return readFileSync(p, "utf8").split("\n").filter((l) => /^\d{4}-/.test(l)).length;
  }

  listRun(): string[] {
    return existsSync(this.runDir) ? readdirSync(this.runDir) : [];
  }
}
