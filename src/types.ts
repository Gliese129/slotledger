export const CATEGORIES = ["product", "arch", "platform", "assum", "dep", "constraint"] as const;
export type Category = (typeof CATEGORIES)[number];
export type SlotKey = `${Category}/${string}`;

// Categories shown prominently, for a human to look at
export const PROMINENT: Category[] = ["product", "arch", "platform"];
// Categories where overriding a user's decision actually stops
export const GUARDED: Category[] = ["product", "arch"];

export type Actor =
  | { kind: "agent"; session: string }
  | { kind: "human"; via?: string } // via: the session whose AI relayed it
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
  };
  "version.confirmed": { key: SlotKey; n: number; userQuote?: string };
  "version.rejected": { key: SlotKey; n: number; reason: string; replacement?: string };
  "task.created": { slug: string; title: string; basedOn: Dep[]; rootCause?: string };
  "task.status": { slug: string; status: TaskStatus; note?: string };
  "task.verified": Evidence & { slug: string };
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

export type TaskStatus = "todo" | "in_progress" | "implemented" | "verified" | "dropped";

export interface Evidence {
  cmd: string;
  exit: number;
  outputTail: string;
  env: string;
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

export function categoryOf(key: string): Category | null {
  const c = key.split("/")[0];
  return (CATEGORIES as readonly string[]).includes(c) ? (c as Category) : null;
}
