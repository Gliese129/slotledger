/** Named by the role a decision plays, not by domain, so research, writing and planning projects fit as well as software */
export const CATEGORIES = ["goal", "approach", "env", "assum", "dep", "constraint"] as const;
export type Category = (typeof CATEGORIES)[number];
export type SlotKey = `${Category}/${string}`;

/** Earlier names, still accepted in input and read from older events */
export const LEGACY_CATEGORIES: Record<string, Category> = { product: "goal", arch: "approach", platform: "env" };

// Categories shown prominently, for a human to look at
export const PROMINENT: Category[] = ["goal", "approach", "env"];
// Categories where overriding a user's decision actually stops
export const GUARDED: Category[] = ["goal", "approach"];

export type Actor =
  | { kind: "agent"; session: string }
  | { kind: "human"; via?: string; channel?: "web" } // via: the session whose AI relayed it; channel: done directly in the web view
  | { kind: "system"; session?: string };

export interface Snapshot {
  head: string | null;
  tree: string;
}

export interface Dep {
  key: SlotKey;
  n: number;
}

export interface EventDataMap {
  "session.started": { session: string; client: { name: string; version: string }; snapshot: Snapshot | null };
  "session.ended": { session: string; snapshot: Snapshot | null };
  "slot.versioned": {
    key: SlotKey;
    value: string;
    rationale: string;
    depends: Dep[];
    topics: string[];
    scope?: string[];
    retired?: boolean;
    userQuote?: string;
    /** On a retirement written by a merge: the slot that replaces this one */
    replacedBy?: SlotKey;
    /** Same decision as version n of this slot, only its dependency keys were re-pointed by a merge */
    inherit?: number;
    /** What a human did in the web view: edit the value, or keep it as is after its premise changed */
    action?: "edit" | "keep";
  };
  /** Removes a slot from everything the AI sees; its events stay for the audit trail */
  "slot.deleted": { key: SlotKey; reason?: string };
  "version.confirmed": { key: SlotKey; n: number; userQuote?: string };
  "version.rejected": { key: SlotKey; n: number; reason: string; replacement?: string };
  "task.created": { slug: string; title: string; basedOn: Dep[]; rootCause?: string };
  "task.status": { slug: string; status: TaskStatus; note?: string };
  /** The AI reviewed a task after decisions it rests on changed and re-locked basedOn to their current versions */
  "task.rebased": { slug: string; basedOn: Dep[]; note: string };
  /** basedOn: on a task that needed review, the pass re-locks it to the decisions as they are now */
  "task.verified": Evidence & { slug: string; basedOn?: Dep[] };
  "task.verify_failed": Evidence & { slug: string };
  "question.asked": { qid: string; about: SlotKey[]; text: string; options?: QOption[] };
  "question.answered": { qid: string; option?: string; text?: string; userQuote?: string };
}

export type EventType = keyof EventDataMap;

export interface Event<T extends EventType = EventType> {
  id: string;
  type: T;
  at: string;
  actor: Actor;
  cause?: string;
  data: EventDataMap[T];
}

export type AnyEvent = { [T in EventType]: Event<T> }[EventType];

/** One status per task. needs_review and verified are never set directly: slotledger derives needs_review when decisions a task rests on change, and only passing evidence sets verified */
export const TASK_STATUSES = ["todo", "in_progress", "implemented", "needs_review", "verified", "dropped"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
/** What a task can be set to with the task tool */
export const SETTABLE_STATUSES = ["todo", "in_progress", "implemented", "dropped"] as const;

export const EVIDENCE_KINDS = ["run", "ref", "human"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** A command slotledger ran itself; events written before evidence kinds existed have no kind */
export interface RunEvidence {
  kind?: "run";
  cmd: string;
  exit: number;
  outputTail: string;
  env: string;
}

/** Evidence produced elsewhere: a report, a receipt, a job ID, a URL. slotledger hashes local files; the pass/fail call is the AI's */
export interface RefEvidence {
  kind: "ref";
  refs: EvidenceRef[];
  summary: string;
  metrics?: Record<string, string | number>;
}

export interface EvidenceRef {
  /** A path in the project, a URL, or an ID in another system (e.g. slurm job 1234) */
  target: string;
  /** sha256 of a local file, taken when the evidence was recorded */
  sha256?: string;
  missing?: boolean;
}

/** A person's acceptance, relayed by the AI with their exact words or given in the web view */
export interface HumanEvidence {
  kind: "human";
  userQuote: string;
  /** What the acceptance covers, e.g. "iPhone 15, iOS 18, signed-in iCloud account" */
  scope?: string;
}

export type Evidence = RunEvidence | RefEvidence | HumanEvidence;

export function evidenceKind(e: Evidence): EvidenceKind {
  return e.kind ?? "run";
}

export interface QOption {
  id: string;
  label: string;
  recommended?: boolean;
}

export interface Topic {
  id: string;
  paths: string[];
}

export const STRICTNESS = ["strict", "balanced", "loose"] as const;
export type Strictness = (typeof STRICTNESS)[number];

export interface Config {
  topics: Topic[];
  acceptAfterSessions: number;
  /** Language the AI writes records in; unset until the user is asked */
  language?: string;
  /** How much the AI is asked to record; unset until the user is asked (behaves as balanced) */
  strictness?: Strictness;
}

/** How a human shaped a version, derived from events */
export const HUMAN_TAGS = ["human-edit", "human-approved", "human-rejected", "human-decided"] as const;
export type HumanTag = (typeof HUMAN_TAGS)[number];

/** Map a legacy prefix (product/, arch/, platform/) to its current name; other keys come back unchanged */
export function canonicalKey<K extends string>(key: K): K {
  const i = key.indexOf("/");
  const to = i > 0 ? LEGACY_CATEGORIES[key.slice(0, i)] : undefined;
  return (to ? to + key.slice(i) : key) as K;
}

/** The inverse, for ids hashed from keys before the rename, so they stay stable */
export function legacyKey(key: string): string {
  const i = key.indexOf("/");
  const from = Object.entries(LEGACY_CATEGORIES).find(([, to]) => to === key.slice(0, i))?.[0];
  return from ? from + key.slice(i) : key;
}

export function categoryOf(key: string): Category | null {
  const c = canonicalKey(key).split("/")[0];
  return (CATEGORIES as readonly string[]).includes(c) ? (c as Category) : null;
}

/** The same event with every slot key under its current category name */
export function canonicalEvent(ev: AnyEvent): AnyEvent {
  const d = ev.data as Record<string, unknown>;
  const deps = (v: unknown) => (v as Dep[]).map((x) => ({ ...x, key: canonicalKey(x.key) }));
  const next: Record<string, unknown> = { ...d };
  if (typeof d.key === "string") next.key = canonicalKey(d.key);
  if (typeof d.replacedBy === "string") next.replacedBy = canonicalKey(d.replacedBy);
  if (Array.isArray(d.depends)) next.depends = deps(d.depends);
  if (Array.isArray(d.basedOn)) next.basedOn = deps(d.basedOn);
  if (Array.isArray(d.about)) next.about = (d.about as string[]).map(canonicalKey);
  return { ...ev, data: next } as AnyEvent;
}
