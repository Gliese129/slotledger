import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { join } from "node:path";
import { analyze, slotTopics, type Analysis } from "./analyze.js";
import { dependentsOf, fold, type State } from "./fold.js";
import { changedFiles, snapshot } from "./git.js";
import { buildNudge, buildReport, formatNudge, renderBrief, renderStatusMd, type Report } from "./report.js";
import { Store, ulid } from "./store.js";
import type { Actor, AnyEvent, Dep, QOption, SlotKey, TaskStatus } from "./types.js";
import { CATEGORIES, GUARDED, categoryOf } from "./types.js";

/** AI 能自己修的错误：消息里写清楚怎么修 */
export class FixableError extends Error {}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export interface RecordInput {
  key: string;
  value: string;
  rationale: string;
  depends?: string[];
  topics?: string[];
  scope?: string[];
  retired?: boolean;
  userQuote?: string;
}

export interface TaskInput {
  slug: string;
  title?: string;
  status?: TaskStatus;
  basedOn?: string[];
  rootCause?: string;
  note?: string;
}

export interface RespondInput {
  item?: number;
  question?: string;
  choice?: string;
  text?: string;
  withdraw?: boolean;
  userQuote: string;
}

export interface Client {
  name: string;
  version: string;
}

export class Board {
  constructor(readonly store: Store) {}

  load(): { events: AnyEvent[]; state: State } {
    const events = this.store.readEvents();
    return { events, state: fold(events, this.store.readConfig()) };
  }

  writeStatus(state?: State): void {
    writeFileSync(join(this.store.root, "STATUS.md"), renderStatusMd(state ?? this.load().state));
  }

  /** session 不存在就补记 session.started（Codex 等没有 hook 的客户端走这里） */
  ensureSession(session: string, client: Client): boolean {
    if (this.load().state.sessions.has(session)) return false;
    this.store.append("session.started", { kind: "system", session }, { session, client, snapshot: snapshot(this.store.root) });
    return true;
  }

  brief(): string {
    return renderBrief(this.load().state, this.store.errorCount());
  }

  // ---------- record ----------

  record(session: string, input: RecordInput): string {
    const cat = categoryOf(input.key);
    if (!cat) {
      return `无需记录：实现细节不建槽位。如果这确实是一个决定，key 要以分类开头：${CATEGORIES.map((c) => c + "/").join(" ")}，例如 arch/sync-backend。`;
    }
    const name = input.key.slice(cat.length + 1);
    if (!SLUG.test(name)) throw new FixableError(`key 格式应为 <分类>/<小写短横线名>，例如 ${cat}/sync-backend；收到的是 ${input.key}。`);
    const key = input.key as SlotKey;
    if (cat === "constraint" && !input.scope?.length) throw new FixableError("constraint 必须给 scope（受约束的路径或范围），例如 scope: [\"src/legacy/**\"]。");

    const { state } = this.load();
    const depends: Dep[] = [];
    for (const d of input.depends ?? []) {
      if (d === key) throw new FixableError("不能依赖自己。");
      const s = state.slots.get(d as SlotKey);
      if (!s?.current) {
        const similar = [...state.slots.keys()].filter((k) => k.includes(d.split("/").pop() ?? d)).slice(0, 5);
        throw new FixableError(`依赖 ${d} 不存在。${similar.length ? `是不是：${similar.join(", ")}？` : "先用 record 记下它，再引用。"}`);
      }
      depends.push({ key: d as SlotKey, n: s.current.n });
    }

    const slot = state.slots.get(key);
    const cur = slot?.current;
    if (cur) {
      const userOwned = cur.source === "user" || cur.confirmed;
      const changes = cur.value !== input.value || !!input.retired !== !!cur.retired;
      if (userOwned && changes && GUARDED.includes(cat) && !input.userQuote) {
        throw new FixableError(
          `${key} 当前是用户做过的决定（v${cur.n}「${cur.value}」）。改它前请先问用户；用户同意后，把用户原话放进 userQuote 再调用。`,
        );
      }
      const sameDeps = JSON.stringify(cur.depends) === JSON.stringify(depends.length ? depends : cur.depends);
      if (!changes && sameDeps && !slot!.stale.length && JSON.stringify(cur.scope ?? []) === JSON.stringify(input.scope ?? cur.scope ?? []) && !input.userQuote) {
        return `${key} 没有变化，无需记录。`;
      }
      // 复查确认：值没变、没给 depends 时沿用原依赖并锁到当前版本
      if (!depends.length && cur.depends.length) {
        for (const d of cur.depends) {
          const n = state.slots.get(d.key)?.current?.n;
          if (n) depends.push({ key: d.key, n });
        }
      }
    }

