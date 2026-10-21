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

/** Errors the AI can fix itself: the message says how */
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

  /** Record session.started if the session is unknown (clients without hooks, like Codex, come through here) */
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
      return `Nothing recorded: implementation details don't get slots. If this really is a decision, the key must start with a category: ${CATEGORIES.map((c) => c + "/").join(" ")}, e.g. arch/sync-backend.`;
    }
    const name = input.key.slice(cat.length + 1);
    if (!SLUG.test(name)) throw new FixableError(`Key must look like <category>/<lowercase-dashed-name>, e.g. ${cat}/sync-backend; got ${input.key}.`);
    const key = input.key as SlotKey;
    if (cat === "constraint" && !input.scope?.length) throw new FixableError("A constraint needs scope (the paths or area it covers), e.g. scope: [\"src/legacy/**\"].");

    const { state } = this.load();
    const depends: Dep[] = [];
    for (const d of input.depends ?? []) {
      if (d === key) throw new FixableError("A slot can't depend on itself.");
      const s = state.slots.get(d as SlotKey);
      if (!s?.current) {
        const similar = [...state.slots.keys()].filter((k) => k.includes(d.split("/").pop() ?? d)).slice(0, 5);
        throw new FixableError(`Dependency ${d} doesn't exist. ${similar.length ? `Did you mean: ${similar.join(", ")}?` : "Record it first, then reference it."}`);
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
          `${key} is currently the user's decision (v${cur.n} "${cur.value}"). Ask the user before changing it; once they agree, call again with their words in userQuote.`,
        );
      }
      const sameDeps = JSON.stringify(cur.depends) === JSON.stringify(depends.length ? depends : cur.depends);
      if (!changes && sameDeps && !slot!.stale.length && JSON.stringify(cur.scope ?? []) === JSON.stringify(input.scope ?? cur.scope ?? []) && !input.userQuote) {
        return `${key} is unchanged; nothing recorded.`;
      }
      // Re-confirming after review: same value and no depends given, so keep the old deps locked to their current versions
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
    const out: string[] = [`Recorded ${key} v${v.n} (${v.source === "user" ? "user decision" : "proposal, awaiting user confirmation or default acceptance"}).`];
    if (cur) out.push(`Replaces v${cur.n} "${cur.value}".`);

    const dependents = dependentsOf(after, key);
    if (cur && dependents.length) {
      out.push(
        `${dependents.length} decision(s) depend on it: ${dependents.map((d) => d.key).join(", ")}; they are now marked as having a stale premise. ` +
          `If this only extends it and doesn't affect them, confirm each by recording it again with the same value; otherwise review them one by one.`,
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
        out.push(`Possible premises: ${candidates.map((s) => `${s.key} "${s.current!.value}"`).join(", ")}. If this decision rests on any of them, call again with the same value and depends.`);
      }
    }
    const config = this.store.readConfig();
    if (config.topics.length && !slotTopics(now, config.topics).length) {
      out.push(`Available topics: ${config.topics.map((t) => t.id).join(", ")}. Passing topics makes change detection more accurate.`);
    }
    return out.join("\n");
  }

  // ---------- task ----------

  task(session: string, input: TaskInput): string {
    if (!SLUG.test(input.slug)) throw new FixableError(`Slugs use lowercase letters, digits, and dashes, e.g. migrate-platform-to-macos; got ${input.slug}.`);
    if (input.status === "verified") throw new FixableError(`Only verify can set verified: verify({ slug: "${input.slug}", cmd: "<test command>" }).`);
    const actor: Actor = { kind: "agent", session };
    const { state } = this.load();
    const out: string[] = [];
    let t = state.tasks.get(input.slug);
    if (!t) {
      if (!input.title) throw new FixableError(`Task ${input.slug} doesn't exist. Creating it needs a title.`);
      const basedOn: Dep[] = [];
      for (const k of input.basedOn ?? []) {
        const n = state.slots.get(k as SlotKey)?.current?.n;
        if (!n) throw new FixableError(`${k} in basedOn doesn't exist. Record it first, or remove it.`);
        basedOn.push({ key: k as SlotKey, n });
      }
      this.store.append("task.created", actor, { slug: input.slug, title: input.title, basedOn, ...(input.rootCause ? { rootCause: input.rootCause } : {}) });
      out.push(`Created task ${input.slug}.`);
    }
    if (input.status && input.status !== (t?.status ?? "todo")) {
      this.store.append("task.status", actor, { slug: input.slug, status: input.status, ...(input.note ? { note: input.note } : {}) });
      out.push(`${input.slug} → ${input.status}.`);
    }
    if (!out.length) out.push(`${input.slug} is unchanged.`);
    if (input.status === "implemented") out.push(`Before calling it done, use verify to run a command that proves it works.`);
    this.writeStatus();
    return out.join("\n");
  }

  // ---------- verify ----------

  verify(session: string, slug: string, cmd: string, timeoutSec = 600): string {
    const { state } = this.load();
    if (!state.tasks.has(slug)) throw new FixableError(`Task ${slug} doesn't exist. Create it with task first.`);
    const r = spawnSync("sh", ["-c", cmd], { cwd: this.store.root, encoding: "utf8", timeout: timeoutSec * 1000, maxBuffer: 32 * 1024 * 1024 });
    const output = ((r.stdout ?? "") + (r.stderr ?? "")).trimEnd();
    const outputTail = output.slice(-1500);
    const exit = r.status ?? (r.error ? 124 : 1);
    const env = `${platform()} ${release()} ${arch()}, node ${process.version}`;
    const data = { slug, cmd, exit, outputTail, env };
    if (exit === 0) {
      this.store.append("task.verified", { kind: "system", session }, data);
      this.writeStatus();
      return `Passed (exit 0, ${env}). ${slug} is now verified.`;
    }
    this.store.append("task.verify_failed", { kind: "system", session }, data);
    this.writeStatus();
    const tail = outputTail.split("\n").slice(-20).join("\n");
    return `Failed (exit ${exit}${r.error ? `, ${r.error.message}` : ""}). Task status unchanged.\nEnd of output:\n${tail}`;
  }

  // ---------- ask ----------

  ask(session: string, about: string[], text: string, options?: QOption[]): string {
    const qid = "q-" + ulid().slice(-8).toLowerCase();
    this.store.append("question.asked", { kind: "agent", session }, { qid, about: about as SlotKey[], text, ...(options?.length ? { options } : {}) });
    this.writeStatus();
    return `Question recorded (${qid}); it will appear in the end-of-turn report. If the user is around, asking directly is faster; record the answer with respond.`;
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
      if (!it) throw new FixableError(`The latest report has no item ${input.item}. Use question (the question ID, shown in brief) instead.`);
      if (it.kind === "question") qid = it.qid;
      else decision = { key: it.key!, n: it.n! };
    }

    if (decision) {
      const v = state.slots.get(decision.key)?.versions[decision.n - 1];
      if (!v) throw new FixableError(`Can't find ${decision.key} v${decision.n}.`);
      if (input.withdraw || input.text) {
        const rej = this.store.append("version.rejected", via, { key: decision.key, n: decision.n, reason: input.userQuote, ...(input.text ? { replacement: input.text } : {}) });
        if (input.text) {
          this.store.append("slot.versioned", via, {
            key: decision.key, value: input.text, rationale: `User withdrew "${v.value}" and replaced it with this: ${input.userQuote}`,
            depends: this.relock(state, v.depends), topics: [], userQuote: input.userQuote,
          }, rej.id);
        }
        this.writeStatus();
        return input.text
          ? `Withdrew ${decision.key} "${v.value}" and replaced it with "${input.text}" (user decision). If code already follows the old value, update it too.`
          : `Withdrew ${decision.key} "${v.value}". Ask the user what they want, then write it with record (with userQuote).`;
      }
      this.store.append("version.confirmed", via, { key: decision.key, n: decision.n, userQuote: input.userQuote });
      this.writeStatus();
      return `Confirmed ${decision.key} "${v.value}".`;
    }

    if (!qid) throw new FixableError("Needs item (the number in the report) or question (the question ID).");
    const q = state.questions.get(qid);
    if (!q) throw new FixableError(`Question ${qid} doesn't exist.`);
    if (q.status === "answered") return `Question ${qid} was already answered.`;
    const opt = q.options?.find((o) => o.id.toLowerCase() === (input.choice ?? "").toLowerCase());
    if (input.choice && !opt) throw new FixableError(`Option ${input.choice} doesn't exist. Options: ${q.options?.map((o) => o.id).join(", ") ?? "none (answer with text)"}.`);
    if (!opt && !input.text) throw new FixableError("Needs choice (an option) or text (the user's answer).");

    const ans = this.store.append("question.answered", via, { qid, ...(opt ? { option: opt.id } : {}), ...(input.text ? { text: input.text } : {}), userQuote: input.userQuote });

    if (q.origin === "stale_premise" && q.premise) {
      const slot = state.slots.get(q.premise.slot)!;
      const cur = slot.current!;
      if (opt?.id === "A") {
        this.store.append("slot.versioned", via, {
          key: slot.key, value: cur.value, rationale: `${cur.rationale} (user confirmed it still holds after ${q.premise.dep.key} became v${q.premise.dep.current})`,
          depends: this.relock(state, cur.depends), topics: [], ...(cur.scope ? { scope: cur.scope } : {}), userQuote: input.userQuote,
        }, ans.id);
        this.writeStatus();
        return `Recorded: ${slot.key} "${cur.value}" still holds (user confirmed).`;
      }
      this.writeStatus();
      return `Recorded: ${slot.key} needs a new decision. Settle the new value with the user, then write it with record (with userQuote); don't change the related code until then.`;
    }

    if (q.about.length === 1) {
      const key = q.about[0];
      const prev = state.slots.get(key)?.current;
      this.store.append("slot.versioned", via, {
        key, value: input.text ?? opt!.label, rationale: `User answered "${q.text}": ${input.userQuote}`,
        depends: prev ? this.relock(state, prev.depends) : [], topics: [], userQuote: input.userQuote,
      }, ans.id);
      this.writeStatus();
      return `Answer recorded and written to ${key} "${input.text ?? opt!.label}" (user decision).`;
    }
    this.writeStatus();
    return `Answer recorded. It covers ${q.about.join(", ")}; update each with record (with userQuote) to match the answer.`;
  }

  private relock(state: State, deps: Dep[]): Dep[] {
    return deps.flatMap((d) => {
      const n = state.slots.get(d.key)?.current?.n;
      return n ? [{ key: d.key, n }] : [];
    });
  }

  // ---------- Lifecycle (called by hooks) ----------

  analyzeSession(session: string): Analysis | null {
    const { state } = this.load();
    const start = state.sessions.get(session)?.start.snapshot;
    const now = snapshot(this.store.root);
    if (!start || !now) return null;
    return analyze(state, this.store.readConfig(), session, changedFiles(this.store.root, start.tree, now.tree));
  }

  /** End of each turn: nudge the AI once, then show the user a report only when there is something new */
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

  /** When the user replies with report numbers, give the AI the items those numbers refer to */
  replyContext(session: string, prompt: string): string | null {
    const report = this.store.readRun<Report>(`report-${session}.json`);
    if (!report?.items.length) return null;
    if (!/(withdraw|undo|confirm|撤回|确认)\s*\d|(^|[^\d])\d{1,2}\s*[A-Za-z]?($|[^\w])/i.test(prompt)) return null;
    const lines = report.items.map((i) =>
      i.kind === "question"
        ? `${i.no} = question (${i.options?.map((o) => `${o.id} ${o.label}`).join(" / ") ?? "free answer"}): ${i.text}`
        : `${i.no} = decision made on the user's behalf, ${i.key} v${i.n}: ${i.text}`,
    );
    return [
      "The user may be replying to the last slotboard report. The numbers mean:",
      ...lines,
      "Answer a question with respond({ item, choice or text, userQuote }); withdraw a decision with respond({ item, withdraw: true, text?: replacement, userQuote }). userQuote is the user's exact words.",
    ].join("\n");
  }
}
