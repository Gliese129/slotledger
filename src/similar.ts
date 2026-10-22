import type { SlotState, State, TaskState } from "./fold.js";

/**
 * Local, dependency-free text similarity for spotting duplicate slots and searching.
 * The AI decides whether two slots really are the same decision; this only narrows the list.
 */

const STOP = new Set([
  "the", "an", "and", "or", "of", "to", "for", "in", "on", "at", "by", "with", "as", "is", "are", "be", "it", "its",
  "this", "that", "via", "from", "into", "use", "uses", "using", "used", "all", "any", "not", "no", "only", "when", "then",
  "than", "if", "so", "we", "our", "they", "them", "their", "can", "should", "will", "do", "does", "has", "have",
]);

/** Lowercase word tokens for Latin text; overlapping character pairs for CJK runs */
export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const w of lower.match(/[a-z0-9]+/g) ?? []) if (w.length > 1 && !STOP.has(w)) out.add(w);
  for (const run of lower.match(/[㐀-鿿豈-﫿]+/g) ?? []) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

function dice(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return (2 * n) / (a.size + b.size);
}

const nameTokens = (key: string) => tokens(key.slice(key.indexOf("/") + 1).replace(/-/g, " "));

export interface Probe {
  key: string;
  value: string;
}

/** 0..1. Key names count on their own (renamed duplicates) and together with the value (reworded ones). */
export function similarity(a: Probe, b: Probe): number {
  const na = nameTokens(a.key), nb = nameTokens(b.key);
  const score = Math.max(dice(new Set([...na, ...tokens(a.value)]), new Set([...nb, ...tokens(b.value)])), 0.8 * dice(na, nb));
  // the same decision filed under two categories happens, but less often
  return a.key.split("/")[0] === b.key.split("/")[0] ? score : score * 0.6;
}

/** Threshold for asking the AI to check before creating a new key */
export const SIMILAR_AT = 0.4;
/** Threshold for listing a pair as a possible duplicate in brief and the web view */
export const DUPLICATE_AT = 0.5;

const liveSlots = (state: State) => [...state.slots.values()].filter((s) => s.current && !s.current.retired);

export function similarSlots(state: State, probe: Probe, limit = 3): { slot: SlotState; score: number }[] {
  return liveSlots(state)
    .filter((s) => s.key !== probe.key)
    .map((slot) => ({ slot, score: similarity(probe, { key: slot.key, value: slot.current!.value }) }))
    .filter((x) => x.score >= SIMILAR_AT)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function duplicatePairs(state: State, limit = 5): { a: SlotState; b: SlotState; score: number }[] {
  const slots = liveSlots(state);
  const out: { a: SlotState; b: SlotState; score: number }[] = [];
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const a = slots[i], b = slots[j];
      // a decision that depends on the other is related, not a duplicate
      if (a.current!.depends.some((d) => d.key === b.key) || b.current!.depends.some((d) => d.key === a.key)) continue;
      const score = similarity({ key: a.key, value: a.current!.value }, { key: b.key, value: b.current!.value });
      if (score >= DUPLICATE_AT) out.push({ a, b, score });
    }
  }
  return out.sort((x, y) => y.score - x.score).slice(0, limit);
}

/** Share of the query's tokens found in the text, plus a bonus when the query appears verbatim */
function coverage(query: string, q: Set<string>, haystack: string): number {
  const bag = tokens(haystack);
  let n = 0;
  for (const x of q) if (bag.has(x)) n++;
  return (q.size ? n / q.size : 0) + (haystack.toLowerCase().includes(query.toLowerCase()) ? 0.5 : 0);
}

export function search(state: State, query: string, limit = 10): { slots: SlotState[]; tasks: TaskState[] } {
  const q = tokens(query.replace(/[/-]/g, " "));
  const slotText = (s: SlotState) => {
    const v = s.current ?? s.versions[s.versions.length - 1];
    return `${s.key} ${s.key.replace(/[/-]/g, " ")} ${v.value} ${v.rationale} ${s.topics.join(" ")}`;
  };
  const rank = <T>(items: T[], text: (x: T) => string, boost: (x: T) => number) =>
    items
      .map((x) => ({ x, score: coverage(query, q, text(x)) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score + boost(b.x) - (a.score + boost(a.x)))
      .slice(0, limit)
      .map((r) => r.x);
  return {
    // live slots first; retired ones still show up so an old key can be revived
    slots: rank([...state.slots.values()], slotText, (s) => (s.current && !s.current.retired ? 0.25 : 0)),
    tasks: rank([...state.tasks.values()], (t) => `${t.slug} ${t.slug.replace(/-/g, " ")} ${t.title} ${t.note ?? ""}`, (t) => (t.status === "dropped" ? 0 : 0.25)),
  };
}
