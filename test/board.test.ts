import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Board, FixableError } from "../src/board.js";
import { Store } from "../src/store.js";

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
  root = mkdtempSync(join(tmpdir(), "slotboard-test-"));
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
  board.record("s1", { key: "assum/user-os", value: "用户都用 Windows", rationale: "访谈结果", userQuote: "我们用户都是 Windows" });
  board.record("s1", { key: "arch/sync-backend", value: "OneDrive", rationale: "用户都用 Windows，OneDrive 自带", depends: ["assum/user-os"], userQuote: "那就 OneDrive 吧" });
  board.record("s1", { key: "platform/target-os", value: "Windows 10+", rationale: "跟随用户系统", depends: ["assum/user-os"] });
}

describe("槽位与 stale", () => {
  it("实现细节不建槽位", () => {
    start("s1");
    expect(board.record("s1", { key: "impl/rename-var", value: "x", rationale: "y" })).toContain("无需记录");
    expect(board.load().state.slots.size).toBe(0);
  });

  it("前提变化后依赖方被标 stale，arch 进入需要你确认", () => {
    seedWindowsWorld();
    start("s2");
    const msg = board.record("s2", { key: "assum/user-os", value: "用户其实用 macOS", rationale: "用户纠正", userQuote: "用户其实用 macOS" });
    expect(msg).toContain("有 2 条决定依赖它");

    const { state } = board.load();
    expect(state.slots.get("arch/sync-backend")!.stale).toEqual([{ key: "assum/user-os", locked: 1, current: 2 }]);

    const r = board.stop("s2", true);
    expect(r.message).toContain("需要你确认（1 项");
    expect(r.message).toContain("arch/sync-backend");
    expect(r.message).toContain('直接回复"1A"');
  });

  it("非 arch/product 的 stale 由 AI 自查：Stop 先提醒一次", () => {
    seedWindowsWorld();
    start("s2");
    board.record("s2", { key: "assum/user-os", value: "macOS", rationale: "纠正", userQuote: "其实是 macOS" });
    const first = board.stop("s2", false);
    expect(first.block).toContain("platform/target-os");
    // 同样的内容不再提醒
    expect(board.stop("s2", false).block).toBeUndefined();
  });

  it("推翻用户的 arch 决定会停下，带 userQuote 才放行", () => {
    seedWindowsWorld();
    start("s2");
    expect(() => board.record("s2", { key: "arch/sync-backend", value: "iCloud", rationale: "macOS 上更顺" })).toThrow(FixableError);
    expect(board.record("s2", { key: "arch/sync-backend", value: "iCloud", rationale: "用户同意", depends: ["assum/user-os"], userQuote: "换 iCloud 吧" })).toContain("v2");
  });

  it("respond 1A：确认仍成立，锁定新依赖版本，stale 消失", () => {
    seedWindowsWorld();
    start("s2");
    board.record("s2", { key: "assum/user-os", value: "macOS", rationale: "纠正", userQuote: "其实是 macOS" });
    board.stop("s2", true);
    expect(board.respond("s2", { item: 1, choice: "A", userQuote: "1A" })).toContain("仍然成立");
    const { state } = board.load();
    const slot = state.slots.get("arch/sync-backend")!;
    expect(slot.stale).toEqual([]);
    expect(slot.current!.n).toBe(2);
    expect(slot.current!.status).toBe("decided");
  });

  it("值没变时不重复记", () => {
    seedWindowsWorld();
    expect(board.record("s1", { key: "platform/target-os", value: "Windows 10+", rationale: "同上" })).toContain("没有变化");
  });

  it("连续 N 个 session 未否决则默认接受", () => {
    start("s1");
    board.record("s1", { key: "product/autostart", value: "默认关闭", rationale: "保守" });
    for (const s of ["s2", "s3"]) start(s);
    expect(board.load().state.slots.get("product/autostart")!.current!.status).toBe("proposed");
    start("s4");
    expect(board.load().state.slots.get("product/autostart")!.current!.status).toBe("accepted_by_default");
  });

  it("撤回替用户做的决定并给替代值", () => {
    start("s1");
    board.record("s1", { key: "product/autostart", value: "默认开启", rationale: "方便" });
    const r = board.stop("s1", true);
    expect(r.message).toContain("我先替你做了决定");
    board.respond("s1", { item: 1, withdraw: true, text: "默认关闭", userQuote: "撤回 1，默认关" });
    const v = board.load().state.slots.get("product/autostart")!.current!;
    expect(v.value).toBe("默认关闭");
    expect(v.source).toBe("user");
  });
});

describe("改动分析", () => {
  it("改了主题代码却没记录：先提醒 AI，再告诉用户", () => {
    start("s1");
    write("src/sync/icloud.ts", "export const backend = 'icloud'\n");
    const first = board.stop("s1", false);
    expect(first.block).toContain("主题 sync");
    const second = board.stop("s1", true);
    expect(second.message).toContain("改动了 sync 相关代码");
  });

  it("记录了相关槽位就不算未声明（按 key 名推断主题）", () => {
    start("s1");
    write("src/sync/icloud.ts", "x\n");
    board.record("s1", { key: "arch/sync-backend", value: "iCloud", rationale: "试试" });
    expect(board.stop("s1", false).block ?? "").not.toContain("主题 sync");
  });

  it("开始前就有的未提交改动不算进本 session", () => {
    write("src/sync/dirty.ts", "x\n");
    start("s1");
    expect(board.stop("s1", false).block).toBeUndefined();
  });

  it("新增文档被指出，STATUS.md 不算", () => {
    start("s1");
    write("PLAN.md", "# plan\n");
    expect(board.stop("s1", false).block).toContain("PLAN.md");
    expect(board.stop("s1", true).message).toContain("本次新增了文档：PLAN.md");
  });
});

describe("任务与验证", () => {
  it("verify 由 server 执行，失败不改状态", () => {
    start("s1");
    board.task("s1", { slug: "add-sync", title: "加同步", status: "implemented" });
    expect(() => board.task("s1", { slug: "add-sync", status: "verified" as any })).toThrow(FixableError);
    expect(board.verify("s1", "add-sync", "exit 3")).toContain("失败");
    expect(board.load().state.tasks.get("add-sync")!.status).toBe("implemented");
    expect(board.verify("s1", "add-sync", "echo ok")).toContain("通过");
    expect(board.load().state.tasks.get("add-sync")!.status).toBe("verified");
    expect(readFileSync(join(root, "STATUS.md"), "utf8")).toContain("`echo ok` 通过");
  });

  it("任务基于的决定前提已变，也要复查", () => {
    seedWindowsWorld();
    board.task("s1", { slug: "msi-installer", title: "做 MSI 安装包", basedOn: ["platform/target-os"] });
    start("s2");
    const msg = board.record("s2", { key: "assum/user-os", value: "macOS", rationale: "纠正", userQuote: "其实是 macOS" });
    expect(msg).not.toContain("可能的前提：platform/target-os");
    expect(board.load().state.tasks.get("msi-installer")!.needsReview).toHaveLength(1);
  });

  it("任务基于的决定变了就需要复查", () => {
    seedWindowsWorld();
    board.task("s1", { slug: "msi-installer", title: "做 MSI 安装包", basedOn: ["platform/target-os"] });
    start("s2");
    board.record("s2", { key: "platform/target-os", value: "macOS 13+", rationale: "用户用 macOS", userQuote: "做 mac 版" });
    expect(board.load().state.tasks.get("msi-installer")!.needsReview).toHaveLength(1);
    expect(board.brief()).toContain("msi-installer [todo] 做 MSI 安装包 ⚠ 基于的决定已变");
  });
});
