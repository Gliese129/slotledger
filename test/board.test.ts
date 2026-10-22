import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Board, FixableError } from "../src/board.js";
import { Store, shortHash } from "../src/store.js";
import { startWeb } from "../src/web.js";
import { validateSettings, writeSettings } from "../src/settings.js";

let root: string;
let board: Board;
const client = { name: "test", version: "0" };

function git(...args: string[]) {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}
function write(path: string, content: string) {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
}
function start(session: string) {
  board.ensureSession(session, client);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "slotledger-test-"));
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  write("src/main.ts", "export {}\n");
  write(".project/config.json", JSON.stringify({ topics: [{ id: "sync", paths: ["src/sync/**"] }], acceptAfterSessions: 3 }));
  git("add", "-A");
  git("commit", "-qm", "init");
  board = new Board(new Store(root));
});

function seedWindowsWorld() {
  start("s1");
  board.record("s1", { key: "assum/user-os", value: "Users are all on Windows", rationale: "From interviews", userQuote: "our users are all on Windows" });
  board.record("s1", { key: "approach/sync-backend", value: "OneDrive", rationale: "Users are on Windows, which ships OneDrive", depends: ["assum/user-os"], userQuote: "OneDrive then" });
  board.record("s1", { key: "env/target-os", value: "Windows 10+", rationale: "Follow the users' OS", depends: ["assum/user-os"] });
}

describe("slots and staleness", () => {
  it("implementation details get no slot", () => {
    start("s1");
    expect(board.record("s1", { key: "impl/rename-var", value: "x", rationale: "y" })).toContain("Nothing recorded");
    expect(board.load().state.slots.size).toBe(0);
  });

  it("a changed premise marks dependents stale, and arch goes to Needs your call", () => {
    seedWindowsWorld();
    start("s2");
    const msg = board.record("s2", { key: "assum/user-os", value: "Users are actually on macOS", rationale: "User corrected it", userQuote: "users are actually on macOS" });
    expect(msg).toContain("These rest on it and now need review: approach/sync-backend, env/target-os");
    expect(msg).toContain('record({ key: "assum/user-os", unaffected:');

    const { state } = board.load();
    expect(state.slots.get("approach/sync-backend")!.stale).toEqual([{ key: "assum/user-os", locked: 1, current: 2 }]);

    const r = board.stop("s2", true);
    expect(r.message).toContain("Needs your call (1;");
    expect(r.message).toContain("approach/sync-backend");
    expect(r.message).toContain('Just reply "1A"');
  });

  it("non-arch/product staleness is reviewed by the AI: Stop nudges once", () => {
    seedWindowsWorld();
    start("s2");
    board.record("s2", { key: "assum/user-os", value: "macOS", rationale: "Correction", userQuote: "it's actually macOS" });
    const first = board.stop("s2", false);
    expect(first.block).toContain("env/target-os");
    // the same content is not nudged again
    expect(board.stop("s2", false).block).toBeUndefined();
  });

  it("overriding a user's arch decision stops unless userQuote is given", () => {
    seedWindowsWorld();
    start("s2");
    expect(() => board.record("s2", { key: "approach/sync-backend", value: "iCloud", rationale: "Smoother on macOS" })).toThrow(FixableError);
    expect(board.record("s2", { key: "approach/sync-backend", value: "iCloud", rationale: "User agreed", depends: ["assum/user-os"], userQuote: "switch to iCloud" })).toContain("v2");
  });

  it("respond 1A: confirms it still holds, locks the new dependency version, clears stale", () => {
    seedWindowsWorld();
    start("s2");
    board.record("s2", { key: "assum/user-os", value: "macOS", rationale: "Correction", userQuote: "it's actually macOS" });
    board.stop("s2", true);
    expect(board.respond("s2", { item: 1, choice: "A", userQuote: "1A" })).toContain("still holds");
    const { state } = board.load();
    const slot = state.slots.get("approach/sync-backend")!;
    expect(slot.stale).toEqual([]);
    // still holding is not a new decision: no new version, nothing downstream changes
    expect(slot.versions).toHaveLength(1);
    expect(slot.current!.depends).toEqual([{ key: "assum/user-os", n: 2 }]);
    expect(slot.current!.status).toBe("decided");
    expect(slot.current!.reviews).toMatchObject([{ by: "user" }]);
  });

  it("an unchanged value is not recorded again", () => {
    seedWindowsWorld();
    expect(board.record("s1", { key: "env/target-os", value: "Windows 10+", rationale: "Same" })).toContain("is unchanged");
  });

  it("accepted by default after N sessions without rejection", () => {
    start("s1");
    board.record("s1", { key: "goal/autostart", value: "Off by default", rationale: "Conservative" });
    for (const s of ["s2", "s3"]) start(s);
    expect(board.load().state.slots.get("goal/autostart")!.current!.status).toBe("proposed");
    start("s4");
    expect(board.load().state.slots.get("goal/autostart")!.current!.status).toBe("accepted_by_default");
  });

  it("withdraws a decision made for the user, with a replacement", () => {
    start("s1");
    board.record("s1", { key: "goal/autostart", value: "On by default", rationale: "Convenient" });
    const r = board.stop("s1", true);
    expect(r.message).toContain("Decisions I made for you");
    board.respond("s1", { item: 1, withdraw: true, text: "Off by default", userQuote: "withdraw 1, keep it off" });
    const v = board.load().state.slots.get("goal/autostart")!.current!;
    expect(v.value).toBe("Off by default");
    expect(v.source).toBe("user");
  });
});

describe("change analysis", () => {
  it("topic code changed with nothing recorded: nudge the AI first, then tell the user", () => {
    start("s1");
    write("src/sync/icloud.ts", "export const backend = 'icloud'\n");
    const first = board.stop("s1", false);
    expect(first.block).toContain("topic sync");
    const second = board.stop("s1", true);
    expect(second.message).toContain("Code for sync changed");
  });

  it("recording a related slot counts as declared (topic inferred from the key name)", () => {
    start("s1");
    write("src/sync/icloud.ts", "x\n");
    board.record("s1", { key: "approach/sync-backend", value: "iCloud", rationale: "Try it" });
    expect(board.stop("s1", false).block ?? "").not.toContain("topic sync");
  });

  it("uncommitted changes from before the session don't count toward it", () => {
    write("src/sync/dirty.ts", "x\n");
    start("s1");
    expect(board.stop("s1", false).block).toBeUndefined();
  });

  it("when another session works in the same folder, changed files go to the user instead of blocking the AI", async () => {
    start("s1");
    await new Promise((r) => setTimeout(r, 5));
    // another session finishes a turn in this working tree and leaves its edits
    board.activity("other-session");
    write("src/sync/icloud.ts", "export const backend = 'icloud'\n");
    board.stop("other-session", false);
    // nothing to nudge the AI about, so the report goes straight to the user
    const first = board.stop("s1", false);
    expect(first.block).toBeUndefined();
    const report = first.message ?? "";
    expect(report).toContain("Code for sync changed");
    expect(report).toContain("Another session (other-se) was working in this folder at the same time");
  });

  it("a session that was only active before this one started doesn't count", async () => {
    board.activity("earlier");
    board.stop("earlier", true);
    await new Promise((r) => setTimeout(r, 5));
    start("s1");
    write("src/sync/icloud.ts", "x\n");
    expect(board.stop("s1", false).block).toContain("topic sync");
  });

  it("new documents are pointed out; STATUS.md doesn't count", () => {
    start("s1");
    write("PLAN.md", "# plan\n");
    expect(board.stop("s1", false).block).toContain("PLAN.md");
    expect(board.stop("s1", true).message).toContain("New documents this session: PLAN.md");
  });
});

