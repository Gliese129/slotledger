import { shortHash } from "./store.js";
import type { AnyEvent, Category, Config, Dep, Evidence, HumanTag, QOption, SlotKey, Snapshot, TaskStatus } from "./types.js";
import { categoryOf } from "./types.js";

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
}

export interface StaleDep {
  key: SlotKey;
  locked: number;
  current: number;
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
  status: TaskStatus;
  note?: string;
  evidence?: Evidence & { at: string };
  lastFailed?: Evidence & { at: string };
  session?: string;
  needsReview: StaleDep[];
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
  return "sq-" + shortHash(`${slot}@${n}|${dep}@${depN}`);
}

/** Fold events in order into the current state. Every judgment (stale, confirmation status, stale-premise questions) is derived here, never stored. */
export function fold(events: AnyEvent[], config: Config): State {
  const slots = new Map<SlotKey, SlotState>();
  const tasks = new Map<string, TaskState>();
  const questions = new Map<string, QuestionState>();
  const sessions = new Map<string, SessionState>();
  const answered = new Set<string>();
  const sessionStarts: { id: string; at: string }[] = [];

  for (const ev of events) {
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
        // a re-pointed copy keeps who decided it, whether it was confirmed, and how long it has stood
        const prev = d.inherit ? slot.versions[d.inherit - 1] : undefined;
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
          userQuote: d.userQuote ?? prev?.userQuote,
          session: prev ? prev.session : sid,
          at: ev.at,
          since: prev ? prev.since : ev.at,
          eventId: ev.id,
          confirmed: prev?.confirmed ?? false,
          status: "proposed",
          ...(prev?.tag ? { tag: prev.tag } : ev.actor.kind === "human" && ev.actor.channel === "web" && d.action === "edit" ? { tag: "human-edit" as const } : source === "user" ? { tag: "human-decided" as const } : {}),
        });
        if (sid) {
          const s = sessions.get(sid);
          if (s && !s.wrote.includes(d.key)) s.wrote.push(d.key);
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
          tasks.set(d.slug, { slug: d.slug, title: d.title, basedOn: d.basedOn ?? [], rootCause: d.rootCause, status: "todo", session: sid, needsReview: [] });
        }
        break;
      }
      case "task.status": {
        const t = tasks.get(ev.data.slug);
        if (t) { t.status = ev.data.status; t.note = ev.data.note; }
        break;
      }
      case "task.verified": {
        const t = tasks.get(ev.data.slug);
        if (t) { t.status = "verified"; t.evidence = { ...ev.data, at: ev.at }; }
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

  const currentN = (k: SlotKey) => slots.get(k)?.current?.n ?? 0;
  const staleOf = (deps: Dep[]) =>
    deps.filter((d) => currentN(d.key) !== d.n).map((d) => ({ key: d.key, locked: d.n, current: currentN(d.key) }));

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

  // A task also needs review when a decision it is based on has a stale premise (e.g. an MSI installer based on the Windows platform, whose premise changed)
  for (const t of tasks.values()) {
    const direct = staleOf(t.basedOn);
    const indirect = t.basedOn
      .filter((d) => !direct.some((x) => x.key === d.key) && (slots.get(d.key)?.stale.length ?? 0) > 0)
      .map((d) => ({ key: d.key, locked: d.n, current: d.n }));
    t.needsReview = [...direct, ...indirect];
  }
  for (const q of questions.values()) if (answered.has(q.qid)) q.status = "answered";

  return { slots, tasks, questions, sessions };
}

/** Every live slot whose current version depends on key */
export function dependentsOf(state: State, key: SlotKey): SlotState[] {
  return [...state.slots.values()].filter((s) => s.current && !s.current.retired && s.current.depends.some((d) => d.key === key));
}