    this.store.append("slot.versioned", { kind: "agent", session }, {
      key,
      value: input.value,
      rationale: input.rationale,
      depends,
      topics: input.topics ?? [],
      ...(input.scope?.length ? { scope: input.scope } : cur?.scope ? { scope: cur.scope } : {}),
      ...(input.retired ? { retired: true } : {}),
      ...(input.userQuote ? { userQuote: input.userQuote } : {}),
    });

    const after = this.load().state;
    this.writeStatus(after);
    const now = after.slots.get(key)!;
    const v = now.current!;
    const out: string[] = [`已记录 ${key} v${v.n}（${v.source === "user" ? "用户决定" : "提议，等用户确认或默认接受"}）。`];
    if (cur) out.push(`取代了 v${cur.n}「${cur.value}」。`);

    const dependents = dependentsOf(after, key);
    if (cur && dependents.length) {
      out.push(
        `有 ${dependents.length} 条决定依赖它：${dependents.map((d) => d.key).join("、")}，现已标为前提已变。` +
          `如果这次只是扩展、不影响它们，对每条用相同的 value 再 record 一次即可确认；否则逐条复查。`,
      );
    }
    if (!input.depends?.length && !cur?.depends.length) {
      const config = this.store.readConfig();
      const mine = new Set(slotTopics(now, config.topics));
      const downstream = new Set(dependents.map((d) => d.key));
      const candidates = [...after.slots.values()].filter(
        (s) => s.key !== key && !downstream.has(s.key) && s.current && !s.current.retired &&
          (["assum", "platform", "constraint"].includes(s.category) || slotTopics(s, config.topics).some((t) => mine.has(t))),
      ).slice(0, 5);
      if (candidates.length) {
        out.push(`可能的前提：${candidates.map((s) => `${s.key}「${s.current!.value}」`).join("、")}。如果这个决定以它们为前提，用相同的 value 带上 depends 再调用一次。`);
      }
    }
    const config = this.store.readConfig();
    if (config.topics.length && !slotTopics(now, config.topics).length) {
      out.push(`可选主题：${config.topics.map((t) => t.id).join(", ")}。带上 topics 能让改动检查更准。`);
    }
    return out.join("\n");
  }

  // ---------- task ----------

  task(session: string, input: TaskInput): string {
    if (!SLUG.test(input.slug)) throw new FixableError(`slug 用小写字母、数字和短横线，例如 migrate-platform-to-macos；收到的是 ${input.slug}。`);
    if (input.status === "verified") throw new FixableError(`verified 只能由 verify 产生：verify({ slug: "${input.slug}", cmd: "<测试命令>" })。`);
    const actor: Actor = { kind: "agent", session };
    const { state } = this.load();
    const out: string[] = [];
    let t = state.tasks.get(input.slug);
    if (!t) {
      if (!input.title) throw new FixableError(`任务 ${input.slug} 不存在。新建时需要 title。`);
      const basedOn: Dep[] = [];
      for (const k of input.basedOn ?? []) {
        const n = state.slots.get(k as SlotKey)?.current?.n;
        if (!n) throw new FixableError(`basedOn 里的 ${k} 不存在。先用 record 记下它，或去掉。`);
        basedOn.push({ key: k as SlotKey, n });
      }
      this.store.append("task.created", actor, { slug: input.slug, title: input.title, basedOn, ...(input.rootCause ? { rootCause: input.rootCause } : {}) });
      out.push(`已创建任务 ${input.slug}。`);
    }
    if (input.status && input.status !== (t?.status ?? "todo")) {
      this.store.append("task.status", actor, { slug: input.slug, status: input.status, ...(input.note ? { note: input.note } : {}) });
      out.push(`${input.slug} → ${input.status}。`);
    }
    if (!out.length) out.push(`${input.slug} 没有变化。`);
    if (input.status === "implemented") out.push(`说它完成前，用 verify 跑一次能证明它的命令。`);
    this.writeStatus();
    return out.join("\n");
  }

  // ---------- verify ----------

