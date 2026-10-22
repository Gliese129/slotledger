import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { join, resolve } from "node:path";
import { analyze, slotTopics, type Analysis } from "./analyze.js";
import { dependentsOf, fold, orphans, type State } from "./fold.js";
import { buildExport, renderExport, type ExportFormat } from "./export.js";
import { changedFiles, snapshot } from "./git.js";
import { buildNudge, buildReport, formatNudge, removedPremiseText, renderBrief, renderSearch, renderStatusMd, renderTask, reviewHint, type Report } from "./report.js";
import { strictnessOf } from "./settings.js";
import { similarSlots } from "./similar.js";
import { Store, ulid } from "./store.js";
import type { Actor, AnyEvent, Dep, EvidenceRef, QOption, SlotKey, TaskStatus } from "./types.js";
import { CATEGORIES, GUARDED, canonicalEvent, canonicalKey, categoryOf } from "./types.js";

/** Errors the AI can fix itself: the message says how */
export class FixableError extends Error {}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export interface RecordInput {
  key: string;
  /** Left out (with rationale) only to mark dependents unaffected by the slot's latest change */
  value?: string;
  rationale?: string;
  depends?: string[];
  topics?: string[];
  scope?: string[];
  retired?: boolean;
  userQuote?: string;
  /** Confirms a new key is a separate decision after the similar-key check */
  new?: boolean;
  /** Keys this decision merges in; they are retired and their dependents re-pointed here */
  replaces?: string[];
  /** Decisions (keys) and tasks (slugs) resting on this slot that its change doesn't affect, with why */
  unaffected?: { key: string; why: string }[];
}

export interface SplitInput {
  /** Each decision to split, and the finer decisions that replace it; pieces keep its depends unless they give their own */
  splits: { key: string; into: { key: string; value: string; rationale: string; depends?: string[] }[] }[];
  /** For decisions (keys) and tasks (slugs) resting on a split decision: the pieces they actually rest on. Unlisted ones rest on all pieces */
  dependents?: { key: string; on: string[] }[];
  note: string;
  userQuote?: string;
}

export interface ArchiveInput {
  /** Task slugs; ones not verified or dropped are dropped first */
  tasks?: string[];
  /** Decision keys to retire */
  decisions?: string[];
  note: string;
  userQuote?: string;
}

export interface TaskInput {
  slug: string;
  title?: string;
  status?: TaskStatus;
  basedOn?: string[];
  rootCause?: string;
  note?: string;
  /** A one-off handoff note (Markdown) for whoever picks the task up */
  handoff?: string;
  /** Decisions the handoff also rests on, besides basedOn */
  handoffOn?: string[];
  /** Put a task on hold (suspended) or back in play (live); archiving goes through archive */
  lifecycle?: "live" | "suspended";
}

export interface VerifyInput {
  slug: string;
  /** run: a command slotledger runs; exit 0 passes */
  cmd?: string;
  timeoutSec?: number;
  /** ref: paths, URLs, or IDs of evidence produced elsewhere */
  refs?: string[];
  summary?: string;
  metrics?: Record<string, string | number>;
  /** human: the person's exact words accepting (or not accepting) the work */
  userQuote?: string;
  /** human: what the acceptance covers */
  scope?: string;
  /** ref and human: whether it passed */
  passed?: boolean;
}

export interface RespondInput {
  item?: number;
  question?: string;
  choice?: string;
  text?: string;
  withdraw?: boolean;
  userQuote: string;
}

export const HUMAN_ACTIONS = ["edit", "delete", "approve", "reject", "keep", "answer", "check"] as const;

/** Something a person did directly in the web view */
export interface HumanAction {
  action: (typeof HUMAN_ACTIONS)[number];
  key?: string;
  value?: string;
  rationale?: string;
  reason?: string;
  question?: string;
  choice?: string;
  text?: string;
  /** check: the task a person checked, whether it passed, and what the check covered */
  task?: string;
  passed?: boolean;
  scope?: string;
}

const WEB: Actor = { kind: "human", channel: "web" };

/** Decisions that something just made unused, with how to retire them together */
function orphanNote(before: State, after: State): string[] {
  const had = new Set(orphans(before).map((s) => s.key));
  const now = orphans(after).filter((s) => !had.has(s.key));
  if (!now.length) return [];
  return [
    `Nothing live uses these any more: ${now.map((s) => `${s.key} "${s.current!.value}"`).join("; ")}. ` +
      `If they're no longer needed, retire them together: archive({ decisions: [${now.map((s) => `"${s.key}"`).join(", ")}], note }).`,
  ];
}

export interface Client {
  name: string;
  version: string;
}

export class Board {
  constructor(readonly store: Store) {}

