import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { basename, join } from "node:path";
import { slotTopics } from "./analyze.js";
import type { Board } from "./board.js";
import { dependentsOf } from "./fold.js";
import { questionsForUser } from "./report.js";

const PAGE = new URL("../web/index.html", import.meta.url);

/** Changes whenever the event log or config changes; the page polls with it as an ETag */
export function stateVersion(board: Board): string {
  const stamp = (p: string) => (existsSync(p) ? `${statSync(p).size}.${statSync(p).mtimeMs}` : "0");
  return `"${stamp(board.store.eventsPath)}-${stamp(join(board.store.dir, "config.json"))}-${board.store.errorCount()}"`;
}

/** Everything the page shows, as plain JSON. Judgments are still derived by fold, never here. */
export function webState(board: Board) {
  const { events, state } = board.load();
  const config = board.store.readConfig();
  const forUser = new Set(questionsForUser(state).map((q) => q.qid));
  return {
    project: basename(board.store.root),
    root: board.store.root,
    errors: board.store.errorCount(),
    config,
    slots: [...state.slots.values()].map((s) => ({
      ...s,
      topics: slotTopics(s, config.topics),
      dependents: dependentsOf(state, s.key).map((d) => d.key),
    })),
    tasks: [...state.tasks.values()],
    questions: [...state.questions.values()].map((q) => ({ ...q, forUser: forUser.has(q.qid) })),
    sessions: [...state.sessions.values()],
    events,
  };
}

export interface WebOptions {
  port?: number;
  host?: string;
}

/** Read-only local server. With no explicit port, walks forward from the default until one is free. */
export function startWeb(board: Board, opts: WebOptions = {}): Promise<{ server: Server; url: string }> {
  const host = opts.host ?? "127.0.0.1";
  const server = createServer((req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405).end();
      } else if (path === "/api/state") {
        const etag = stateVersion(board);
        if (req.headers["if-none-match"] === etag) {
          res.writeHead(304, { ETag: etag }).end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache", ETag: etag });
        res.end(JSON.stringify(webState(board)));
      } else if (path === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
        res.end(readFileSync(PAGE));
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      }
    } catch (err) {
      board.store.logError("web", err);
      res.writeHead(500, { "Content-Type": "text/plain" }).end("slotboard error; see .project/run/errors.log");
    }
  });

  const fixed = opts.port !== undefined;
  let port = opts.port ?? 4717;
  return new Promise((resolve, reject) => {
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && !fixed && port < 4737) server.listen(++port, host);
      else reject(err);
    });
    server.on("listening", () => {
      const addr = server.address();
      const p = typeof addr === "object" && addr ? addr.port : port;
      resolve({ server, url: `http://${host === "0.0.0.0" ? "localhost" : host}:${p}/` });
    });
    server.listen(port, host);
  });
}

export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}