  verify(session: string, slug: string, cmd: string, timeoutSec = 600): string {
    const { state } = this.load();
    if (!state.tasks.has(slug)) throw new FixableError(`任务 ${slug} 不存在。先用 task 创建它。`);
    const r = spawnSync("sh", ["-c", cmd], { cwd: this.store.root, encoding: "utf8", timeout: timeoutSec * 1000, maxBuffer: 32 * 1024 * 1024 });
    const output = ((r.stdout ?? "") + (r.stderr ?? "")).trimEnd();
    const outputTail = output.slice(-1500);
    const exit = r.status ?? (r.error ? 124 : 1);
    const env = `${platform()} ${release()} ${arch()}, node ${process.version}`;
    const data = { slug, cmd, exit, outputTail, env };
    if (exit === 0) {
      this.store.append("task.verified", { kind: "system", session }, data);
      this.writeStatus();
      return `通过（exit 0，${env}）。${slug} 已标为 verified。`;
    }
    this.store.append("task.verify_failed", { kind: "system", session }, data);
    this.writeStatus();
    const tail = outputTail.split("\n").slice(-20).join("\n");
    return `失败（exit ${exit}${r.error ? `，${r.error.message}` : ""}）。任务状态不变。\n输出末尾：\n${tail}`;
  }

  // ---------- ask ----------

  ask(session: string, about: string[], text: string, options?: QOption[]): string {
    const qid = "q-" + ulid().slice(-8).toLowerCase();
    this.store.append("question.asked", { kind: "agent", session }, { qid, about: about as SlotKey[], text, ...(options?.length ? { options } : {}) });
    this.writeStatus();
    return `已记录问题（${qid}），会出现在结尾汇报里。用户在场时直接问用户更快；拿到回答后用 respond 记下。`;
  }

  // ---------- respond ----------

  respond(session: string, input: RespondInput): string {
    const { state } = this.load();
    const via: Actor = { kind: "human", via: session };
    let qid = input.question;
    let decision: { key: SlotKey; n: number } | undefined;

    if (input.item !== undefined) {
      const report = this.store.readRun<Report>(`report-${session}.json`);
      const it = report?.items.find((i) => i.no === input.item);
      if (!it) throw new FixableError(`最近一次汇报里没有第 ${input.item} 项。可以改用 question（问题 ID，见 brief）。`);
      if (it.kind === "question") qid = it.qid;
      else decision = { key: it.key!, n: it.n! };
    }

    if (decision) {
      const v = state.slots.get(decision.key)?.versions[decision.n - 1];
      if (!v) throw new FixableError(`找不到 ${decision.key} v${decision.n}。`);
      if (input.withdraw || input.text) {
        const rej = this.store.append("version.rejected", via, { key: decision.key, n: decision.n, reason: input.userQuote, ...(input.text ? { replacement: input.text } : {}) });
        if (input.text) {
          this.store.append("slot.versioned", via, {
            key: decision.key, value: input.text, rationale: `用户撤回「${v.value}」并改为此值：${input.userQuote}`,
            depends: this.relock(state, v.depends), topics: [], userQuote: input.userQuote,
          }, rej.id);
        }
        this.writeStatus();
        return input.text
          ? `已撤回 ${decision.key}「${v.value}」，改为「${input.text}」（用户决定）。相关代码如已按旧值实现，请一并调整。`
          : `已撤回 ${decision.key}「${v.value}」。问用户想要什么，再用 record（带 userQuote）写入。`;
      }
      this.store.append("version.confirmed", via, { key: decision.key, n: decision.n, userQuote: input.userQuote });
      this.writeStatus();
      return `已确认 ${decision.key}「${v.value}」。`;
    }

    if (!qid) throw new FixableError("需要 item（汇报里的编号）或 question（问题 ID）。");
    const q = state.questions.get(qid);
    if (!q) throw new FixableError(`问题 ${qid} 不存在。`);
    if (q.status === "answered") return `问题 ${qid} 已经回答过了。`;
    const opt = q.options?.find((o) => o.id.toLowerCase() === (input.choice ?? "").toLowerCase());
    if (input.choice && !opt) throw new FixableError(`选项 ${input.choice} 不存在，可选：${q.options?.map((o) => o.id).join(", ") ?? "无（用 text 回答）"}。`);
    if (!opt && !input.text) throw new FixableError("需要 choice（选项）或 text（用户的回答）。");

    const ans = this.store.append("question.answered", via, { qid, ...(opt ? { option: opt.id } : {}), ...(input.text ? { text: input.text } : {}), userQuote: input.userQuote });

    if (q.origin === "stale_premise" && q.premise) {
      const slot = state.slots.get(q.premise.slot)!;
      const cur = slot.current!;
      if (opt?.id === "A") {
        this.store.append("slot.versioned", via, {
          key: slot.key, value: cur.value, rationale: `${cur.rationale}（${q.premise.dep.key} 变为 v${q.premise.dep.current} 后，用户确认仍成立）`,
          depends: this.relock(state, cur.depends), topics: [], ...(cur.scope ? { scope: cur.scope } : {}), userQuote: input.userQuote,
        }, ans.id);
        this.writeStatus();
        return `已记录：${slot.key}「${cur.value}」仍然成立（用户确认）。`;
      }
      this.writeStatus();
      return `已记录：${slot.key} 需要重新决定。和用户确定新值后，用 record（带 userQuote）写入；在那之前不要改相关代码。`;
    }

    if (q.about.length === 1) {
      const key = q.about[0];
      const prev = state.slots.get(key)?.current;
      this.store.append("slot.versioned", via, {
        key, value: input.text ?? opt!.label, rationale: `用户回答「${q.text}」：${input.userQuote}`,
        depends: prev ? this.relock(state, prev.depends) : [], topics: [], userQuote: input.userQuote,
      }, ans.id);
      this.writeStatus();
      return `已记录回答，并写入 ${key}「${input.text ?? opt!.label}」（用户决定）。`;
    }
    this.writeStatus();
    return `已记录回答。涉及 ${q.about.join("、")}，请按回答分别用 record（带 userQuote）更新。`;
  }