  load(): { events: AnyEvent[]; state: State } {
    const events = this.store.readEvents().map(canonicalEvent);
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

  brief(query?: string): string {
    const { state } = this.load();
    if (query?.trim()) return renderSearch(state, canonicalKey(query.trim()));
    return renderBrief(state, this.store.readConfig(), this.store.errorCount());
  }

  export(format: ExportFormat = "markdown"): string {
    const { events, state } = this.load();
    return renderExport(buildExport(state, events, this.store.root), format);
  }

  // ---------- record ----------

  record(session: string, raw: RecordInput): string {
    const input = {
      ...raw, key: canonicalKey(raw.key), depends: raw.depends?.map(canonicalKey), replaces: raw.replaces?.map(canonicalKey),
      unaffected: raw.unaffected?.map((u) => ({ key: u.key.includes("/") ? canonicalKey(u.key) : u.key, why: u.why?.trim() ?? "" })),
    };
    const cat = categoryOf(input.key);
    if (!cat) {
      return `Nothing recorded: execution details don't get slots. If this really is a decision, the key must start with a category: ${CATEGORIES.map((c) => c + "/").join(" ")}, e.g. approach/sync-backend.`;
    }
    const name = input.key.slice(cat.length + 1);
    if (!SLUG.test(name)) throw new FixableError(`Key must look like <category>/<lowercase-dashed-name>, e.g. ${cat}/sync-backend; got ${input.key}.`);
    const key = input.key as SlotKey;
    if (cat === "constraint" && input.value !== undefined && !input.scope?.length) throw new FixableError("A constraint needs scope (the paths or area it covers), e.g. scope: [\"src/legacy/**\"].");

    const { state } = this.load();
    const unaffected = input.unaffected ?? [];
    if (unaffected.length) this.checkUnaffected(state, key, unaffected);
    if (input.value === undefined) {
      if (!unaffected.length) throw new FixableError("value and rationale are required. Leave them out only to mark dependents unaffected: record({ key, unaffected: [{ key, why }] }).");
      const lines = this.markUnaffected(session, state, key, unaffected);
      this.writeStatus();
      return lines.join("\n");
    }
    if (!input.rationale?.trim()) throw new FixableError("rationale is required: why this decision, stated clearly enough to question it when a premise changes.");
    const value = input.value;
    const rationale = input.rationale;
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

    const replaces: SlotKey[] = [];
    for (const r of new Set(input.replaces ?? [])) {
      if (r === key) throw new FixableError("A slot can't replace itself.");
      const rs = state.slots.get(r as SlotKey);
      if (!rs?.current || rs.current.retired) throw new FixableError(`${r} in replaces isn't a live slot. Check the key with brief({ query }).`);
      if (depends.some((d) => d.key === r)) throw new FixableError(`${key} can't depend on ${r}, which it replaces.`);
      const userOwned = rs.current.source === "user" || rs.current.confirmed;
      if (userOwned && GUARDED.includes(rs.category) && !input.userQuote) {
        throw new FixableError(`${r} is the user's decision (v${rs.current.n} "${rs.current.value}"). Ask the user before merging it away; once they agree, call again with their words in userQuote.`);
      }
      replaces.push(r as SlotKey);
    }

    // A brand-new key that looks like an existing one: ask once instead of silently adding a near-duplicate
    if (!slot && !input.new && !replaces.length && !input.retired) {
      const similar = similarSlots(state, { key, value });
      if (similar.length) {
        throw new FixableError([
          `Not recorded yet: ${key} is a new key, but these live decisions look similar:`,
          ...similar.map(({ slot: s }) => `- ${s.key} v${s.current!.n} "${s.current!.value}"`),
          `Same decision: record it under that key instead (that makes a new version). Merging them: pass replaces with the old key(s). A separate decision: call again with new: true.`,
        ].join("\n"));
      }
    }

    if (cur) {
      const userOwned = cur.source === "user" || cur.confirmed;
      const changes = cur.value !== value || !!input.retired !== !!cur.retired;
      if (userOwned && changes && GUARDED.includes(cat) && !input.userQuote) {
        throw new FixableError(
          `${key} is currently the user's decision (v${cur.n} "${cur.value}"). Ask the user before changing it; once they agree, call again with their words in userQuote.`,
        );
      }
      const sameDeps = !depends.length || JSON.stringify(depends.map((d) => d.key).sort()) === JSON.stringify(cur.depends.map((d) => d.key).sort());
      const sameScope = JSON.stringify(cur.scope ?? []) === JSON.stringify(input.scope ?? cur.scope ?? []);
      // Still holds after a premise changed: re-lock its premises instead of writing a new version, so nothing downstream changes
      if (!changes && sameDeps && sameScope && slot!.stale.length && !replaces.length) {
        const gone = slot!.stale.filter((d) => d.gone);
        if (gone.length) throw new FixableError(`Not recorded: ${gone.map((d) => d.key).join(", ")} ${gone.length > 1 ? "are" : "is"} gone, so re-confirming would quietly drop ${gone.length > 1 ? "them" : "it"}. Decide explicitly:\n${gone.map((d) => removedPremiseText(state, d.key)).join("\n")}`);
        this.store.append("slot.relocked", { kind: "agent", session }, {
          key, n: cur.n, depends: this.relock(state, cur.depends), note: rationale, ...(input.userQuote ? { userQuote: input.userQuote } : {}),
        });
        const out = [`${key} v${cur.n} still holds after ${slot!.stale.map((d) => d.key).join(", ")} changed; its premises are re-locked, with no new version, so nothing that rests on it needs review.`];
        if (unaffected.length) out.push(...this.markUnaffected(session, this.load().state, key, unaffected));
        this.writeStatus();
        return out.join("\n");
      }
      if (!changes && sameDeps && sameScope && !input.userQuote && !replaces.length) {
        if (!unaffected.length) return `${key} is unchanged; nothing recorded.`;
        const out = this.markUnaffected(session, state, key, unaffected);
        this.writeStatus();
        return out.join("\n");
      }
      // Re-confirming after review: same value and no depends given, so keep the old deps locked to their current versions
      if (!depends.length && cur.depends.length) {
        for (const d of cur.depends) {
          const n = state.slots.get(d.key)?.current?.n;
          if (n && !replaces.includes(d.key)) depends.push({ key: d.key, n });
        }
      }
    }

    const main = this.store.append("slot.versioned", { kind: "agent", session }, {
      key,
      value,
      rationale,
      depends,
      topics: input.topics ?? [],
      ...(input.scope?.length ? { scope: input.scope } : cur?.scope ? { scope: cur.scope } : {}),
      ...(input.retired ? { retired: true } : {}),
      ...(input.userQuote ? { userQuote: input.userQuote } : {}),
    });
    const merged = replaces.length ? this.merge(session, state, key, (slot?.versions.length ?? 0) + 1, replaces, main.id, input.userQuote) : null;

    const after = this.load().state;
    this.writeStatus(after);
    const now = after.slots.get(key)!;
    const v = now.current!;
    const out: string[] = [`Recorded ${key} v${v.n} (${v.source === "user" ? "user decision" : "proposal, awaiting user confirmation or default acceptance"}).`];
    if (cur) out.push(`Replaces v${cur.n} "${cur.value}".`);
    if (merged) out.push(...merged);

    if (unaffected.length) out.push(...this.markUnaffected(session, after, key, unaffected));
    const dependents = dependentsOf(after, key);
    const changed = cur && (cur.value !== value || !!input.retired !== !!cur.retired);
    if (changed) {
      const done = new Set(unaffected.map((u) => u.key));
      const open = this.restingOn(this.load().state, key).filter((k) => !done.has(k));
      if (open.length) {
        out.push(
          `These rest on it and now need review: ${open.join(", ")}. Name every one this change doesn't affect in a single call, ` +
            `record({ key: "${key}", unaffected: [{ key, why }, ...] }), and review only the rest.`,
        );
      }
      // Most of what rests on it didn't care about this change: it probably bundles decisions that change separately
      if (unaffected.length >= 2 && unaffected.length * 2 >= unaffected.length + open.length) {
        out.push(
          `Most of what rests on ${key} isn't affected by this change, so it likely holds several decisions that change separately. ` +
            `Consider splitting it, and pointing each dependent at the pieces it really rests on: split({ splits: [{ key: "${key}", into: [{ key, value, rationale }, ...] }], dependents: [{ key, on: [pieces] }], note }).`,
        );
      }
    }
    if (input.retired) out.push(...orphanNote(state, this.load().state));
    if (!input.depends?.length && !cur?.depends.length && !input.retired) {
      const config = this.store.readConfig();
      const mine = new Set(slotTopics(now, config.topics));
      const downstream = new Set(dependents.map((d) => d.key));
      const candidates = [...after.slots.values()].filter(
        (s) => s.key !== key && !downstream.has(s.key) && s.current && !s.current.retired &&
          (["assum", "env", "constraint"].includes(s.category) || slotTopics(s, config.topics).some((t) => mine.has(t))),
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

  /** Decisions (keys) and tasks (slugs) that rest on key: the ones its change asks to review */
  private restingOn(state: State, key: SlotKey): string[] {
    const slots = dependentsOf(state, key).filter((s) => s.stale.some((d) => d.key === key)).map((s) => s.key as string);
    const tasks = [...state.tasks.values()].filter((t) => t.lifecycle === "live" && t.progress !== "dropped" && t.needsReview.some((d) => d.key === key)).map((t) => t.slug);
    return [...slots, ...tasks];
  }

  /** Every unaffected item must be a live decision or task resting on key, with a reason; checked before anything is written */
  private checkUnaffected(state: State, key: SlotKey, items: { key: string; why: string }[]): void {
    const problems: string[] = [];
    for (const u of items) {
      if (!u.why) problems.push(`${u.key}: why is required`);
      else if (u.key.includes("/")) {
        const cur = state.slots.get(u.key as SlotKey)?.current;
        if (!cur || cur.retired) problems.push(`${u.key} isn't a live decision`);
        else if (!cur.depends.some((d) => d.key === key)) problems.push(`${u.key} doesn't depend on ${key}`);
      } else {
        const t = state.tasks.get(u.key);
        if (!t) problems.push(`task ${u.key} doesn't exist`);
        else if (!t.basedOn.some((d) => d.key === key)) problems.push(`task ${u.key} isn't based on ${key}`);
      }
    }
    if (problems.length) throw new FixableError(`Nothing recorded; fix unaffected: ${problems.join("; ")}. Decisions go by key, tasks by slug.`);
  }

  /** Re-lock key in each unaffected decision and task to key's current version */
  private markUnaffected(session: string, state: State, key: SlotKey, items: { key: string; why: string }[]): string[] {
    const actor: Actor = { kind: "agent", session };
    const cur = state.slots.get(key)?.current;
    const n = cur && !cur.retired ? cur.n : undefined;
    // re-lock to the new version, or drop the dependency when key is gone
    const relockKey = (deps: Dep[]) => deps.flatMap((d) => (d.key !== key ? [d] : n ? [{ key, n }] : []));
    for (const u of items) {
      if (u.key.includes("/")) {
        const slot = state.slots.get(u.key as SlotKey)!;
        this.store.append("slot.relocked", actor, { key: slot.key, n: slot.current!.n, depends: relockKey(slot.current!.depends), note: u.why });
      } else {
        const t = state.tasks.get(u.key)!;
        this.store.append("task.rebased", actor, { slug: t.slug, basedOn: relockKey(t.basedOn), note: u.why });
      }
    }
    return [n ? `Marked unaffected by ${key}: ${items.map((u) => u.key).join(", ")}.` : `Dropped the dependency on ${key} from: ${items.map((u) => u.key).join(", ")}.`];
  }

  // ---------- split ----------

  split(session: string, input: SplitInput): string {
    const note = input.note?.trim();
    if (!note) throw new FixableError("split needs a note: why these decisions are being split.");
    if (!input.splits?.length) throw new FixableError("Pass splits: [{ key, into: [{ key, value, rationale }, ...] }].");
    const { state } = this.load();
    const problems: string[] = [];
    const pieces = new Map<SlotKey, SlotKey[]>();
    const newKeys = new Set<SlotKey>();
    for (const sp of input.splits) {
      const key = canonicalKey(sp.key) as SlotKey;
      const cur = state.slots.get(key)?.current;
      if (!cur || cur.retired) { problems.push(`${sp.key} isn't a live decision`); continue; }
      if (pieces.has(key)) { problems.push(`${key} is split twice`); continue; }
      if ((sp.into ?? []).length < 2) problems.push(`${key} needs at least two pieces`);
      const keys: SlotKey[] = [];
      for (const p of sp.into ?? []) {
        const k = canonicalKey(p.key) as SlotKey;
        const cat = categoryOf(k);
        if (!cat || !SLUG.test(k.slice(cat.length + 1))) problems.push(`${p.key} isn't a valid key (<category>/<dashed-name>)`);
        else if (newKeys.has(k)) problems.push(`${k} is used for two pieces`);
        else if (state.slots.get(k)?.current && !state.slots.get(k)!.current!.retired) problems.push(`${k} is already a live decision; pieces need new keys`);
        else if (!p.value?.trim() || !p.rationale?.trim()) problems.push(`${k} needs value and rationale`);
        newKeys.add(k);
        keys.push(k);
      }
      pieces.set(key, keys);
    }
    for (const k of newKeys) if (pieces.has(k)) problems.push(`${k} is being split, so it can't be a piece`);
    if (problems.length) throw new FixableError(`Nothing split: ${problems.join("; ")}.`);

    // A dependency on a decision being split, expanded to the given pieces (or all of them)
    const expand = (deps: SlotKey[], chosen?: Set<SlotKey>): SlotKey[] =>
      [...new Set(deps.flatMap((k) => (pieces.has(k) ? pieces.get(k)!.filter((p) => !chosen || chosen.has(p)) : [k])))];
    const nOf = (k: SlotKey) => (newKeys.has(k) ? (state.slots.get(k)?.versions.length ?? 0) + 1 : state.slots.get(k)!.current!.n);

    // What rests on a split decision, apart from the decisions being split themselves
    const restingDecisions = [...state.slots.values()].filter((s) => s.current && !s.current.retired && !pieces.has(s.key) && s.current.depends.some((d) => pieces.has(d.key)));
    const restingTasks = [...state.tasks.values()].filter((t) => t.lifecycle !== "archived" && t.progress !== "dropped" && t.basedOn.some((d) => pieces.has(d.key)));
    const chosen = new Map<string, Set<SlotKey>>();
    for (const d of input.dependents ?? []) {
      const id = d.key.includes("/") ? canonicalKey(d.key) : d.key;
      const deps = id.includes("/") ? restingDecisions.find((s) => s.key === id)?.current!.depends : restingTasks.find((t) => t.slug === id)?.basedOn;
      if (!deps) { problems.push(`${d.key} doesn't rest on a decision being split`); continue; }
      const allowed = new Set(deps.flatMap((x) => pieces.get(x.key) ?? []));
      const on = (d.on ?? []).map((k) => canonicalKey(k) as SlotKey);
      for (const k of on) if (!allowed.has(k)) problems.push(`${d.key} can only rest on pieces of what it depended on (${[...allowed].join(", ")}); got ${k}`);
      chosen.set(id, new Set(on));
    }
    for (const sp of input.splits) {
      for (const p of sp.into) for (const dep of p.depends ?? []) {
        const k = canonicalKey(dep) as SlotKey;
        if (k === canonicalKey(p.key)) problems.push(`${p.key} can't depend on itself`);
        else if (!newKeys.has(k) && !pieces.has(k) && !state.slots.get(k)?.current) problems.push(`${p.key} depends on ${dep}, which doesn't exist`);
      }
    }
    if (problems.length) throw new FixableError(`Nothing split: ${problems.join("; ")}.`);

    const actor: Actor = { kind: "agent", session };
    const out: string[] = [];
    for (const sp of input.splits) {
      const key = canonicalKey(sp.key) as SlotKey;
      const slot = state.slots.get(key)!;
      const cur = slot.current!;
      // splitting the user's goal or approach restates it in new words, so the pieces go to the user as proposals unless they agreed
      const keepOwner = !((cur.source === "user" || cur.confirmed) && GUARDED.includes(slot.category) && !input.userQuote);
      for (const p of sp.into) {
        const k = canonicalKey(p.key) as SlotKey;
        const deps = p.depends ? expand(p.depends.map((d) => canonicalKey(d) as SlotKey)) : expand(cur.depends.map((d) => d.key));
        this.store.append("slot.versioned", actor, {
          key: k, value: p.value.trim(), rationale: p.rationale.trim(), depends: deps.map((d) => ({ key: d, n: nOf(d) })), topics: slot.topics,
          ...(cur.scope ? { scope: cur.scope } : {}), splitFrom: { key, n: cur.n, keepOwner }, ...(input.userQuote ? { userQuote: input.userQuote } : {}),
        });
      }
      out.push(`Split ${key} into ${pieces.get(key)!.join(", ")}${keepOwner ? "" : "; they were the user's decision, so the pieces are proposals for them to confirm"}.`);
    }
    const repointed: string[] = [];
    const broad: string[] = [];
    const remap = (deps: Dep[], id: string): Dep[] => {
      const pick = chosen.get(id);
      if (!pick) broad.push(id);
      return expand(deps.map((d) => d.key), pick ? new Set([...pick, ...deps.map((d) => d.key)]) : undefined)
        .map((k) => deps.find((d) => d.key === k) ?? { key: k, n: nOf(k) });
    };
    for (const s of restingDecisions) {
      const depends = remap(s.current!.depends, s.key);
      this.store.append("slot.relocked", actor, { key: s.key, n: s.current!.n, depends, note: `Re-pointed after a split: ${note}`, repoint: true });
      repointed.push(`${s.key} → ${depends.filter((d) => newKeys.has(d.key)).map((d) => d.key).join(", ") || "none of the pieces"}`);
    }
    for (const t of restingTasks) {
      const basedOn = remap(t.basedOn, t.slug);
      this.store.append("task.rebased", actor, { slug: t.slug, basedOn, note: `Re-pointed after a split: ${note}` });
      repointed.push(`${t.slug} → ${basedOn.filter((d) => newKeys.has(d.key)).map((d) => d.key).join(", ") || "none of the pieces"}`);
    }
    for (const [key, keys] of pieces) {
      const cur = state.slots.get(key)!.current!;
      this.store.append("slot.versioned", actor, {
        key, value: cur.value, rationale: `Split into ${keys.join(", ")}: ${note}`, depends: [], topics: [], retired: true, splitInto: keys,
        ...(input.userQuote ? { userQuote: input.userQuote } : {}),
      });
    }
    if (repointed.length) out.push(`Re-pointed, without asking for review: ${repointed.join("; ")}.`);
    if (broad.length) {
      out.push(`Not listed in dependents, so these rest on every piece: ${broad.join(", ")}. If one rests on only some, narrow it: record({ key, value: <same>, rationale, depends }) for a decision, task({ slug, basedOn, note }) for a task.`);
    }
    this.writeStatus();
    return out.join("\n");
  }

  // ---------- archive ----------

  archive(session: string, input: ArchiveInput): string {
    const note = input.note?.trim();
    if (!note) throw new FixableError("archive needs a note: why these are done with.");
    const slugs = [...new Set(input.tasks ?? [])];
    const keys = [...new Set((input.decisions ?? []).map((k) => canonicalKey(k) as SlotKey))];
    if (!slugs.length && !keys.length) throw new FixableError("Pass tasks (slugs) and/or decisions (keys) to archive.");
    const { state } = this.load();
    const problems: string[] = [];
    for (const slug of slugs) {
      const t = state.tasks.get(slug);
      if (!t) problems.push(`task ${slug} doesn't exist`);
      else if (t.lifecycle === "archived") problems.push(`task ${slug} is already archived`);
    }
    for (const key of keys) {
      const slot = state.slots.get(key);
      const cur = slot?.current;
      if (!cur || cur.retired) problems.push(`${key} isn't a live decision`);
      else if ((cur.source === "user" || cur.confirmed) && GUARDED.includes(slot!.category) && !input.userQuote) {
        problems.push(`${key} is the user's decision; retire it only after the user agrees, with their words in userQuote`);
      }
    }
    if (problems.length) throw new FixableError(`Nothing archived: ${problems.join("; ")}.`);

    const actor: Actor = { kind: "agent", session };
    const out: string[] = [];
    for (const slug of slugs) {
      const t = state.tasks.get(slug)!;
      if (t.progress !== "verified" && t.progress !== "dropped") {
        this.store.append("task.status", actor, { slug, status: "dropped", note });
        out.push(`Dropped ${slug} (it was ${t.status}) and archived it.`);
      } else out.push(`Archived ${slug} (${t.progress}).`);
      this.store.append("task.lifecycle", actor, { slug, lifecycle: "archived", note });
    }
    for (const key of keys) {
      const cur = state.slots.get(key)!.current!;
      this.store.append("slot.versioned", actor, {
        key, value: cur.value, rationale: `Retired: ${note}`, depends: cur.depends, topics: [], retired: true,
        ...(cur.scope ? { scope: cur.scope } : {}), ...(input.userQuote ? { userQuote: input.userQuote } : {}),
      });
      out.push(`Retired ${key}.`);
    }
    const after = this.load().state;
    for (const k of keys) if (this.restingOn(after, k).length) out.push(removedPremiseText(after, k));
    out.push(...orphanNote(state, after));
    this.writeStatus(after);
    return out.join("\n");
  }

  // ---------- task ----------

  task(session: string, input: TaskInput): string {
    if (!SLUG.test(input.slug)) throw new FixableError(`Slugs use lowercase letters, digits, and dashes, e.g. migrate-platform-to-macos; got ${input.slug}.`);
    if (input.status === "verified") throw new FixableError(`Only verify can set verified: verify({ slug: "${input.slug}", cmd: "<test command>" }).`);
    if (input.status === "needs_review") throw new FixableError("needs_review is set by slotledger when decisions a task rests on change; it can't be set directly.");
    const actor: Actor = { kind: "agent", session };
    const { state } = this.load();
    const out: string[] = [];
    const t = state.tasks.get(input.slug);
    const basedOn = input.basedOn && this.lockBasis(state, input.basedOn);
    if (!t) {
      if (!input.title) throw new FixableError(`Task ${input.slug} doesn't exist. Creating it needs a title.`);
      this.store.append("task.created", actor, { slug: input.slug, title: input.title, basedOn: basedOn ?? [], ...(input.rootCause ? { rootCause: input.rootCause } : {}) });
      out.push(`Created task ${input.slug}.`);
    } else if (basedOn) {
      // confirming the task still holds under the decisions as they are now (or re-basing it on others)
      if (!input.note?.trim()) throw new FixableError(`Re-locking basedOn needs a note: why ${input.slug} still holds under the current decisions.`);
      this.store.append("task.rebased", actor, { slug: input.slug, basedOn, note: input.note.trim() });
      out.push(`${input.slug} is now based on ${basedOn.length ? basedOn.map((d) => `${d.key}@${d.n}`).join(", ") : "no decisions"}.`);
    }
    // A new title or root cause, or a note that no status change or re-lock carries, is saved on its own
    const statusChange = !!input.status && input.status !== (t?.progress ?? "todo");
    const rebased = !!t && !!basedOn;
    const lifecycleChange = !!t && !!input.lifecycle && input.lifecycle !== t.lifecycle;
    const title = t && input.title?.trim() && input.title.trim() !== t.title ? input.title.trim() : undefined;
    const rootCause = t && input.rootCause?.trim() && input.rootCause.trim() !== t.rootCause ? input.rootCause.trim() : undefined;
    const note = !rebased && !statusChange && !lifecycleChange && input.note?.trim() && input.note.trim() !== t?.note ? input.note.trim() : undefined;
    if (title || note || rootCause) {
      this.store.append("task.edited", actor, { slug: input.slug, ...(title ? { title } : {}), ...(note ? { note } : {}), ...(rootCause ? { rootCause } : {}) });
      if (t) out.push(`${input.slug}: ${[title && `title is now "${title}"`, note && "note saved", rootCause && "root cause saved"].filter(Boolean).join(", ")}.`);
    }
    if (statusChange) {
      this.store.append("task.status", actor, { slug: input.slug, status: input.status!, ...(input.note ? { note: input.note } : {}) });
      out.push(`${input.slug} → ${input.status}.`);
      if (input.status === "dropped") out.push(...orphanNote(state, this.load().state), `Once it's out of the way, archive({ tasks: ["${input.slug}"], note }) takes it out of the brief.`);
    }
    if (lifecycleChange) {
      const why = input.note?.trim();
      if (!why) throw new FixableError(`Changing ${input.slug} to ${input.lifecycle} needs a note: why.`);
      this.store.append("task.lifecycle", actor, { slug: input.slug, lifecycle: input.lifecycle!, note: why });
      out.push(input.lifecycle === "suspended"
        ? `Suspended ${input.slug}: it leaves the task list and reminders, but the decisions it rests on still count as in use. Resume it with task({ slug: "${input.slug}", lifecycle: "live", note }).`
        : `${input.slug} is live again${t.status === "needs_review" ? `; ${reviewHint(t)}` : "."}`);
    }
    if (input.handoff !== undefined) {
      const text = input.handoff.trim();
      if (!text) throw new FixableError("handoff is empty: write what the next person needs to pick the task up.");
      const fresh = this.load().state;
      const keys = [...fresh.tasks.get(input.slug)!.basedOn.map((d) => d.key as string), ...(input.handoffOn ?? [])];
      const locked = this.lockBasis(fresh, keys);
      this.store.append("task.handoff", actor, { slug: input.slug, text, basedOn: locked });
      out.push(`Wrote the handoff for ${input.slug}${locked.length ? `, against ${locked.map((d) => `${d.key}@${d.n}`).join(", ")}` : ""}. It replaces any earlier one; task({ slug: "${input.slug}" }) shows it, with any of these decisions that change before it's picked up.`);
    }
    if (!out.length) {
      this.writeStatus();
      return renderTask(this.load().state, input.slug);
    }
    const now = this.load().state.tasks.get(input.slug)!;
    if (now.status === "needs_review") out.push(reviewHint(now));
    else if (input.status === "implemented") out.push(`Before calling it done, use verify with evidence: a command to run (cmd), evidence produced elsewhere (refs), or the user's acceptance (userQuote).`);
    this.writeStatus();
    return out.join("\n");
  }

  /** Lock basedOn keys to the current versions; every key must be a live decision */
  private lockBasis(state: State, keys: string[]): Dep[] {
    const out: Dep[] = [];
    for (const k of new Set(keys.map(canonicalKey))) {
      const cur = state.slots.get(k as SlotKey)?.current;
      if (!cur) throw new FixableError(`${k} in basedOn doesn't exist. Record it first, or remove it.`);
      if (cur.retired) throw new FixableError(`${k} in basedOn is retired${cur.replacedBy ? `; use ${cur.replacedBy}` : ""}.`);
      out.push({ key: k as SlotKey, n: cur.n });
    }
    return out;
  }

  /** On a pass: a task that needed review gets its basedOn re-locked, following merges and leaving out decisions that are gone */
  private relockOnPass(state: State, slug: string): { basedOn?: Dep[] } {
    const t = state.tasks.get(slug)!;
    if (t.status !== "needs_review") return {};
    const basedOn: Dep[] = [];
    for (const d of t.basedOn) {
      let s = state.slots.get(d.key);
      if (s?.current?.retired && s.current.replacedBy) s = state.slots.get(s.current.replacedBy);
      const cur = s?.current;
      if (s && cur && !cur.retired && !basedOn.some((x) => x.key === s!.key)) basedOn.push({ key: s.key, n: cur.n });
      // a pass doesn't decide whether the task still stands without a premise that's gone
      else if (!cur || cur.retired) basedOn.push(d);
    }
    return { basedOn };
  }

  // ---------- verify ----------

  /** Attach evidence to a task: a command slotledger runs (run), evidence produced elsewhere (ref), or a person's acceptance (human) */
  verify(session: string, input: VerifyInput): string {
    const { slug } = input;
    const { state } = this.load();
    if (!state.tasks.has(slug)) throw new FixableError(`Task ${slug} doesn't exist. Create it with task first.`);
    const sources = [input.cmd !== undefined, !!input.refs?.length, input.userQuote !== undefined].filter(Boolean).length;
    if (sources !== 1) throw new FixableError("Give exactly one kind of evidence: cmd (slotledger runs it), refs + summary (evidence produced elsewhere), or userQuote (a person's acceptance).");
    if (input.cmd !== undefined) return this.run(session, state, slug, input.cmd, input.timeoutSec);
    if (input.passed === undefined) throw new FixableError("Say whether it passed: passed: true or false.");

    if (input.refs?.length) {
      if (!input.summary?.trim()) throw new FixableError("refs need a summary: what the evidence shows, e.g. \"accuracy 0.93 on the held-out set, report attached\".");
      const refs = input.refs.map((target) => this.resolveRef(target));
      const data = { slug, kind: "ref" as const, refs, summary: input.summary.trim(), ...(input.metrics && Object.keys(input.metrics).length ? { metrics: input.metrics } : {}), ...(input.passed ? this.relockOnPass(state, slug) : {}) };
      this.store.append(input.passed ? "task.verified" : "task.verify_failed", { kind: "agent", session }, data);
      this.writeStatus();
      const missing = refs.filter((r) => r.missing).map((r) => r.target);
      return [
        input.passed ? `Recorded reference evidence for ${slug} (by reference: the pass is your report, not a run slotledger did). ${this.statusAfter(slug)}` : `Recorded failing reference evidence for ${slug}. Task status unchanged.`,
        ...refs.filter((r) => r.sha256).map((r) => `${r.target}: sha256 ${r.sha256!.slice(0, 12)}…`),
        ...(missing.length ? [`Not found in the project: ${missing.join(", ")}. If these are local files, fix the paths and record again; if they live elsewhere, that's fine.`] : []),
      ].join("\n");
    }

    if (!input.userQuote?.trim()) throw new FixableError("userQuote can't be empty: give the person's exact words.");
    const data = { slug, kind: "human" as const, userQuote: input.userQuote, ...(input.scope?.trim() ? { scope: input.scope.trim() } : {}), ...(input.passed ? this.relockOnPass(state, slug) : {}) };
    this.store.append(input.passed ? "task.verified" : "task.verify_failed", { kind: "human", via: session }, data);
    this.writeStatus();
    return input.passed ? `Recorded the user's acceptance (by a person). ${this.statusAfter(slug)}` : `Recorded that the user didn't accept ${slug}. Task status unchanged.`;
  }

  private run(session: string, state: State, slug: string, cmd: string, timeoutSec = 600): string {
    const r = spawnSync("sh", ["-c", cmd], { cwd: this.store.root, encoding: "utf8", timeout: timeoutSec * 1000, maxBuffer: 32 * 1024 * 1024 });
    const output = ((r.stdout ?? "") + (r.stderr ?? "")).trimEnd();
    const outputTail = output.slice(-1500);
    const exit = r.status ?? (r.error ? 124 : 1);
    const env = `${platform()} ${release()} ${arch()}, node ${process.version}`;
    const data = { slug, kind: "run" as const, cmd, exit, outputTail, env };
    if (exit === 0) {
      this.store.append("task.verified", { kind: "system", session }, { ...data, ...this.relockOnPass(state, slug) });
      this.writeStatus();
      return `Passed (exit 0, ${env}). ${this.statusAfter(slug)}`;
    }
    this.store.append("task.verify_failed", { kind: "system", session }, data);
    this.writeStatus();
    const tail = outputTail.split("\n").slice(-20).join("\n");
    return `Failed (exit ${exit}${r.error ? `, ${r.error.message}` : ""}). Task status unchanged.\nEnd of output:\n${tail}`;
  }

  /** What a pass left the task at, and any decision review it still follows */
  private statusAfter(slug: string): string {
    const t = this.load().state.tasks.get(slug)!;
    return `${slug} is now ${t.status}.` + (t.waitingOn.length ? ` It still follows the review of ${t.waitingOn.join(", ")}, whose premises changed: if they change, it comes back for review.` : "");
  }

  /** A local file gets hashed so the evidence names the exact version; URLs and IDs in other systems are kept as given */
  private resolveRef(target: string): EvidenceRef {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return { target };
    const file = resolve(this.store.root, target);
    if (existsSync(file) && statSync(file).isFile()) return { target, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") };
    if (existsSync(file)) return { target };
    // looks like a path (has a slash or a file extension) but isn't there; anything else is an ID such as "slurm job 1234"
    return /\s/.test(target) || !/[/\\]|\.\w{1,8}$/.test(target) ? { target } : { target, missing: true };
  }

  // ---------- ask ----------

  ask(session: string, about: string[], text: string, options?: QOption[]): string {
    const qid = "q-" + ulid().slice(-8).toLowerCase();
    this.store.append("question.asked", { kind: "agent", session }, { qid, about: about.map(canonicalKey) as SlotKey[], text, ...(options?.length ? { options } : {}) });
    this.writeStatus();
    return `Question recorded (${qid}); it will appear in the end-of-turn report. If the user is around, asking directly is faster; record the answer with respond.`;
  }

  // ---------- respond ----------

  respond(session: string, input: RespondInput, via: Actor = { kind: "human", via: session }): string {
    const { state } = this.load();
    let qid = input.question;
    let decision: { key: SlotKey; n: number } | undefined;

    if (input.item !== undefined) {
      const report = this.store.readRun<Report>(`report-${session}.json`);
      const it = report?.items.find((i) => i.no === input.item);
      if (!it) throw new FixableError(`The latest report has no item ${input.item}. Use question (the question ID, shown in brief) instead.`);
      if (it.kind === "question") qid = it.qid;
      else decision = { key: canonicalKey(it.key!), n: it.n! };
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
        this.store.append("slot.relocked", via, {
          key: slot.key, n: cur.n, depends: this.relock(state, cur.depends),
          note: `User confirmed it still holds after ${q.premise.dep.key} became v${q.premise.dep.current}`, userQuote: input.userQuote,
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

  /**
   * Retire the replaced slots and re-point decisions that depended on them to the merged key.
   * Re-pointed versions inherit the old version's source and confirmation, so a merge never demotes a user decision.
   */
  private merge(session: string, state: State, key: SlotKey, n: number, replaces: SlotKey[], cause: string, userQuote?: string): string[] {
    const actor: Actor = { kind: "agent", session };
    for (const r of replaces) {
      const rv = state.slots.get(r)!.current!;
      this.store.append("slot.versioned", actor, {
        key: r, value: rv.value, rationale: `Merged into ${key}.`, depends: [], topics: [], retired: true, replacedBy: key,
        ...(userQuote ? { userQuote } : {}),
      }, cause);
    }
    const gone = new Set<SlotKey>(replaces);
    const repointed: string[] = [];
    for (const s of state.slots.values()) {
      const v = s.current;
      if (!v || v.retired || s.key === key || gone.has(s.key) || !v.depends.some((d) => gone.has(d.key))) continue;
      const depends: Dep[] = [];
      for (const d of v.depends) {
        const next = gone.has(d.key) ? { key, n } : d;
        if (!depends.some((x) => x.key === next.key)) depends.push(next);
      }
      this.store.append("slot.versioned", actor, {
        key: s.key, value: v.value, rationale: v.rationale, depends, topics: [], ...(v.scope ? { scope: v.scope } : {}), inherit: v.n,
      }, cause);
      repointed.push(s.key);
    }
    const tasks = [...state.tasks.values()].filter((t) => t.progress !== "dropped" && t.basedOn.some((b) => gone.has(b.key)));
    return [
      `Retired ${replaces.join(", ")} as merged into ${key}.`,
      ...(repointed.length ? [`Re-pointed ${repointed.length} decision(s) that depended on them to ${key}: ${repointed.join(", ")}. Their values are unchanged; if the merged value changes what they rest on, review them.`] : []),
      ...(tasks.length ? [`Tasks based on the retired slots now need review: ${tasks.map((t) => t.slug).join(", ")}.`] : []),
    ];
  }

  // ---------- Human actions (web view) ----------

  /** Apply an action a person took in the web view. Throws FixableError with a message meant for that person. */
  human(input: HumanAction): string {
    const { state } = this.load();
    if (input.action === "answer") {
      const q = input.question ? state.questions.get(input.question) : undefined;
      if (!q || q.status !== "open") throw new FixableError("That question isn't open any more.");
      const said = input.text?.trim() || (input.choice ? `${input.choice} (${q.options?.find((o) => o.id === input.choice)?.label ?? ""})` : "");
      return this.respond("", { question: q.qid, choice: input.choice, text: input.text?.trim() || undefined, userQuote: `Answered in the web view: ${said}` }, WEB);
    }

    if (input.action === "check") {
      const t = input.task ? state.tasks.get(input.task) : undefined;
      if (!t || t.progress === "dropped") throw new FixableError(`${input.task ?? "That task"} isn't open.`);
      if (typeof input.passed !== "boolean") throw new FixableError("Say whether it passed.");
      const said = input.text?.trim();
      const userQuote = said ? `${input.passed ? "Accepted" : "Not accepted"} in the web view: ${said}` : `${input.passed ? "Accepted" : "Not accepted"} in the web view.`;
      const data = { slug: t.slug, kind: "human" as const, userQuote, ...(input.scope?.trim() ? { scope: input.scope.trim() } : {}), ...(input.passed ? this.relockOnPass(state, t.slug) : {}) };
      this.store.append(input.passed ? "task.verified" : "task.verify_failed", WEB, data);
      this.writeStatus();
      return input.passed ? `Marked ${t.slug} as accepted.` : `Recorded that ${t.slug} doesn't pass yet.`;
    }

    const slot = input.key ? state.slots.get(canonicalKey(input.key) as SlotKey) : undefined;
    if (!slot || slot.deleted) throw new FixableError(`${input.key ?? "That decision"} doesn't exist any more.`);
    const cur = slot.current;
    let out: string;
    switch (input.action) {
      case "delete":
        this.store.append("slot.deleted", WEB, { key: slot.key, ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}) });
        out = `Deleted ${slot.key}. The AI won't see it any more; the key is free to use again.`;
        break;
      case "edit": {
        if (!cur || cur.retired) throw new FixableError(`${slot.key} isn't live, so there's nothing to edit.`);
        const value = input.value?.trim();
        if (!value) throw new FixableError("The value can't be empty.");
        const rationale = input.rationale?.trim() || cur.rationale;
        if (value === cur.value && rationale === cur.rationale) return `${slot.key} is unchanged.`;
        this.store.append("slot.versioned", WEB, {
          key: slot.key, value, rationale, depends: this.relock(state, cur.depends), topics: [], ...(cur.scope ? { scope: cur.scope } : {}), action: "edit",
        });
        out = `Saved ${slot.key} v${slot.versions.length + 1}.`;
        break;
      }
      case "keep": {
        if (!cur || !slot.stale.length) throw new FixableError(`${slot.key} has no changed premise to confirm.`);
        this.store.append("slot.relocked", WEB, {
          key: slot.key, n: cur.n, depends: this.relock(state, cur.depends), note: `Still holds after ${slot.stale.map((d) => d.key).join(", ")} changed`,
        });
        out = `Kept ${slot.key} as it is.`;
        break;
      }
      case "approve":
        if (!cur || cur.retired) throw new FixableError(`${slot.key} isn't live.`);
        if (cur.source === "user" || cur.confirmed) return `${slot.key} is already decided.`;
        this.store.append("version.confirmed", WEB, { key: slot.key, n: cur.n });
        out = `Approved ${slot.key}.`;
        break;
      case "reject":
        if (!cur || cur.retired) throw new FixableError(`${slot.key} isn't live.`);
        if (cur.source === "user" || cur.confirmed) throw new FixableError(`${slot.key} is already decided; edit or delete it instead.`);
        this.store.append("version.rejected", WEB, { key: slot.key, n: cur.n, reason: input.reason?.trim() || "Rejected in the web view." });
        out = `Rejected ${slot.key} v${cur.n}.`;
        break;
      default:
        throw new FixableError(`Unknown action ${input.action}.`);
    }
    this.writeStatus();
    return out;
  }

  /** Lock deps to their current versions; ones that are gone are left out */
  private relock(state: State, deps: Dep[]): Dep[] {
    return deps.flatMap((d) => {
      const cur = state.slots.get(d.key)?.current;
      return cur && !cur.retired ? [{ key: d.key, n: cur.n }] : [];
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
    const strictness = strictnessOf(this.store.readConfig());
    const fresh = buildNudge(state, analysis, strictness).filter((p) => !nudged.has(p.key));
    // loose never interrupts the AI; the same findings still reach the user as notes in the report
    if (!stopHookActive && fresh.length && strictness !== "loose") {
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
      "The user may be replying to the last slotledger report. The numbers mean:",
      ...lines,
      "Answer a question with respond({ item, choice or text, userQuote }); withdraw a decision with respond({ item, withdraw: true, text?: replacement, userQuote }). userQuote is the user's exact words.",
    ].join("\n");
  }
}
