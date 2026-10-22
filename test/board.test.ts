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
    expect(msg).toContain("2 decision(s) depend on it");

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
    expect(slot.current!.n).toBe(2);
    expect(slot.current!.status).toBe("decided");
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

  it("a task needs review when a decision it is based on has a stale premise", () => {
    seedWindowsWorld();
    board.task("s1", { slug: "msi-installer", title: "Build the MSI installer", basedOn: ["env/target-os"] });
    start("s2");
    const msg = board.record("s2", { key: "assum/user-os", value: "macOS", rationale: "Correction", userQuote: "it's actually macOS" });
    expect(msg).not.toContain("Possible premises: env/target-os");
    expect(board.load().state.tasks.get("msi-installer")!.needsReview).toHaveLength(1);
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
    expect(md).toContain("- Status: needs_review (approach/sync-backend changed)");
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

  it("a pass can't clear review while a decision it rests on has an unresolved premise", () => {
    seedWindowsWorld();
    board.task("s1", { slug: "msi-installer", title: "Build the MSI installer", basedOn: ["env/target-os"] });
    start("s2");
    board.record("s2", { key: "assum/user-os", value: "macOS", rationale: "Correction", userQuote: "macOS" });
    expect(board.verify("s2", { slug: "msi-installer", cmd: "true" })).toContain("still needs review: env/target-os has a changed premise");
    expect(board.load().state.tasks.get("msi-installer")!.status).toBe("needs_review");
  });

  it("dropping ends review, and a dropped task shows as dropped", () => {
    verifiedMsi();
    board.task("s2", { slug: "msi-installer", status: "dropped", note: "Mac only now" });
    expect(board.load().state.tasks.get("msi-installer")!.status).toBe("dropped");
  });
});