  private relock(state: State, deps: Dep[]): Dep[] {
    return deps.flatMap((d) => {
      const n = state.slots.get(d.key)?.current?.n;
      return n ? [{ key: d.key, n }] : [];
    });
  }

  // ---------- 生命周期（hooks 调用） ----------

  analyzeSession(session: string): Analysis | null {
    const { state } = this.load();
    const start = state.sessions.get(session)?.start.snapshot;
    const now = snapshot(this.store.root);
    if (!start || !now) return null;
    return analyze(state, this.store.readConfig(), session, changedFiles(this.store.root, start.tree, now.tree));
  }

  /** 每回合结束：先给 AI 一次提醒，之后有新内容才给用户看汇报 */
  stop(session: string, stopHookActive: boolean): { block?: string; message?: string } {
    this.ensureSession(session, { name: "claude-code", version: "" });
    const analysis = this.analyzeSession(session);
    const { events, state } = this.load();
    this.writeStatus(state);

    const nudgedFile = `nudged-${session}.json`;
    const nudged = new Set(this.store.readRun<string[]>(nudgedFile) ?? []);
    const fresh = buildNudge(state, analysis).filter((p) => !nudged.has(p.key));
    if (!stopHookActive && fresh.length) {
      this.store.writeRun(nudgedFile, [...nudged, ...fresh.map((p) => p.key)]);
      return { block: formatNudge(fresh) };
    }

    const report = buildReport(state, events, session, analysis);
    const last = this.store.readRun<Report>(`report-${session}.json`);
    if (!report.text || report.signature === last?.signature) return {};
    this.store.writeRun(`report-${session}.json`, report);
    return { message: report.text };
  }

  sessionEnd(session: string): void {
    if (!this.load().state.sessions.has(session)) return;
    this.store.append("session.ended", { kind: "system", session }, { session, snapshot: snapshot(this.store.root) });
    this.writeStatus();
  }

  /** 用户回复汇报编号时，给 AI 补上编号对应的条目 */
  replyContext(session: string, prompt: string): string | null {
    const report = this.store.readRun<Report>(`report-${session}.json`);
    if (!report?.items.length) return null;
    if (!/(撤回|确认)\s*\d|(^|[^\d])\d{1,2}\s*[A-Za-z]?($|[^\w])/.test(prompt)) return null;
    const lines = report.items.map((i) =>
      i.kind === "question"
        ? `${i.no} = 问题（${i.options?.map((o) => `${o.id} ${o.label}`).join(" / ") ?? "自由回答"}）：${i.text}`
        : `${i.no} = 替用户做的决定 ${i.key} v${i.n}：${i.text}`,
    );
    return [
      "用户可能在回复上一份 slotboard 汇报，编号对应：",
      ...lines,
      "回答问题用 respond({ item, choice 或 text, userQuote })；撤回决定用 respond({ item, withdraw: true, text?: 替代值, userQuote })；userQuote 填用户原话。",
    ].join("\n");
  }
}