describe("tasks and verification", () => {
  it("verify runs in the server and a failure leaves the status alone", () => {
    start("s1");
    board.task("s1", { slug: "add-sync", title: "Add sync", status: "implemented" });
    expect(() => board.task("s1", { slug: "add-sync", status: "verified" as any })).toThrow(FixableError);
    expect(board.verify("s1", { slug: "add-sync", cmd: "exit 3" })).toContain("Failed");
    expect(board.load().state.tasks.get("add-sync")!.status).toBe("implemented");
    expect(board.verify("s1", { slug: "add-sync", cmd: "echo ok" })).toContain("Passed");
    expect(board.load().state.tasks.get("add-sync")!.status).toBe("verified");
    expect(readFileSync(join(root, "STATUS.md"), "utf8")).toContain("run: `echo ok` passed");
  });

  it("a task follows the review of a decision whose premise changed, instead of asking for its own", () => {
    seedWindowsWorld();
    board.task("s1", { slug: "msi-installer", title: "Build the MSI installer", basedOn: ["env/target-os"] });
    start("s2");
    const msg = board.record("s2", { key: "assum/user-os", value: "macOS", rationale: "Correction", userQuote: "it's actually macOS" });
    expect(msg).not.toContain("Possible premises: env/target-os");
    let t = board.load().state.tasks.get("msi-installer")!;
    expect(t.status).toBe("todo");
    expect(t.waitingOn).toEqual(["env/target-os"]);
    expect(board.brief()).toContain("msi-installer [todo] Build the MSI installer (waiting on review of env/target-os)");

    // the decision still holds: the task needs nothing
    expect(board.record("s2", { key: "env/target-os", value: "Windows 10+", rationale: "Enterprise customers stay on Windows" })).toContain("no new version");
    t = board.load().state.tasks.get("msi-installer")!;
    expect(t.waitingOn).toEqual([]);
    expect(t.status).toBe("todo");

    // the decision gets a new value: now the task is reviewed itself
    board.record("s2", { key: "env/target-os", value: "macOS 14+", rationale: "Follow the users' OS" });
    t = board.load().state.tasks.get("msi-installer")!;
    expect(t.status).toBe("needs_review");
    expect(t.needsReview).toEqual([{ key: "env/target-os", locked: 1, current: 2 }]);
  });

  it("a task needs review when a decision it is based on changes", () => {
    seedWindowsWorld();
    board.task("s1", { slug: "msi-installer", title: "Build the MSI installer", basedOn: ["env/target-os"] });
    start("s2");
    board.record("s2", { key: "env/target-os", value: "macOS 13+", rationale: "Users are on macOS", userQuote: "make a mac version" });
    expect(board.load().state.tasks.get("msi-installer")!.needsReview).toHaveLength(1);
    expect(board.brief()).toContain("msi-installer [needs_review] Build the MSI installer (changed: env/target-os)");
  });
});

describe("web view", () => {
  it("serves the page and live state, with 304 until events change", async () => {
    seedWindowsWorld();
    start("s2");
    board.record("s2", { key: "assum/user-os", value: "macOS", rationale: "Correction", userQuote: "it's actually macOS" });
    const { server, url } = await startWeb(board, { port: 0 });
    try {
      const page = await fetch(url);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("<title>slotledger</title>");

      const r = await fetch(url + "api/state");
      const etag = r.headers.get("etag")!;
      const body = await r.json();
      const sync = body.slots.find((s: any) => s.key === "approach/sync-backend");
      expect(sync.stale).toEqual([{ key: "assum/user-os", locked: 1, current: 2 }]);
      expect(body.slots.find((s: any) => s.key === "assum/user-os").dependents).toEqual(["approach/sync-backend", "env/target-os"]);
      expect(body.questions.filter((q: any) => q.forUser).map((q: any) => q.about[0])).toEqual(["approach/sync-backend"]);

      expect((await fetch(url + "api/state", { headers: { "If-None-Match": etag } })).status).toBe(304);
      board.task("s2", { slug: "x", title: "X" });
      expect((await fetch(url + "api/state", { headers: { "If-None-Match": etag } })).status).toBe(200);
      expect((await fetch(url + "nope")).status).toBe(404);
    } finally {
      server.close();
    }
  });
});

describe("recording settings", () => {
  it("until language and strictness are set, brief asks the AI to ask the user", () => {
    const brief = board.brief();
    expect(brief).toContain("language and strictness not set");
    expect(brief).toContain("Which language should decisions");
    expect(brief).toContain("config --language");
    writeSettings(root, { language: "中文", strictness: "strict" });
    const after = board.brief();
    expect(after).not.toContain("not set");
    expect(after).toContain("write slot values, rationales, task titles and questions in 中文");
    expect(after).toContain("Strictness: strict");
  });

  it("writeSettings keeps topics and rejects unknown strictness", () => {
    writeSettings(root, { strictness: "loose" });
    const cfg = new Store(root).readConfig();
    expect(cfg.topics).toHaveLength(1);
    expect(cfg.strictness).toBe("loose");
    expect(validateSettings({ strictness: "medium" })).toContain("strict, balanced, loose");
  });

  it("loose never interrupts the AI; findings go to the report", () => {
    writeSettings(root, { language: "English", strictness: "loose" });
    start("s1");
    write("src/sync/icloud.ts", "x\n");
    const r = board.stop("s1", false);
    expect(r.block).toBeUndefined();
    expect(r.message).toContain("sync");
  });

  it("strict nudges about implemented but unverified tasks", () => {
    start("s1");
    board.task("s1", { slug: "add-sync", title: "Add sync", status: "implemented" });
    expect(board.stop("s1", false).block).toBeUndefined();
    writeSettings(root, { language: "English", strictness: "strict" });
    start("s2");
    expect(board.stop("s2", false).block).toContain("add-sync is implemented but not verified");
  });
});

