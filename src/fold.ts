import { shortHash } from "./store.js";
import type { AnyEvent, Category, Config, Dep, Evidence, HumanTag, QOption, SlotKey, Snapshot, TaskLifecycle, TaskStatus } from "./types.js";
import { canonicalEvent, categoryOf, legacyKey } from "./types.js";

export type VersionStatus = "proposed" | "decided" | "accepted_by_default" | "rejected";

export interface VersionState {
  n: number;
  value: string;
  rationale: string;
  source: "user" | "agent";
  depends: Dep[];
  scope?: string[];
  retired?: boolean;
  replacedBy?: SlotKey;
  userQuote?: string;
  session?: string;
  at: string;
  /** When the decision was first proposed; differs from at for versions inherited through a merge */
  since: string;
  eventId: string;
  confirmed: boolean;
  rejected?: { reason: string };
  status: VersionStatus;
  /** Set when a human made, approved, or rejected this version */
  tag?: HumanTag;
  /** Times it was found to still hold after a premise changed (re-locked, no new version) */
  reviews: { at: string; note: string; by: "user" | "agent" }[];
  splitFrom?: SlotKey;
  splitInto?: SlotKey[];
}

export interface StaleDep {
  key: SlotKey;
  locked: number;
  current: number;
  /** Deleted, retired or withdrawn with nothing taking its place: whatever rests on it must stand without it or go too */
  gone?: boolean;
}

export interface SlotState {
  key: SlotKey;
  category: Category;
  topics: string[];
  versions: VersionState[];
  current?: VersionState;
  stale: StaleDep[];
  /** Index of the first version after the latest delete; earlier versions are history only */
  liveFrom: number;
  /** Set while the slot is deleted; recording the key again revives it with the next version number */
  deleted?: { at: string };
}

export interface TaskState {
  slug: string;
  title: string;
  basedOn: Dep[];
  rootCause?: string;
  /** needs_review whenever decisions it rests on changed and it isn't dropped; otherwise the same as progress */
  status: TaskStatus;
  /** Where the work stands apart from review; the status it returns to once basedOn is re-locked */
  progress: Exclude<TaskStatus, "needs_review">;
  note?: string;
  evidence?: Evidence & { at: string };
  lastFailed?: Evidence & { at: string };
  session?: string;
  /** Decisions in basedOn whose value changed: the task itself must be reviewed */
  needsReview: StaleDep[];
  /** Decisions in basedOn waiting for their own premise review; the task follows whatever that review decides */
  waitingOn: SlotKey[];
  lifecycle: TaskLifecycle;
  /** When anything about the task last changed */
  updatedAt: string;
  /** Why it was last suspended, archived or resumed */
  lifecycleNote?: { at: string; note: string };
  /** changed: decisions it was written against whose value has changed since */
  handoff?: { text: string; basedOn: Dep[]; at: string; session?: string; changed: StaleDep[] };
}

export interface QuestionState {
  qid: string;
  about: SlotKey[];
  text: string;
  options?: QOption[];
  origin: "agent" | "stale_premise";
  status: "open" | "answered";
  session?: string;
  at: string;
  // stale_premise only
  premise?: { slot: SlotKey; n: number; dep: StaleDep };
}

export interface SessionState {
  id: string;
  client: { name: string; version: string };
  start: { at: string; snapshot: Snapshot | null };
  end?: { at: string; snapshot: Snapshot | null };
  wrote: SlotKey[];
}

export interface State {
  slots: Map<SlotKey, SlotState>;
  tasks: Map<string, TaskState>;
  questions: Map<string, QuestionState>;
  sessions: Map<string, SessionState>;
}

function sessionOf(ev: AnyEvent): string | undefined {
  const a = ev.actor;
  return a.kind === "agent" ? a.session : a.kind === "human" ? a.via : a.session;
}

export function staleQuestionId(slot: SlotKey, n: number, dep: SlotKey, depN: number): string {
  // hashed from the pre-rename key names so questions answered before the rename stay answered
  return "sq-" + shortHash(`${legacyKey(slot)}@${n}|${legacyKey(dep)}@${depN}`);
}

