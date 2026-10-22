import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { basename, join } from "node:path";
import { slotTopics } from "./analyze.js";
import { FixableError, HUMAN_ACTIONS, type Board, type HumanAction } from "./board.js";
import { dependentsOf } from "./fold.js";
import { questionsForUser } from "./report.js";
import { duplicatePairs } from "./similar.js";

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
    duplicates: duplicatePairs(state).map((d) => ({ a: d.a.key, b: d.b.key })),
    events,
  };
}

export interface WebOptions {
  port?: number;
  host?: string;
}

const MAX_BODY = 64 * 1024;

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new FixableError("Request too large.")); req.destroy(); } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Local server for the page. Writes need the token baked into the served page and a localhost Host header,
 * so other websites open in the same browser can't post actions to it (CSRF, DNS rebinding).
 * With no explicit port, walks forward from the default until one is free.
 */
export function startWeb(board: Board, opts: WebOptions = {}): Promise<{ server: Server; url: string; token: string }> {
  const host = opts.host ?? "127.0.0.1";
  const token = randomBytes(18).toString("base64url");
  const json = (res: import("node:http").ServerResponse, code: number, body: unknown) =>
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify(body));
  const localHost = (h: string | undefined) => {
    const p = (server.address() as { port: number } | null)?.port;
    return !!h && [`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`].includes(h);
  };

  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      if (!localHost(req.headers.host)) {
        res.writeHead(421, { "Content-Type": "text/plain" }).end("slotledger web only answers on localhost");
      } else if (req.method === "POST" && path === "/api/action") {
        const origin = req.headers.origin;
        if (req.headers["x-slotledger-token"] !== token || (origin && origin !== `http://${req.headers.host}`)) {
          json(res, 403, { error: "This page is out of date; reload it." });
          return;
        }
        if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
          json(res, 415, { error: "Expected JSON." });
          return;
        }
        let input: HumanAction;
        try { input = JSON.parse(await readBody(req)); } catch (err) {
          json(res, 400, { error: err instanceof FixableError ? err.message : "Malformed request." });
          return;
        }
        if (!input || !(HUMAN_ACTIONS as readonly string[]).includes(input.action)) {
          json(res, 400, { error: "Unknown action." });
          return;
        }
        try {
          json(res, 200, { message: board.human(input) });
        } catch (err) {
          if (err instanceof FixableError) json(res, 400, { error: err.message });
          else throw err;
        }
      } else if (req.method !== "GET" && req.method !== "HEAD") {
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
        res.end(readFileSync(PAGE, "utf8").replace("__SLOTLEDGER_TOKEN__", token));
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      }
    } catch (err) {
      board.store.logError("web", err);
      res.writeHead(500, { "Content-Type": "text/plain" }).end("slotledger error; see .project/run/errors.log");
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
      resolve({ server, url: `http://${host === "0.0.0.0" ? "localhost" : host}:${p}/`, token });
    });
    server.listen(port, host);
  });
}

export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}