describe("export", () => {
  it("markdown lists live decisions, team questions and tasks under stable headings", () => {
    seedWindowsWorld();
    board.task("s1", { slug: "add-sync", title: "Add sync", basedOn: ["approach/sync-backend"] });
    board.record("s1", { key: "dep/old-lib", value: "old", rationale: "r" });
    board.record("s1", { key: "dep/old-lib", value: "old", rationale: "r", retired: true });
    start("s2");
    board.record("s2", { key: "assum/user-os", value: "Users are on macOS", rationale: "Corrected", userQuote: "macOS actually" });

    const md = board.export();
    expect(md).toContain("### approach/sync-backend");
    expect(md).toContain("- Depends on: assum/user-os v1 ⚠ premise changed (now v2)");
    expect(md).toContain(`- User's words: "OneDrive then"`);
    expect(md).toContain(`- History: v1 "Users are all on Windows" → v2 "Users are on macOS"`);
    expect(md).not.toContain("dep/old-lib");
    // arch's stale premise needs the user; platform's is the AI's to review
    const qid = [...board.load().state.questions.values()].find((q) => q.premise?.slot === "approach/sync-backend")!.qid;
    expect(md).toContain(`### ${qid}`);
    expect(md.match(/^### sq-/gm)).toHaveLength(1);
    expect(md).toContain("### add-sync");
    expect(md).toContain("- Status: todo (waiting on review of approach/sync-backend)");
    expect(md).toContain(`(event ${board.store.readEvents().at(-1)!.id})`);
  });

  it("json carries the same entries, and an empty board still exports", () => {
    expect(board.export()).toContain("## Decisions\n\n(none)");
    seedWindowsWorld();
    const x = JSON.parse(board.export("json"));
    expect(x.decisions.map((d: { key: string }) => d.key)).toEqual(["approach/sync-backend", "env/target-os", "assum/user-os"]);
    expect(x.decisions[0]).toMatchObject({ version: 1, status: "decided", source: "user", depends: [{ key: "assum/user-os", n: 1, current: 1 }] });
    expect(x.asOf.event).toBe(board.store.readEvents().at(-1)!.id);
  });
});

describe("finding and merging keys", () => {
  it("holds back a new key that looks like an existing one, and new: true goes through", () => {
    seedWindowsWorld();
    let msg = "";
    try { board.record("s1", { key: "approach/sync-provider", value: "OneDrive", rationale: "Ships with Windows" }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("Not recorded yet");
    expect(msg).toContain("approach/sync-backend");
    expect(board.load().state.slots.has("approach/sync-provider")).toBe(false);
    expect(board.record("s1", { key: "approach/sync-provider", value: "OneDrive", rationale: "Ships with Windows", new: true })).toContain("Recorded approach/sync-provider v1");
  });

  it("does not hold back distinct decisions or new versions of an existing key", () => {
    seedWindowsWorld();
    expect(board.record("s1", { key: "goal/autostart", value: "Off by default", rationale: "Conservative" })).toContain("Recorded");
    expect(board.record("s1", { key: "env/target-os", value: "Windows 11", rationale: "Drop 10" })).toContain("v2");
  });

  it("replaces retires the old key and re-points its dependents without demoting them", () => {
    seedWindowsWorld();
    board.record("s1", { key: "goal/offline-mode", value: "Works offline, syncs later", rationale: "Sync is optional", depends: ["approach/sync-backend"], userQuote: "offline first" });
    board.task("s1", { slug: "onedrive-client", title: "OneDrive client", basedOn: ["approach/sync-backend"] });
    // approach/sync-backend is the user's arch decision, so merging it away needs their words
    expect(() => board.record("s1", { key: "approach/cloud-sync", value: "OneDrive", rationale: "Same decision", replaces: ["approach/sync-backend"] })).toThrow(FixableError);
    const msg = board.record("s1", { key: "approach/cloud-sync", value: "OneDrive", rationale: "Same decision", depends: ["assum/user-os"], replaces: ["approach/sync-backend"], userQuote: "merge them" });
    expect(msg).toContain("Retired approach/sync-backend as merged into approach/cloud-sync");
    expect(msg).toContain("goal/offline-mode");
    expect(msg).toContain("onedrive-client");

    const { state } = board.load();
    const old = state.slots.get("approach/sync-backend")!.current!;
    expect(old.retired).toBe(true);
    expect(old.replacedBy).toBe("approach/cloud-sync");
    const offline = state.slots.get("goal/offline-mode")!;
    expect(offline.current!.depends).toEqual([{ key: "approach/cloud-sync", n: 1 }]);
    expect(offline.stale).toEqual([]);
    expect(offline.current!.status).toBe("decided");
    expect(offline.current!.value).toBe("Works offline, syncs later");
  });

  it("a re-pointed proposal keeps counting sessions from when it was first proposed", () => {
    start("s1");
    board.record("s1", { key: "approach/cache", value: "In-memory LRU", rationale: "Simple" });
    board.record("s1", { key: "goal/fast-start", value: "Start under 1s", rationale: "Cache helps", depends: ["approach/cache"] });
    for (const s of ["s2", "s3"]) start(s);
    board.record("s3", { key: "approach/memory-cache", value: "In-memory LRU", rationale: "Same", replaces: ["approach/cache"] });
    start("s4");
    expect(board.load().state.slots.get("goal/fast-start")!.current!.status).toBe("accepted_by_default");
  });

  it("brief({ query }) finds live and retired slots; brief lists likely duplicates", () => {
    seedWindowsWorld();
    board.record("s1", { key: "approach/sync-provider", value: "OneDrive sync", rationale: "x", new: true });
    expect(board.brief()).toContain("## Possible duplicates");
    board.record("s1", { key: "approach/sync-provider", value: "OneDrive sync", rationale: "x", replaces: ["approach/sync-backend"], userQuote: "merge" });
    const found = board.brief("onedrive");
    expect(found).toContain("approach/sync-provider v");
    expect(found).toContain("approach/sync-backend v2 \"OneDrive\" (retired, merged into approach/sync-provider)");
    expect(board.brief()).not.toContain("## Possible duplicates");
    expect(board.brief("nothing like this")).toContain("Nothing matches");
  });
});

describe("human actions in the web view", () => {
  it("approve and reject AI proposals, tagged human-approved / human-rejected", () => {
    start("s1");
    board.record("s1", { key: "goal/autostart", value: "On by default", rationale: "Convenient" });
    board.record("s1", { key: "goal/tray-icon", value: "Show a tray icon", rationale: "Discoverable" });
    expect(board.human({ action: "approve", key: "goal/autostart" })).toContain("Approved");
    board.human({ action: "reject", key: "goal/tray-icon", reason: "No tray on macOS" });
    const { state } = board.load();
    const a = state.slots.get("goal/autostart")!.current!;
    expect([a.status, a.tag]).toEqual(["decided", "human-approved"]);
    const t = state.slots.get("goal/tray-icon")!;
    expect(t.current).toBeUndefined();
    expect(t.versions[0].tag).toBe("human-rejected");
    expect(board.brief()).toContain("(decided, human-approved)");
    expect(() => board.human({ action: "reject", key: "goal/autostart" })).toThrow(FixableError);
  });

  it("edit writes a user version tagged human-edit; a user decision via the AI is human-decided", () => {
    seedWindowsWorld();
    expect(board.load().state.slots.get("approach/sync-backend")!.current!.tag).toBe("human-decided");
    board.human({ action: "edit", key: "approach/sync-backend", value: "iCloud", rationale: "Mac users" });
    const v = board.load().state.slots.get("approach/sync-backend")!.current!;
    expect([v.n, v.value, v.source, v.tag]).toEqual([2, "iCloud", "user", "human-edit"]);
    expect(v.depends).toEqual([{ key: "assum/user-os", n: 1 }]);
  });

  it("keep confirms a decision whose premise changed, as human-decided", () => {
    seedWindowsWorld();
    start("s2");
    board.record("s2", { key: "assum/user-os", value: "macOS", rationale: "Correction", userQuote: "it's actually macOS" });
    board.human({ action: "keep", key: "approach/sync-backend" });
    const s = board.load().state.slots.get("approach/sync-backend")!;
    expect(s.stale).toEqual([]);
    expect(s.current!.tag).toBe("human-decided");
    expect(s.versions).toHaveLength(1);
  });

  it("delete hides the slot from everything the AI sees; the key starts over cleanly", () => {
    seedWindowsWorld();
    board.human({ action: "delete", key: "env/target-os" });
    const brief = board.brief();
    expect(brief).not.toContain("env/target-os");
    expect(board.brief("windows")).not.toContain("env/target-os");
    expect(readFileSync(join(root, "STATUS.md"), "utf8")).not.toContain("Windows 10+");
    // the AI can use the key again without being told what was there; numbering continues so old locks go stale
    const msg = board.record("s1", { key: "env/target-os", value: "macOS 13+", rationale: "Mac users" });
    expect(msg).toContain("Recorded env/target-os v2");
    expect(msg).not.toContain("Windows 10+");
    expect(board.load().state.slots.get("env/target-os")!.versions.length).toBe(2);
  });

  it("dependents of a deleted slot are flagged", () => {
    seedWindowsWorld();
    board.human({ action: "delete", key: "assum/user-os" });
    const q = [...board.load().state.questions.values()].find((q) => q.about[0] === "approach/sync-backend")!;
    expect(q.text).toContain("assum/user-os, which it depends on, was deleted");
  });

  it("answers a question from the web", () => {
    seedWindowsWorld();
    start("s2");
    board.record("s2", { key: "assum/user-os", value: "macOS", rationale: "Correction", userQuote: "it's actually macOS" });
    const q = [...board.load().state.questions.values()].find((q) => q.about[0] === "approach/sync-backend")!;
    expect(board.human({ action: "answer", question: q.qid, choice: "A" })).toContain("still holds");
    expect(board.load().state.slots.get("approach/sync-backend")!.stale).toEqual([]);
  });

  it("the action endpoint needs the page token and a localhost Host", async () => {
    start("s1");
    board.record("s1", { key: "goal/autostart", value: "On by default", rationale: "Convenient" });
    const { server, url, token } = await startWeb(board, { port: 0 });
    try {
      expect(await (await fetch(url)).text()).toContain(token);
      const post = (headers: Record<string, string>, body: unknown = { action: "approve", key: "goal/autostart" }) =>
        fetch(url + "api/action", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
      expect((await post({})).status).toBe(403);
      expect((await post({ "X-Slotledger-Token": token, Origin: "https://evil.example" })).status).toBe(403);
      expect((await post({ "X-Slotledger-Token": token }, { action: "drop-table" })).status).toBe(400);
      const ok = await post({ "X-Slotledger-Token": token });
      expect(ok.status).toBe(200);
      expect((await ok.json()).message).toContain("Approved");
      const bad = await post({ "X-Slotledger-Token": token }, { action: "edit", key: "goal/nope", value: "x" });
      expect([bad.status, (await bad.json()).error]).toEqual([400, "goal/nope doesn't exist any more."]);
    } finally {
      server.close();
    }
  });
});

describe("legacy category names", () => {
  it("old events and old prefixes in input land on the same slot under the new name", () => {
    start("s1");
    // a log written before the rename
    board.store.append("slot.versioned", { kind: "agent", session: "s1" }, { key: "platform/target-os" as any, value: "Windows 10+", rationale: "Users' OS", depends: [], topics: [] });
    board.store.append("slot.versioned", { kind: "agent", session: "s1" }, { key: "arch/sync-backend" as any, value: "OneDrive", rationale: "Ships with Windows", depends: [{ key: "platform/target-os" as any, n: 1 }], topics: [], userQuote: "OneDrive then" });
    const { state } = board.load();
    expect([...state.slots.keys()].sort()).toEqual(["approach/sync-backend", "env/target-os"]);
    expect(state.slots.get("approach/sync-backend")!.current!.depends).toEqual([{ key: "env/target-os", n: 1 }]);

    expect(board.record("s1", { key: "platform/target-os", value: "macOS 13+", rationale: "Users moved", userQuote: "mac now" })).toContain("Recorded env/target-os v2");
    expect(board.load().state.slots.get("approach/sync-backend")!.stale).toEqual([{ key: "env/target-os", locked: 1, current: 2 }]);
    // guarded under its new name: changing the user's approach without their words is refused
    expect(() => board.record("s1", { key: "arch/sync-backend", value: "iCloud", rationale: "Mac" })).toThrow(FixableError);
    board.task("s1", { slug: "mac-build", title: "Mac build", basedOn: ["platform/target-os"] });
    expect(board.load().state.tasks.get("mac-build")!.basedOn).toEqual([{ key: "env/target-os", n: 2 }]);
    expect(board.brief("arch/sync-backend")).toContain("approach/sync-backend");
  });

  it("stale-premise question ids don't change with the rename, so old answers still count", () => {
    start("s1");
    board.store.append("slot.versioned", { kind: "agent", session: "s1" }, { key: "assum/user-os", value: "Windows", rationale: "Interviews", depends: [], topics: [], userQuote: "Windows" });
    board.store.append("slot.versioned", { kind: "agent", session: "s1" }, { key: "product/tray-icon" as any, value: "On", rationale: "Windows has a tray", depends: [{ key: "assum/user-os", n: 1 }], topics: [], userQuote: "tray on" });
    board.store.append("slot.versioned", { kind: "agent", session: "s1" }, { key: "assum/user-os", value: "macOS", rationale: "Correction", depends: [], topics: [], userQuote: "macOS" });
    const q = [...board.load().state.questions.values()][0];
    expect(q.about).toEqual(["goal/tray-icon", "assum/user-os"]);
    // the id an older slotledger gave this question, which the user answered
    expect(q.qid).toBe("sq-" + shortHash("product/tray-icon@1|assum/user-os@2"));
    board.store.append("question.answered", { kind: "human", via: "s1" }, { qid: q.qid, option: "B", userQuote: "rethink it" });
    expect(board.load().state.questions.get(q.qid)!.status).toBe("answered");
  });
});

describe("evidence sources", () => {
  it("ref evidence hashes local files, flags missing paths, and keeps IDs and URLs as given", () => {
    start("s1");
    board.task("s1", { slug: "model-eval", title: "Evaluate the model on the held-out set", status: "implemented" });
    write("reports/eval.md", "accuracy 0.93\n");
    const msg = board.verify("s1", { slug: "model-eval", refs: ["reports/eval.md", "reports/missing.json", "slurm job 1234", "https://example.com/run/9"], summary: "accuracy above target", metrics: { samples: 500, accuracy: 0.93 }, passed: true });
    expect(msg).toContain("(by reference: the pass is your report");
    expect(msg).toContain("model-eval is now verified");
    expect(msg).toContain("Not found in the project: reports/missing.json");
    const t = board.load().state.tasks.get("model-eval")!;
    expect(t.status).toBe("verified");
    expect(t.evidence).toMatchObject({ kind: "ref", summary: "accuracy above target", metrics: { samples: 500, accuracy: 0.93 } });
    const refs = (t.evidence as any).refs;
    expect(refs[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(refs[1]).toEqual({ target: "reports/missing.json", missing: true });
    expect(refs[2]).toEqual({ target: "slurm job 1234" });
    expect(refs[3]).toEqual({ target: "https://example.com/run/9" });
    expect(readFileSync(join(root, "STATUS.md"), "utf8")).toContain("ref: reported passing, accuracy above target");
  });

  it("human evidence keeps the person's words and scope, and a failing check doesn't change the status", () => {
    start("s1");
    board.task("s1", { slug: "icloud-sync", title: "iCloud sync on device", status: "implemented" });
    expect(board.verify("s1", { slug: "icloud-sync", userQuote: "sync didn't show up on the Mac", scope: "iPhone 15 + MacBook", passed: false })).toContain("didn't accept");
    expect(board.load().state.tasks.get("icloud-sync")!.status).toBe("implemented");
    board.verify("s1", { slug: "icloud-sync", userQuote: "works on both now", scope: "iPhone 15 + MacBook", passed: true });
    const { events, state } = board.load();
    expect(state.tasks.get("icloud-sync")!.evidence).toMatchObject({ kind: "human", userQuote: "works on both now", scope: "iPhone 15 + MacBook" });
    expect(events.at(-1)!.actor).toEqual({ kind: "human", via: "s1" });
    expect(board.stop("s1", true).message ?? "").toContain("icloud-sync (accepted by the user)");
  });

  it("takes exactly one kind of evidence, and ref/human must say whether it passed", () => {
    start("s1");
    board.task("s1", { slug: "t", title: "T" });
    expect(() => board.verify("s1", { slug: "t" })).toThrow(FixableError);
    expect(() => board.verify("s1", { slug: "t", cmd: "true", userQuote: "ok", passed: true })).toThrow(FixableError);
    expect(() => board.verify("s1", { slug: "t", refs: ["x"], summary: "s" })).toThrow(/passed/);
    expect(() => board.verify("s1", { slug: "t", refs: ["x"], passed: true })).toThrow(/summary/);
  });

  it("a person can accept a task in the web view", () => {
    start("s1");
    board.task("s1", { slug: "draft", title: "Chapter 2 draft", status: "implemented" });
    expect(board.human({ action: "check", task: "draft", passed: true, scope: "sections 2.1–2.3", text: "reads well" })).toContain("accepted");
    const t = board.load().state.tasks.get("draft")!;
    expect(t.status).toBe("verified");
    expect(t.evidence).toMatchObject({ kind: "human", userQuote: "Accepted in the web view: reads well", scope: "sections 2.1–2.3" });
  });
});

describe("task status and review", () => {
  function verifiedMsi() {
    seedWindowsWorld();
    board.task("s1", { slug: "msi-installer", title: "Build the MSI installer", basedOn: ["env/target-os"], status: "implemented" });
    board.verify("s1", { slug: "msi-installer", cmd: "true" });
    start("s2");
    board.record("s2", { key: "env/target-os", value: "Windows 11", rationale: "Drop 10", userQuote: "11 only" });
  }

  it("a verified task drops to needs_review when its basis changes; the old pass is history", () => {
    verifiedMsi();
    const t = board.load().state.tasks.get("msi-installer")!;
    expect(t.status).toBe("needs_review");
    expect(t.progress).toBe("verified");
    expect(readFileSync(join(root, "STATUS.md"), "utf8")).toContain("passed before decisions changed: run: `true` passed");
    expect(board.stop("s2", false).block).toContain('confirm it still holds with task({ slug: "msi-installer", basedOn: ["env/target-os"]');
    expect(() => board.task("s2", { slug: "msi-installer", status: "needs_review" as any })).toThrow(FixableError);
  });

  it("confirming re-locks basedOn with a note and returns to the earlier status", () => {
    verifiedMsi();
    expect(() => board.task("s2", { slug: "msi-installer", basedOn: ["env/target-os"] })).toThrow(/note/);
    expect(board.task("s2", { slug: "msi-installer", basedOn: ["platform/target-os"], note: "MSI works on 11 too" })).toContain("now based on env/target-os@2");
    const t = board.load().state.tasks.get("msi-installer")!;
    expect(t.status).toBe("verified");
    expect(t.basedOn).toEqual([{ key: "env/target-os", n: 2 }]);
  });

  it("a passing re-verification re-locks basedOn; a failing one doesn't", () => {
    verifiedMsi();
    board.verify("s2", { slug: "msi-installer", cmd: "exit 1" });
    expect(board.load().state.tasks.get("msi-installer")!.status).toBe("needs_review");
    expect(board.verify("s2", { slug: "msi-installer", cmd: "true" })).toContain("msi-installer is now verified");
    expect(board.load().state.tasks.get("msi-installer")!.basedOn).toEqual([{ key: "env/target-os", n: 2 }]);
  });

  it("a task waiting on a decision's review can be verified, and keeps following that review", () => {
    seedWindowsWorld();
    board.task("s1", { slug: "msi-installer", title: "Build the MSI installer", basedOn: ["env/target-os"] });
    start("s2");
    board.record("s2", { key: "assum/user-os", value: "macOS", rationale: "Correction", userQuote: "macOS" });
    expect(board.verify("s2", { slug: "msi-installer", cmd: "true" })).toContain("msi-installer is now verified. It still follows the review of env/target-os");
    board.record("s2", { key: "env/target-os", value: "macOS 14+", rationale: "Follow the users' OS" });
    expect(board.load().state.tasks.get("msi-installer")!.status).toBe("needs_review");
  });

  it("dropping ends review, and a dropped task shows as dropped", () => {
    verifiedMsi();
    board.task("s2", { slug: "msi-installer", status: "dropped", note: "Mac only now" });
    expect(board.load().state.tasks.get("msi-installer")!.status).toBe("dropped");
  });
});

describe("review propagation", () => {
  it("confirming a decision still holds keeps it the user's and stops the chain there", () => {
    seedWindowsWorld();
    board.record("s1", { key: "approach/installer", value: "MSI", rationale: "Windows installer", depends: ["env/target-os"] });
    board.task("s1", { slug: "build-msi", title: "Build the MSI", basedOn: ["approach/installer"] });
    start("s2");
    board.record("s2", { key: "assum/user-os", value: "Mostly Windows, some Linux", rationale: "Survey", userQuote: "mostly Windows" });
    // the user's decision is re-confirmed by the AI: still the user's, still v1
    board.record("s2", { key: "approach/sync-backend", value: "OneDrive", rationale: "Linux users can use the web client" });
    board.record("s2", { key: "env/target-os", value: "Windows 10+", rationale: "Linux is a small minority" });
    const { state } = board.load();
    const sync = state.slots.get("approach/sync-backend")!;
    expect(sync.versions).toHaveLength(1);
    expect(sync.current!.status).toBe("decided");
    expect(sync.current!.tag).toBe("human-decided");
    // nothing two steps away asks for anything
    expect(state.slots.get("approach/installer")!.stale).toEqual([]);
    expect(state.tasks.get("build-msi")!.status).toBe("todo");
    expect(state.tasks.get("build-msi")!.waitingOn).toEqual([]);
  });

  it("a new version that keeps the value neither propagates nor changes who decided it", () => {
    seedWindowsWorld();
    board.task("s1", { slug: "add-sync", title: "Add sync", basedOn: ["approach/sync-backend"] });
    // how re-confirming used to be written: the same value again, as a new AI version
    board.store.append("slot.versioned", { kind: "agent", session: "s1" }, {
      key: "approach/sync-backend", value: "OneDrive", rationale: "Still holds", depends: [{ key: "assum/user-os", n: 1 }], topics: [],
    });
    const { state } = board.load();
    const sync = state.slots.get("approach/sync-backend")!;
    expect(sync.current!.n).toBe(2);
    expect(sync.current!.source).toBe("user");
    expect(sync.current!.status).toBe("decided");
    expect(state.tasks.get("add-sync")!.status).toBe("todo");
  });

  it("unaffected marks what a change doesn't touch in the same call, and only the rest needs review", () => {
    seedWindowsWorld();
    board.task("s1", { slug: "add-sync", title: "Add sync", basedOn: ["assum/user-os"] });
    board.task("s1", { slug: "win-ci", title: "Windows CI", basedOn: ["assum/user-os"] });
    start("s2");
    expect(() => board.record("s2", {
      key: "assum/user-os", value: "macOS", rationale: "Correction", userQuote: "macOS",
      unaffected: [{ key: "goal/nope", why: "x" }, { key: "add-sync", why: "" }],
    })).toThrow(/goal\/nope isn't a live decision; add-sync: why is required/);
    expect(board.load().state.slots.get("assum/user-os")!.versions).toHaveLength(1);

    const msg = board.record("s2", {
      key: "assum/user-os", value: "macOS", rationale: "Correction", userQuote: "macOS",
      unaffected: [{ key: "env/target-os", why: "We ship to enterprise Windows fleets anyway" }, { key: "add-sync", why: "Sync is OS-neutral" }],
    });
    expect(msg).toContain("Marked unaffected by assum/user-os: env/target-os, add-sync.");
    expect(msg).toContain("These rest on it and now need review: approach/sync-backend, win-ci.");
    const { state } = board.load();
    expect(state.slots.get("env/target-os")!.stale).toEqual([]);
    expect(state.slots.get("env/target-os")!.versions).toHaveLength(1);
    expect(state.slots.get("approach/sync-backend")!.stale).toHaveLength(1);
    expect(state.tasks.get("add-sync")!.status).toBe("todo");
    expect(state.tasks.get("win-ci")!.status).toBe("needs_review");

    // later, without a value: the same marking for what's left
    expect(board.record("s2", { key: "assum/user-os", unaffected: [{ key: "win-ci", why: "CI covers every OS" }] })).toContain("Marked unaffected");
    expect(board.load().state.tasks.get("win-ci")!.status).toBe("todo");
    expect(() => board.record("s2", { key: "assum/user-os" })).toThrow(/value and rationale are required/);
  });
});

describe("archive", () => {
  it("archives tasks out of the brief, drops unfinished ones first, and lists decisions nothing uses any more", () => {
    start("s1");
    board.record("s1", { key: "goal/fast-sync", value: "Sync in under a second", rationale: "Users complain" });
    board.record("s1", { key: "approach/delta-sync", value: "Send only changed blocks", rationale: "Less data", depends: ["goal/fast-sync"] });
    board.record("s1", { key: "dep/rsync-lib", value: "librsync", rationale: "Block deltas", new: true });
    board.task("s1", { slug: "delta-proto", title: "Prototype delta sync", basedOn: ["dep/rsync-lib", "approach/delta-sync"] });
    board.task("s1", { slug: "old-ui", title: "Old UI", status: "in_progress" });
    board.task("s1", { slug: "done-thing", title: "Done thing" });
    board.verify("s1", { slug: "done-thing", cmd: "true" });

    const dropped = board.task("s1", { slug: "delta-proto", status: "dropped", note: "Too slow" });
    expect(dropped).toContain(`Nothing live uses these any more: approach/delta-sync "Send only changed blocks"; dep/rsync-lib "librsync"`);
    expect(dropped).toContain('archive({ decisions: ["approach/delta-sync", "dep/rsync-lib"], note })');

    const out = board.archive("s1", { tasks: ["delta-proto", "old-ui", "done-thing"], decisions: ["approach/delta-sync", "dep/rsync-lib"], note: "Delta sync abandoned" });
    expect(out).toContain("Archived delta-proto (dropped).");
    expect(out).toContain("Dropped old-ui (it was in_progress) and archived it.");
    expect(out).toContain("Archived done-thing (verified).");
    expect(out).toContain("Retired approach/delta-sync.");
    const { state } = board.load();
    expect(state.tasks.get("old-ui")!.status).toBe("dropped");
    expect(state.tasks.get("done-thing")!).toMatchObject({ lifecycle: "archived", lifecycleNote: { note: "Delta sync abandoned" } });
    expect(state.slots.get("dep/rsync-lib")!.current!.retired).toBe(true);
    // goals stand on their own: losing their last user doesn't make them orphans
    expect(out).not.toContain("goal/fast-sync");
    expect(board.brief()).not.toContain("old-ui");
    expect(board.brief("old ui")).toContain("old-ui");
    expect(() => board.archive("s1", { tasks: ["old-ui"], note: "again" })).toThrow(/already archived/);
  });

  it("retiring a decision flags what rests on it and needs the user's words for their own goals", () => {
    seedWindowsWorld();
    board.task("s1", { slug: "add-sync", title: "Add sync", basedOn: ["approach/sync-backend"] });
    expect(() => board.archive("s1", { decisions: ["approach/sync-backend"], note: "No sync" })).toThrow(/user's decision/);
    board.record("s1", { key: "approach/onedrive-auth", value: "Microsoft login", rationale: "OneDrive needs it", depends: ["approach/sync-backend"] });
    const out = board.archive("s1", { decisions: ["approach/sync-backend"], note: "No sync", userQuote: "drop sync" });
    expect(out).toContain("approach/sync-backend was retired. What rests on it, and further down:");
    expect(out).toContain('  - approach/onedrive-auth "Microsoft login"');
    expect(out).toContain('  - task add-sync "Add sync"');
    expect(board.load().state.tasks.get("add-sync")!.status).toBe("needs_review");
  });
});

describe("task edits and handoff", () => {
  it("changes a task's title, note and root cause in place", () => {
    start("s1");
    board.task("s1", { slug: "run-matrix", title: "Run the matrix, 48-72h each", note: "owner: A" });
    expect(board.load().state.tasks.get("run-matrix")!.note).toBe("owner: A");
    expect(board.task("s1", { slug: "run-matrix", title: "Run the matrix" })).toContain('title is now "Run the matrix"');
    expect(board.task("s1", { slug: "run-matrix", note: "owner: B, after calibration" })).toContain("note saved");
    board.task("s1", { slug: "run-matrix", rootCause: "Jobs were split by wall time" });
    const t = board.load().state.tasks.get("run-matrix")!;
    expect(t).toMatchObject({ title: "Run the matrix", note: "owner: B, after calibration", rootCause: "Jobs were split by wall time", status: "todo" });
    const shown = board.task("s1", { slug: "run-matrix" });
    expect(shown).toContain("# run-matrix [todo]");
    expect(shown).toContain("Note: owner: B, after calibration");
  });

  it("a handoff is locked to the decisions it rests on and shows what changed before it was read", () => {
    seedWindowsWorld();
    board.record("s1", { key: "dep/onedrive-sdk", value: "OneDrive SDK 2", rationale: "Official", new: true });
    board.task("s1", { slug: "add-sync", title: "Add sync", basedOn: ["approach/sync-backend"] });
    expect(() => board.task("s1", { slug: "add-sync", handoff: "  " })).toThrow(/handoff is empty/);
    const wrote = board.task("s1", { slug: "add-sync", handoff: "Upload works.\nNext: conflict handling in sync.ts.", handoffOn: ["dep/onedrive-sdk"] });
    expect(wrote).toContain("against approach/sync-backend@1, dep/onedrive-sdk@1");
    expect(board.brief()).toContain('add-sync [todo] Add sync · handoff: task({ slug: "add-sync" })');

    start("s2");
    board.record("s2", { key: "dep/onedrive-sdk", value: "Microsoft Graph SDK", rationale: "SDK 2 is deprecated" });
    const shown = board.task("s2", { slug: "add-sync" });
    expect(shown).toContain('- dep/onedrive-sdk: was "OneDrive SDK 2", now "Microsoft Graph SDK"');
    expect(shown).toContain("Next: conflict handling in sync.ts.");
    expect(shown).not.toContain("approach/sync-backend: was");
    expect(board.brief()).toContain("handoff (dep/onedrive-sdk changed since)");

    // a new handoff replaces the old one and is locked to the decisions as they are now
    board.task("s2", { slug: "add-sync", handoff: "Switched to Graph; conflicts still open.", handoffOn: ["dep/onedrive-sdk"] });
    const again = board.task("s2", { slug: "add-sync" });
    expect(again).not.toContain("Changed since");
    expect(again).not.toContain("Upload works.");
    expect(board.export()).toContain("  > Switched to Graph; conflicts still open.");
  });
});

describe("split", () => {
  function seedA2() {
    start("s1");
    board.record("s1", { key: "env/cluster", value: "8xA100", rationale: "Lab cluster" });
    board.record("s1", { key: "approach/a2-loss", value: "First token dominates; later positions weighted by rho; teacher is the base model", rationale: "Generalization fallback", depends: ["env/cluster"], userQuote: "first token + rho" });
    board.record("s1", { key: "approach/aux-kl", value: "Aux KL on later positions", rationale: "Follows A2", depends: ["approach/a2-loss"], new: true });
    board.record("s1", { key: "env/throughput", value: "2.1k tok/s per GPU", rationale: "Measured", depends: ["approach/a2-loss", "env/cluster"], new: true });
    board.task("s1", { slug: "matrix-run", title: "Run the matrix", basedOn: ["approach/a2-loss"] });
    board.task("s1", { slug: "teacher-cache", title: "Cache teacher logits", basedOn: ["approach/a2-loss"] });
  }

  it("splits several decisions at once and re-points each dependent only to the pieces it rests on", () => {
    seedA2();
    board.record("s1", { key: "assum/seq-len", value: "Sequences up to 4k", rationale: "Data stats", depends: ["approach/aux-kl"], new: true });
    const out = board.split("s1", {
      splits: [
        { key: "approach/a2-loss", into: [
          { key: "approach/a2-first-token", value: "First token dominates", rationale: "Core of A2" },
          { key: "approach/a2-later-weight", value: "Later positions weighted by rho", rationale: "Generalization" },
          { key: "approach/a2-teacher", value: "Teacher is the base model", rationale: "Simplest teacher" },
        ] },
        { key: "approach/aux-kl", into: [
          { key: "approach/aux-kl-target", value: "Aux KL targets later positions", rationale: "Follows A2", depends: ["approach/a2-later-weight"] },
          { key: "approach/aux-kl-weight", value: "Aux KL weight 0.1", rationale: "Small", depends: [] },
        ] },
      ],
      dependents: [
        { key: "env/throughput", on: ["approach/a2-teacher"] },
        { key: "matrix-run", on: ["approach/a2-first-token", "approach/a2-later-weight"] },
        { key: "assum/seq-len", on: ["approach/aux-kl-target"] },
      ],
      note: "Dependents rest on different parts",
      userQuote: "split it",
    });
    expect(out).toContain("Split approach/a2-loss into approach/a2-first-token, approach/a2-later-weight, approach/a2-teacher.");
    expect(out).toContain("env/throughput → approach/a2-teacher");
    expect(out).toContain("Not listed in dependents, so these rest on every piece: teacher-cache.");

    const { state } = board.load();
    expect(state.slots.get("approach/a2-loss")!.current).toMatchObject({ retired: true, splitInto: ["approach/a2-first-token", "approach/a2-later-weight", "approach/a2-teacher"] });
    const teacher = state.slots.get("approach/a2-teacher")!.current!;
    expect(teacher).toMatchObject({ source: "user", status: "decided", splitFrom: "approach/a2-loss", depends: [{ key: "env/cluster", n: 1 }] });
    expect(state.slots.get("approach/aux-kl-target")!.current!.depends).toEqual([{ key: "approach/a2-later-weight", n: 1 }]);
    expect(state.slots.get("env/throughput")!.current!.depends).toEqual([{ key: "approach/a2-teacher", n: 1 }, { key: "env/cluster", n: 1 }]);
    expect(state.slots.get("env/throughput")!.versions).toHaveLength(1);
    expect(state.slots.get("assum/seq-len")!.current!.depends).toEqual([{ key: "approach/aux-kl-target", n: 1 }]);
    expect(state.tasks.get("matrix-run")!.basedOn.map((d) => d.key)).toEqual(["approach/a2-first-token", "approach/a2-later-weight"]);
    expect(state.tasks.get("teacher-cache")!.basedOn).toHaveLength(3);
    // re-pointing asks nothing of anyone
    for (const s of state.slots.values()) expect(s.stale).toEqual([]);
    for (const t of state.tasks.values()) expect(t.status).toBe("todo");

    // the point of it: changing one piece only touches what rests on that piece
    const msg = board.record("s1", { key: "approach/a2-teacher", value: "Teacher is the SFT model", rationale: "Better targets", userQuote: "use SFT teacher" });
    expect(msg).toContain("These rest on it and now need review: env/throughput, teacher-cache.");
    expect(board.load().state.tasks.get("matrix-run")!.status).toBe("todo");
  });

  it("checks everything first, and makes pieces of the user's goal or approach proposals without their words", () => {
    seedA2();
    expect(() => board.split("s1", {
      splits: [{ key: "approach/a2-loss", into: [{ key: "approach/aux-kl", value: "x", rationale: "y" }] }],
      dependents: [{ key: "matrix-run", on: ["env/cluster"] }],
      note: "n",
    })).toThrow(/needs at least two pieces; approach\/aux-kl is already a live decision/);
    expect(board.load().state.slots.get("approach/a2-loss")!.current!.retired).toBeUndefined();

    board.split("s1", {
      splits: [{ key: "approach/a2-loss", into: [
        { key: "approach/a2-first-token", value: "First token dominates", rationale: "Core" },
        { key: "approach/a2-rest", value: "Later positions weighted by rho, base-model teacher", rationale: "Rest" },
      ] }],
      note: "Finer",
    });
    const piece = board.load().state.slots.get("approach/a2-first-token")!.current!;
    expect(piece.source).toBe("agent");
    expect(piece.status).toBe("proposed");
  });

  it("suggests splitting when most of what rests on a decision isn't affected by its change", () => {
    seedA2();
    const msg = board.record("s1", {
      key: "approach/a2-loss", value: "First token dominates; later positions weighted by rho; teacher is the SFT model", rationale: "Better targets", userQuote: "SFT teacher",
      unaffected: [{ key: "approach/aux-kl", why: "Only the teacher changed" }, { key: "matrix-run", why: "Same matrix" }],
    });
    expect(msg).toContain("Consider splitting it");
  });
});

describe("reader version", () => {
  it("raises requires when newer kinds of events are written, and warns readers that are older", () => {
    seedWindowsWorld();
    const cfg = () => JSON.parse(readFileSync(join(root, ".project/config.json"), "utf8"));
    expect(cfg().requires).toBeUndefined();
    board.task("s1", { slug: "add-sync", title: "Add sync", note: "owner: A" });
    expect(cfg()).toMatchObject({ requires: "0.2.0", acceptAfterSessions: 3 });
    expect(board.brief()).not.toContain("need slotledger");
    writeFileSync(join(root, ".project/config.json"), JSON.stringify({ ...cfg(), requires: "99.0.0" }));
    board.task("s1", { slug: "add-sync", note: "owner: B" });
    expect(cfg().requires).toBe("99.0.0");
    expect(board.brief()).toContain("need slotledger 99.0.0 or later");
  });
});

describe("removed premises", () => {
  function seed() {
    seedWindowsWorld();
    board.record("s1", { key: "approach/msi", value: "Ship an MSI", rationale: "Windows installer", depends: ["env/target-os"] });
    board.record("s1", { key: "dep/wix", value: "WiX toolset", rationale: "Builds the MSI", depends: ["approach/msi"] });
    board.task("s1", { slug: "segment-resume", title: "Resume multi-day runs", basedOn: ["env/target-os"] });
    board.task("s1", { slug: "sign-msi", title: "Sign the MSI", basedOn: ["approach/msi"] });
  }

  it("shows the whole chain on a deleted premise and won't let a re-confirmation quietly drop it", () => {
    seed();
    board.human({ action: "delete", key: "env/target-os" });
    const brief = board.brief();
    expect(brief).toContain("## Removed premises");
    expect(brief).toContain("env/target-os was deleted. What rests on it, and further down:");
    expect(brief).toContain('  - approach/msi "Ship an MSI"');
    expect(brief).toContain('    - dep/wix "WiX toolset"');
    expect(brief).toContain('    - task sign-msi "Sign the MSI"');
    expect(brief).toContain('  - task segment-resume "Resume multi-day runs"');
    expect(() => board.record("s1", { key: "approach/msi", value: "Ship an MSI", rationale: "Still fine" })).toThrow(/env\/target-os is gone, so re-confirming would quietly drop it/);

    // the nudge asks once about the whole chain, not once per thing on it
    start("s2");
    const nudge = board.stop("s2", false).block ?? "";
    expect(nudge.match(/env\/target-os was deleted/g)).toHaveLength(1);
    expect(nudge).not.toContain("segment-resume needs review");
  });

  it("drops the dependency for what stands without it, and retires or suspends the rest", () => {
    seed();
    board.human({ action: "delete", key: "env/target-os" });
    expect(board.record("s1", { key: "env/target-os", unaffected: [{ key: "approach/msi", why: "Enterprise customers still need an MSI" }] }))
      .toContain("Dropped the dependency on env/target-os from: approach/msi.");
    let { state } = board.load();
    expect(state.slots.get("approach/msi")!.current!.depends).toEqual([]);
    expect(state.slots.get("approach/msi")!.stale).toEqual([]);
    expect(state.tasks.get("sign-msi")!.status).toBe("todo");

    // the task only existed for the deleted environment: it goes, and with it the last of the chain
    board.archive("s1", { tasks: ["segment-resume"], note: "Only made sense on that target" });
    expect(board.brief()).not.toContain("## Removed premises");
  });
});

describe("task lifecycle", () => {
  it("suspends a task out of the list and reminders, and resumes it", () => {
    seedWindowsWorld();
    board.task("s1", { slug: "segment-resume", title: "Resume multi-day runs", basedOn: ["env/target-os"] });
    expect(() => board.task("s1", { slug: "segment-resume", lifecycle: "suspended" })).toThrow(/needs a note/);
    const suspended = board.task("s1", { slug: "segment-resume", lifecycle: "suspended", note: "3-day reservations finish in one go" });
    expect(suspended).toContain("Suspended segment-resume");
    expect(suspended).not.toContain("note saved");
    expect(board.brief()).toContain("- Suspended: segment-resume");
    expect(board.brief()).not.toContain("segment-resume [todo]");
    start("s2");
    board.record("s2", { key: "env/target-os", value: "macOS 14+", rationale: "Users moved" });
    expect(board.stop("s2", false).block ?? "").not.toContain("segment-resume");
    // still in use while on hold
    expect(board.task("s2", { slug: "segment-resume", lifecycle: "live", note: "Reservations got shorter" })).toContain("segment-resume needs review: env/target-os v1→v2");
    expect(board.brief()).toContain("segment-resume [needs_review]");
  });
});