/** Fold events in order into the current state. Every judgment (stale, confirmation status, stale-premise questions) is derived here, never stored. */
export function fold(events: AnyEvent[], config: Config): State {
  const slots = new Map<SlotKey, SlotState>();
  const tasks = new Map<string, TaskState>();
  const questions = new Map<string, QuestionState>();
  const sessions = new Map<string, SessionState>();
  const answered = new Set<string>();
  const sessionStarts: { id: string; at: string }[] = [];

  for (const ev of events.map(canonicalEvent)) {
    const sid = sessionOf(ev);
    switch (ev.type) {
      case "session.started": {
        const d = ev.data;
        if (!sessions.has(d.session)) {
          sessions.set(d.session, { id: d.session, client: d.client, start: { at: ev.at, snapshot: d.snapshot }, wrote: [] });
          sessionStarts.push({ id: d.session, at: ev.at });
        }
        break;
      }
      case "session.ended": {
        const s = sessions.get(ev.data.session);
        if (s) s.end = { at: ev.at, snapshot: ev.data.snapshot };
        break;
      }
      case "slot.versioned": {
        const d = ev.data;
        const cat = categoryOf(d.key);
        if (!cat) break;
        let slot = slots.get(d.key);
        if (!slot) {
          slot = { key: d.key, category: cat, topics: [], versions: [], stale: [], liveFrom: 0 };
          slots.set(d.key, slot);
        }
        if (slot.deleted) { slot.deleted = undefined; slot.topics = []; }
        for (const t of d.topics ?? []) if (!slot.topics.includes(t)) slot.topics.push(t);
        // A re-pointed copy keeps who decided it, whether it was confirmed, and how long it has stood.
        // So does an AI version that keeps the value (a new rationale or new premises): only a new value changes ownership.
        const last = slot.versions.slice(slot.liveFrom).reverse().find((v) => !v.rejected);
        const sameValue = last && last.value === d.value && !!last.retired === !!d.retired && !d.userQuote && ev.actor.kind !== "human";
        // a piece of a split keeps the owner of what it was split from, unless the split needs the user's say first
        const origin = d.splitFrom?.keepOwner ? slots.get(d.splitFrom.key)?.versions[d.splitFrom.n - 1] : undefined;
        const prev = d.inherit ? slot.versions[d.inherit - 1] : sameValue ? last : origin;
        const source = prev ? prev.source : ev.actor.kind === "human" || d.userQuote ? "user" : "agent";
        slot.versions.push({
          n: slot.versions.length + 1,
          value: d.value,
          rationale: d.rationale,
          source,
          depends: d.depends ?? [],
          scope: d.scope,
          retired: d.retired,
          ...(d.replacedBy ? { replacedBy: d.replacedBy } : {}),
          ...(d.splitInto ? { splitInto: d.splitInto } : {}),
          ...(d.splitFrom ? { splitFrom: d.splitFrom.key } : {}),
          userQuote: d.userQuote ?? prev?.userQuote,
          session: prev ? prev.session : sid,
          at: ev.at,
          since: prev ? prev.since : ev.at,
          eventId: ev.id,
          confirmed: prev?.confirmed ?? false,
          status: "proposed",
          reviews: [],
          ...(prev?.tag ? { tag: prev.tag } : ev.actor.kind === "human" && ev.actor.channel === "web" && d.action === "edit" ? { tag: "human-edit" as const } : source === "user" ? { tag: "human-decided" as const } : {}),
        });
        if (sid) {
          const s = sessions.get(sid);
          if (s && !s.wrote.includes(d.key)) s.wrote.push(d.key);
        }
        break;
      }
      case "slot.relocked": {
        const v = slots.get(ev.data.key)?.versions[ev.data.n - 1];
        if (v) {
          v.depends = ev.data.depends;
          if (ev.data.repoint) break;
          const byUser = ev.actor.kind === "human" || !!ev.data.userQuote;
          v.reviews.push({ at: ev.at, note: ev.data.note, by: byUser ? "user" : "agent" });
          // the user saying an AI decision still holds is approving it
          if (byUser && v.source === "agent" && !v.confirmed) { v.confirmed = true; v.tag = "human-approved"; }
        }
        break;
      }
      case "version.confirmed": {
        const v = slots.get(ev.data.key)?.versions[ev.data.n - 1];
        if (v) {
          v.confirmed = true;
          if (v.source === "agent") v.tag = "human-approved";
        }
        break;
      }
      case "version.rejected": {
        const v = slots.get(ev.data.key)?.versions[ev.data.n - 1];
        if (v) { v.rejected = { reason: ev.data.reason }; v.tag = "human-rejected"; }
        break;
      }
      case "slot.deleted": {
        const slot = slots.get(ev.data.key);
        if (slot && !slot.deleted) { slot.deleted = { at: ev.at }; slot.liveFrom = slot.versions.length; }
        break;
      }
      case "task.created": {
        const d = ev.data;
        if (!tasks.has(d.slug)) {
          tasks.set(d.slug, { slug: d.slug, title: d.title, basedOn: d.basedOn ?? [], rootCause: d.rootCause, status: "todo", progress: "todo", session: sid, needsReview: [], waitingOn: [], lifecycle: "live", updatedAt: ev.at });
        }
        break;
      }
      case "task.status": {
        const t = tasks.get(ev.data.slug);
        if (t && ev.data.status !== "needs_review") { t.progress = ev.data.status; t.note = ev.data.note; }
        break;
      }
      case "task.verified": {
        const t = tasks.get(ev.data.slug);
        if (t) {
          t.progress = "verified";
          t.evidence = { ...ev.data, at: ev.at };
          if (ev.data.basedOn) t.basedOn = ev.data.basedOn;
        }
        break;
      }
      case "task.rebased": {
        const t = tasks.get(ev.data.slug);
        if (t) t.basedOn = ev.data.basedOn;
        break;
      }
      case "task.edited": {
        const t = tasks.get(ev.data.slug);
        if (t) {
          if (ev.data.title) t.title = ev.data.title;
          if (ev.data.note !== undefined) t.note = ev.data.note;
          if (ev.data.rootCause) t.rootCause = ev.data.rootCause;
        }
        break;
      }
      case "task.handoff": {
        const t = tasks.get(ev.data.slug);
        if (t) t.handoff = { text: ev.data.text, basedOn: ev.data.basedOn, at: ev.at, session: sid, changed: [] };
        break;
      }
      case "task.lifecycle": {
        const t = tasks.get(ev.data.slug);
        if (t) { t.lifecycle = ev.data.lifecycle; t.lifecycleNote = { at: ev.at, note: ev.data.note }; }
        break;
      }
      case "task.verify_failed": {
        const t = tasks.get(ev.data.slug);
        if (t) t.lastFailed = { ...ev.data, at: ev.at };
        break;
      }
      case "question.asked": {
        const d = ev.data;
        questions.set(d.qid, { qid: d.qid, about: d.about, text: d.text, options: d.options, origin: "agent", status: "open", session: sid, at: ev.at });
        break;
      }
      case "question.answered":
        answered.add(ev.data.qid);
        break;
    }
    if (ev.type.startsWith("task.")) {
      const t = tasks.get((ev.data as { slug: string }).slug);
      if (t) t.updatedAt = ev.at;
    }
  }

  // Confirmation status
  for (const slot of slots.values()) {
    for (const v of slot.versions) {
      if (v.rejected) v.status = "rejected";
      else if (v.source === "user" || v.confirmed) v.status = "decided";
      else {
        const later = new Set(sessionStarts.filter((s) => s.at > v.since && s.id !== v.session).map((s) => s.id));
        v.status = later.size >= config.acceptAfterSessions ? "accepted_by_default" : "proposed";
      }
    }
    slot.current = slot.versions.slice(slot.liveFrom).reverse().find((v) => v.status !== "rejected");
  }

  // A premise is stale only when what it says changed: a new value, retired, deleted or rejected.
  // A new version that keeps the value (a reworded rationale, a re-confirmation from before slot.relocked existed) passes through.
  const staleOf = (deps: Dep[]): StaleDep[] =>
    deps.flatMap((d) => {
      const s = slots.get(d.key);
      const cur = s?.current;
      const locked = s?.versions[d.n - 1];
      if (cur && !cur.retired && locked && !locked.retired && locked.value === cur.value) return [];
      return [{ key: d.key, locked: d.n, current: cur?.n ?? 0, ...(!cur || cur.retired ? { gone: true } : {}) }];
    });

  // Stale markers, and the questions generated from stale premises
  for (const slot of slots.values()) {
    const cur = slot.current;
    if (!cur || cur.retired) continue;
    slot.stale = staleOf(cur.depends);
    for (const dep of slot.stale) {
      const qid = staleQuestionId(slot.key, cur.n, dep.key, dep.current);
      const depSlot = slots.get(dep.key);
      const oldV = depSlot?.versions[dep.locked - 1];
      const newV = depSlot?.current;
      const change = newV
        ? newV.retired
          ? `was retired (it was "${oldV?.value ?? "?"}")`
          : `changed from "${oldV?.value ?? "?"}" to "${newV.value}"`
        : depSlot?.deleted ? "was deleted" : "was rejected";
      questions.set(qid, {
        qid,
        about: [slot.key, dep.key],
        text: `${slot.key} is currently "${cur.value}" because: ${cur.rationale}. But ${dep.key}, which it depends on, ${change}. Does this decision still hold?`,
        options: [
          { id: "A", label: "Still holds, keep it" },
          { id: "B", label: "Needs a new decision" },
        ],
        origin: "stale_premise",
        status: "open",
        at: newV?.at ?? cur.at,
        premise: { slot: slot.key, n: cur.n, dep },
      });
    }
  }

  // A task needs review only when a decision it is based on changed. When that decision is itself waiting on a changed premise
  // (an MSI installer based on the Windows env, whose premise changed), the task waits for that review instead of asking for its own:
  // confirming the decision clears it, and a new value makes it needs_review.
  for (const t of tasks.values()) {
    t.needsReview = staleOf(t.basedOn);
    t.waitingOn = t.basedOn
      .filter((d) => !t.needsReview.some((x) => x.key === d.key) && (slots.get(d.key)?.stale.length ?? 0) > 0)
      .map((d) => d.key);
    t.status = t.needsReview.length && t.progress !== "dropped" ? "needs_review" : t.progress;
    if (t.handoff) t.handoff.changed = staleOf(t.handoff.basedOn);
  }
  for (const q of questions.values()) if (answered.has(q.qid)) q.status = "answered";

  return { slots, tasks, questions, sessions };
}

/** Decisions nothing live uses any more: once relied on by a decision or a task, now only by retired decisions and dropped tasks.
 *  Goals and constraints stand on their own, so they never count. A suspended task still counts, and so does a verified one even when archived: the work it did is there. */
export function orphans(state: State): SlotState[] {
  const used = new Set<SlotKey>();
  const ever = new Set<SlotKey>();
  for (const s of state.slots.values()) {
    for (const v of s.versions) for (const d of v.depends) ever.add(d.key);
    if (s.current && !s.current.retired && !s.deleted) for (const d of s.current.depends) used.add(d.key);
  }
  for (const t of state.tasks.values()) {
    for (const d of t.basedOn) {
      ever.add(d.key);
      if (t.progress !== "dropped") used.add(d.key);
    }
  }
  return [...state.slots.values()].filter((s) =>
    s.current && !s.current.retired && !s.deleted && !["goal", "constraint"].includes(s.category) && ever.has(s.key) && !used.has(s.key));
}

/** Every live slot whose current version depends on key */
export function dependentsOf(state: State, key: SlotKey): SlotState[] {
  return [...state.slots.values()].filter((s) => s.current && !s.current.retired && s.current.depends.some((d) => d.key === key));
}
