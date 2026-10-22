import type { Analysis } from "./analyze.js";
import type { QuestionState, SlotState, State, TaskState, VersionState } from "./fold.js";
import type { AnyEvent, Category, Dep, Evidence, SlotKey } from "./types.js";
import type { Config, Strictness } from "./types.js";
import { CATEGORIES, GUARDED, compareVersions } from "./types.js";
import { PKG } from "./launch.js";
import { settingsBrief } from "./settings.js";
import { duplicatePairs, search } from "./similar.js";

export const STATUS_LABEL: Record<VersionState["status"], string> = {
  decided: "decided",
  proposed: "proposed",
  accepted_by_default: "accepted by default",
  rejected: "rejected",
};

export const CAT_LABEL: Record<Category, string> = {
  goal: "Goal", approach: "Approach", env: "Environment", assum: "Assumption", dep: "Dependency", constraint: "Constraint",
};

const day = (s: string) => s.slice(0, 16).replace("T", " ");

/** One piece of evidence, naming its source: run (slotledger ran it), ref (produced elsewhere), human (a person's acceptance) */
export function describeEvidence(e: Evidence & { at: string }, passed: boolean): string {
  switch (e.kind) {
    case "ref": {
      const refs = e.refs.map((r) => r.target + (r.sha256 ? ` (sha256 ${r.sha256.slice(0, 12)})` : r.missing ? " (file not found)" : "")).join(", ");
      const metrics = e.metrics ? "; " + Object.entries(e.metrics).map(([k, v]) => `${k}=${v}`).join(", ") : "";
      return `ref: ${passed ? "reported passing" : "reported failing"}, ${e.summary} [${refs}${metrics}] (${day(e.at)})`;
    }
    case "human":
      return `human: ${passed ? "accepted" : "not accepted"}, "${e.userQuote}"${e.scope ? `, covers ${e.scope}` : ""} (${day(e.at)})`;
    default:
      return passed ? `run: \`${e.cmd}\` passed (${e.env}, ${day(e.at)})` : `run: \`${e.cmd}\` failed, exit ${e.exit} (${day(e.at)})`;
  }
}

/** What backs a task's status: the latest pass, or the latest failure when it came after. A pass from before decisions changed is history, not the current state */
export function verificationLine(t: TaskState): string {
  if (t.lastFailed && (!t.evidence || t.lastFailed.at > t.evidence.at)) return `last check failed: ${describeEvidence(t.lastFailed, false)}`;
  if (t.evidence) return (t.status === "needs_review" ? "passed before decisions changed: " : "") + describeEvidence(t.evidence, true);
  return "not verified";
}

/** What the task waits on: decisions it rests on whose own premises are being reviewed */
export function waitingNote(t: TaskState): string {
  return t.waitingOn.length ? ` (waiting on review of ${t.waitingOn.join(", ")})` : "";
}

/** One task in full, for task({ slug }): where it stands, what it rests on, and its handoff with whatever changed since it was written */
export function renderTask(state: State, slug: string): string {
  const t = state.tasks.get(slug)!;
  const value = (k: SlotKey) => state.slots.get(k)?.current;
  const lines = [`# ${t.slug} [${t.status}]${t.lifecycle !== "live" ? ` (${t.lifecycle})` : ""}`, "", t.title];
  if (t.lifecycleNote && t.lifecycle !== "live") lines.push(`${t.lifecycle === "suspended" ? "Suspended" : "Archived"}: ${t.lifecycleNote.note}`);
  if (t.note) lines.push(`Note: ${t.note}`);
  if (t.rootCause) lines.push(`Root cause: ${t.rootCause}`);
  const locked = (d: Dep) => {
    const was = state.slots.get(d.key)?.versions[d.n - 1]?.value ?? "?";
    const now = value(d.key);
    return `${d.key}@${d.n} "${was}"` + (!now ? " (gone)" : now.n !== d.n ? ` (now v${now.n}${now.value !== was ? ` "${now.value}"` : ", same value"})` : "");
  };
  if (t.basedOn.length) lines.push(`Based on: ${t.basedOn.map(locked).join("; ")}`);
  lines.push(`Verification: ${verificationLine(t)}`);
  if (t.status === "needs_review") lines.push(reviewHint(t));
  else if (t.waitingOn.length) lines.push(`Waiting on review of ${t.waitingOn.join(", ")}.`);
  if (t.handoff) {
    lines.push("", `## Handoff (written ${t.handoff.at.slice(0, 16).replace("T", " ")} UTC${t.handoff.session ? `, session ${t.handoff.session.slice(0, 8)}` : ""})`);
    if (t.handoff.changed.length) {
      lines.push("", "⚠ Changed since this was written; where the handoff relies on these, follow the current value:");
      for (const d of t.handoff.changed) {
        const s = state.slots.get(d.key);
        const was = s?.versions[d.locked - 1]?.value ?? "?";
        const now = s?.current;
        lines.push(`- ${d.key}: was "${was}", now ${now ? (now.retired ? (now.splitInto ? `split into ${now.splitInto.join(", ")}` : "retired") : `"${now.value}"`) : "gone"}`);
      }
    }
    lines.push("", t.handoff.text);
  }
  return lines.join("\n");
}

/** What rests on key, directly and further down, as an indented list */
function impactTree(state: State, key: SlotKey, depth = 0, seen = new Set<string>()): string[] {
  if (depth > 4) return [];
  const pad = "  ".repeat(depth + 1);
  const lines: string[] = [];
  for (const s of live(state).filter((x) => x.current!.depends.some((d) => d.key === key))) {
    if (seen.has(s.key)) continue;
    seen.add(s.key);
    const owner = GUARDED.includes(s.category) && (s.current!.source === "user" || s.current!.confirmed) ? " (the user's decision: ask them)" : "";
    lines.push(`${pad}- ${s.key} "${s.current!.value}"${owner}`, ...impactTree(state, s.key, depth + 1, seen));
  }
  for (const t of state.tasks.values()) {
    if (t.lifecycle === "archived" || t.progress === "dropped" || seen.has(t.slug) || !t.basedOn.some((d) => d.key === key)) continue;
    seen.add(t.slug);
    lines.push(`${pad}- task ${t.slug} "${t.title}"${t.lifecycle === "suspended" ? " (suspended)" : ""}`);
  }
  return lines;
}

/** A premise that's gone: the chain resting on it, and the choice to make for each thing directly on it */
export function removedPremiseText(state: State, key: SlotKey): string {
  const slot = state.slots.get(key);
  const how = slot?.deleted ? "was deleted" : slot?.current?.retired ? "was retired" : "was withdrawn";
  return [
    `${key} ${how}. What rests on it, and further down:`,
    ...impactTree(state, key),
    `For each one directly under it, decide: if it stands without ${key}, drop the dependency with record({ key: "${key}", unaffected: [{ key, why }, ...] }); ` +
      `if it only existed because of ${key}, retire or drop it with archive({ decisions, tasks, note }), then decide the same for what rests on it. ` +
      `A task worth keeping for later can be suspended (task({ slug, lifecycle: "suspended", note })), but it still needs this decision when resumed.`,
  ].join("\n");
}

/** Premises that are gone but still rested on */
export function removedPremises(state: State): SlotKey[] {
  const keys = new Set<SlotKey>();
  for (const s of live(state)) for (const d of s.stale) if (d.gone) keys.add(d.key);
  for (const t of state.tasks.values()) if (t.lifecycle === "live" && t.progress !== "dropped") for (const d of t.needsReview) if (d.gone) keys.add(d.key);
  return [...keys];
}

/** Where a task's handoff stands, for task lists */
function handoffNote(t: TaskState): string {
  if (!t.handoff) return "";
  return t.handoff.changed.length
    ? ` · handoff (${t.handoff.changed.map((d) => d.key).join(", ")} changed since): task({ slug: "${t.slug}" })`
    : ` · handoff: task({ slug: "${t.slug}" })`;
}

/** The three ways out of needs_review, for the AI */
export function reviewHint(t: TaskState): string {
  return `${t.slug} needs review: ${t.needsReview.map((d) => `${d.key} v${d.locked}→${d.current ? `v${d.current}` : "gone"}`).join(", ")}. ` +
    `Pick one: re-verify it (a pass re-locks basedOn); confirm it still holds with task({ slug: "${t.slug}", basedOn: [${t.basedOn.map((d) => `"${d.key}"`).join(", ")}], note: "<why>" }); or drop it with status dropped.`;
}

const MAX_LIST = 3;
/** Above this many live decisions, brief lists assumptions and dependencies by key only */
const BRIEF_FULL = 40;

export function live(state: State): SlotState[] {
  const order = (s: SlotState) => CATEGORIES.indexOf(s.category);
  return [...state.slots.values()].filter((s) => s.current && !s.current.retired).sort((a, b) => order(a) - order(b) || a.key.localeCompare(b.key));
}

function staleNote(s: SlotState): string {
  return s.stale.length ? ` ⚠ premise changed: ${s.stale.map((d) => `${d.key} v${d.locked}→${d.current ? `v${d.current}` : "gone"}`).join(", ")}` : "";
}

export function openQuestions(state: State): QuestionState[] {
  return [...state.questions.values()].filter((q) => q.status === "open");
}

/** What a human must answer: questions the AI asked, plus stale-premise questions on goal/approach; the AI reviews the other categories itself */
export function questionsForUser(state: State): QuestionState[] {
  return openQuestions(state).filter((q) => q.origin === "agent" || (q.premise && GUARDED.includes(state.slots.get(q.premise.slot)!.category)));
}

/** Current state for the AI (injected at SessionStart, and the brief tool) */
export function renderBrief(state: State, config: Config, errors = 0): string {
  const lines: string[] = ["# slotledger project state"];
  if (errors) lines.push(`⚠ slotledger failed to sync ${errors} time(s) (.project/run/errors.log); some records may be missing.`);
  if (config.requires && compareVersions(config.requires, PKG.version) > 0) {
    lines.push(`⚠ This project's records need slotledger ${config.requires} or later, and this is ${PKG.version}: some of them are skipped, so this state may be wrong. Tell the user to upgrade with \`npx slotledger@latest init\` before relying on it.`);
  }
  lines.push("", ...settingsBrief(config));

  const slots = live(state);
  if (slots.length) {
    lines.push("", "## Live decisions");
    // with many decisions, keep the lines that matter in full and only name the rest, so brief stays short
    const compact = slots.length > BRIEF_FULL;
    const full = (s: SlotState) => !compact || !["assum", "dep"].includes(s.category) || s.stale.length > 0 || s.current!.status === "proposed";
    for (const s of slots.filter(full)) lines.push(`- ${briefLine(s)}`);
    if (compact) {
      for (const c of ["assum", "dep"] as Category[]) {
        const rest = slots.filter((s) => s.category === c && !full(s));
        if (rest.length) lines.push(`- ${c} (${rest.length} more, by key): ${rest.map((s) => s.key).join(", ")}`);
      }
    }
  } else {
    lines.push("", "No decisions recorded yet.");
  }

  const dups = duplicatePairs(state, MAX_LIST);
  if (dups.length) {
    lines.push("", "## Possible duplicates");
    for (const d of dups) lines.push(`- ${d.a.key} "${d.a.current!.value}" ≈ ${d.b.key} "${d.b.current!.value}"`);
    lines.push("If two are the same decision, merge them: record the one to keep with replaces: [the other]. If they're different, leave them.");
  }

  const removed = removedPremises(state);
  if (removed.length) {
    lines.push("", "## Removed premises");
    for (const k of removed) lines.push(removedPremiseText(state, k));
  }

  const qs = openQuestions(state);
  if (qs.length) {
    lines.push("", "## Open questions");
    for (const q of qs) lines.push(`- (${q.qid}) ${q.text}`);
  }

  const tasks = [...state.tasks.values()].filter((t) => t.lifecycle === "live" && t.status !== "dropped" && t.status !== "verified");
  const suspended = [...state.tasks.values()].filter((t) => t.lifecycle === "suspended" && t.progress !== "dropped");
  if (tasks.length || suspended.length) {
    lines.push("", "## Tasks");
    for (const t of tasks) {
      const review = t.status === "needs_review" ? ` (changed: ${t.needsReview.map((d) => d.key).join(", ")})` : waitingNote(t);
      lines.push(`- ${t.slug} [${t.status}] ${t.title}${review}${handoffNote(t)}`);
    }
    if (suspended.length) lines.push(`- Suspended: ${suspended.map((t) => t.slug).join(", ")} (task({ slug }) shows one; lifecycle "live" resumes it)`);
  }

  lines.push(
    "",
    "Use record when you make or change a decision; task when you start or advance work; verify with evidence (a command, a reference, or the user's acceptance) before claiming something is done; respond when the user replies to numbers in a report.",
    "Before adding a new key, look for an existing one with brief({ query }); reuse or merge instead of adding near-duplicates.",
    "Keep plans, todos, and decisions here; don't write separate PLAN/TODO/handoff documents.",
  );
  return lines.join("\n");
}

function briefLine(s: SlotState): string {
  const v = s.current!;
  const deps = v.depends.length ? ` · depends on ${v.depends.map((d) => `${d.key}@${d.n}`).join(", ")}` : "";
  const scope = v.scope?.length ? ` · scope ${v.scope.join(", ")}` : "";
  return `${s.key} v${v.n} "${v.value}" (${STATUS_LABEL[v.status]}${v.tag ? `, ${v.tag}` : ""})${deps}${scope}${staleNote(s)}`;
}

/** brief({ query }): the slots and tasks that best match, including retired slots so an old key can be reused */
export function renderSearch(state: State, query: string): string {
  const { slots, tasks } = search(state, query);
  const lines: string[] = [`# slotledger matches for "${query}"`];
  if (slots.length) {
    lines.push("", "## Decisions");
    for (const s of slots) {
      const v = s.current ?? s.versions[s.versions.length - 1];
      const gone = !s.current ? " (rejected)" : v.retired ? ` (retired${v.replacedBy ? `, merged into ${v.replacedBy}` : ""})` : "";
      lines.push(gone ? `- ${s.key} v${v.n} "${v.value}"${gone}` : `- ${briefLine(s)}`);
      if (!gone) lines.push(`  why: ${v.rationale}`);
    }
  }
  if (tasks.length) {
    lines.push("", "## Tasks");
    for (const t of tasks) lines.push(`- ${t.slug} [${t.status}] ${t.title}`);
  }
  if (!slots.length && !tasks.length) lines.push("", "Nothing matches. Try other words, or brief() with no query for everything.");
  else lines.push("", "Reuse a matching key to update it (a new version); merge duplicates with record({ ..., replaces: [old keys] }).");
  return lines.join("\n");
}

/** Read-only snapshot STATUS.md, for humans */
export function renderStatusMd(state: State): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const date = (s: string) => s.slice(0, 16).replace("T", " ");
  const out: string[] = [
    "<!-- Generated; do not edit by hand. Source: .project/events.jsonl. Live view: npx slotledger web -->",
    "# Project status",
    "",
  ];

  const slots = live(state);
  out.push("## Live decisions", "");
  if (slots.length) {
    out.push("| Category | Slot | Current value | Status | Source | Updated | Notes |", "|---|---|---|---|---|---|---|");
    for (const s of slots) {
      const v = s.current!;
      const notes = [
        s.stale.length ? `⚠ premise changed (${s.stale.map((d) => d.key).join(", ")})` : "",
        v.scope?.length ? `scope: ${v.scope.join(", ")}` : "",
      ].filter(Boolean).join("; ");
      out.push(`| ${CAT_LABEL[s.category]} | ${s.key} | ${esc(v.value)} | ${STATUS_LABEL[v.status]} | ${v.source === "user" ? "user" : "AI"} | ${date(v.at)} | ${esc(notes)} |`);
    }
  } else {
    out.push("(none)");
  }

  const qs = questionsForUser(state);
  out.push("", "## Open questions", "");
  out.push(...(qs.length ? qs.map((q) => `- ${q.text}`) : ["(none)"]));

  const tasks = [...state.tasks.values()].filter((t) => t.lifecycle !== "archived" && t.status !== "dropped");
  out.push("", "## Tasks", "");
  if (tasks.length) {
    out.push("| Task | Status | Verification |", "|---|---|---|");
    for (const t of tasks) {
      const ev = esc(verificationLine(t));
      const review = t.status === "needs_review" ? ` (${t.needsReview.map((d) => d.key).join(", ")} changed)` : waitingNote(t);
      out.push(`| ${esc(t.title)} | ${t.status}${t.lifecycle === "suspended" ? " (suspended)" : ""}${review} | ${ev} |`);
    }
  } else {
    out.push("(none)");
  }

  // deleted slots and versions from before a delete are left out, since the AI reads this file too
  const history = [...state.slots.values()].filter((s) => !s.deleted && (s.versions.length - s.liveFrom > 1 || s.current?.retired || !s.current));
  if (history.length) {
    out.push("", "## Change history", "");
    for (const s of history) {
      out.push(`- ${s.key}: ` + s.versions.slice(s.liveFrom).map((v) => `v${v.n} "${esc(v.value)}"${v.retired ? " (retired)" : ""}${v.status === "rejected" ? " (rejected)" : ""}`).join(" → "));
    }
  }
  return out.join("\n") + "\n";
}

// ---------- End-of-turn report ----------

export interface ReportItem {
  no: number;
  kind: "question" | "decision";
  qid?: string;
  key?: SlotKey;
  n?: number;
  options?: { id: string; label: string }[];
  text: string;
}

export interface Report {
  session: string;
  at: string;
  items: ReportItem[];
  text: string;
  signature: string;
}

function sessionCompletions(events: AnyEvent[], session: string): string[] {
  const done = new Map<string, string>();
  for (const ev of events) {
    const sid = ev.actor.kind === "human" ? ev.actor.via : ev.actor.session;
    if (sid !== session) continue;
    if (ev.type === "task.verified") {
      const e = ev.data;
      done.set(e.slug, e.kind === "ref" ? " (verified by reference)" : e.kind === "human" ? " (accepted by the user)" : ` (verified on ${e.env})`);
    }
    if (ev.type === "task.status" && ev.data.status === "implemented" && !done.has(ev.data.slug)) done.set(ev.data.slug, " (not verified)");
  }
  return [...done].map(([slug, note]) => `${slug}${note}`);
}

export function buildReport(state: State, events: AnyEvent[], session: string, analysis: Analysis | null, others: string[] = []): Report {
  const items: ReportItem[] = [];
  const confirm = questionsForUser(state);
  for (const q of confirm) {
    items.push({ no: items.length + 1, kind: "question", qid: q.qid, options: q.options, text: q.text });
  }
  const decisions = live(state).filter((s) => {
    const v = s.current!;
    return v.session === session && v.status === "proposed" && ["goal", "approach", "env", "assum"].includes(s.category);
  });
  for (const s of decisions) {
    const v = s.current!;
    items.push({ no: items.length + 1, kind: "decision", key: s.key, n: v.n, text: `${s.key}: ${v.value} (${v.rationale})` });
  }

  const lines: string[] = [];
  const qItems = items.filter((i) => i.kind === "question");
  const dItems = items.filter((i) => i.kind === "decision");
  if (qItems.length) {
    lines.push(`Needs your call (${qItems.length}; related work is paused)`);
    for (const i of qItems.slice(0, MAX_LIST)) {
      const rec = i.options?.find((o) => (o as { recommended?: boolean }).recommended);
      const opts = i.options?.length ? ` (${i.options.map((o) => `${o.id} ${o.label}`).join(" / ")})` : "";
      const reply = i.options?.length ? ` Just reply "${i.no}${rec?.id ?? i.options[0].id}".` : ` Just reply "${i.no} <your answer>".`;
      lines.push(`${i.no}. ${i.text}${opts}${rec ? ` Recommended: ${rec.id}.` : ""}${reply}`);
    }
    if (qItems.length > MAX_LIST) lines.push(`${qItems.length - MAX_LIST} more; see STATUS.md or slotledger web.`);
    lines.push("");
  }
  if (dItems.length) {
    lines.push(`Decisions I made for you (${dItems.length}; you can withdraw any of them)`);
    for (const i of dItems.slice(0, MAX_LIST)) lines.push(`${i.no}. ${i.text}`);
    if (dItems.length > MAX_LIST) lines.push(`${dItems.length - MAX_LIST} more; see STATUS.md or slotledger web.`);
    lines.push(`If you disagree, reply "withdraw ${dItems[0].no}".`, "");
  }

  const notes: string[] = [];
  if (analysis) {
    if (analysis.undeclared.length) notes.push(`Code for ${analysis.undeclared.map((u) => u.topic).join(", ")} changed during this session with no matching decision recorded.`);
    if (analysis.coarse) notes.push(`${analysis.coarse.files} file(s) changed during this session and no decision was recorded.`);
    if (analysis.newDocs.length) notes.push(`New documents this session: ${analysis.newDocs.slice(0, MAX_LIST).join(", ")}${analysis.newDocs.length > MAX_LIST ? ` (${analysis.newDocs.length} in total)` : ""}.`);
    if (analysis.depManifests.length) notes.push(`Dependency manifests changed: ${analysis.depManifests.join(", ")}.`);
    if (notes.length && others.length) {
      notes.push(`Another session (${others.map((s) => s.slice(0, 8)).join(", ")}) was working in this folder at the same time, so some of these changes may be its; the AI wasn't asked about them.`);
    }
  }
  const done = sessionCompletions(events, session);
  if (done.length) lines.push(`${items.length ? "Everything else is done" : "Done"}: ${done.slice(0, MAX_LIST).join(", ")}${done.length > MAX_LIST ? ` (${done.length} in total)` : ""}`);
  lines.push(...notes);

  const signature = JSON.stringify({ i: items.map((i) => i.qid ?? `${i.key}@${i.n}`), notes, done });
  return { session, at: new Date().toISOString(), items, text: lines.join("\n").trim(), signature };
}

/** One-time nudge to the AI at Stop (not shown to the user) */
export interface NudgePart {
  key: string;
  text: string;
}

export function buildNudge(state: State, analysis: Analysis | null, strictness: Strictness = "balanced"): NudgePart[] {
  const parts: NudgePart[] = [];
  if (analysis) {
    for (const u of analysis.undeclared) {
      parts.push({ key: `topic:${u.topic}`, text: `Files in topic ${u.topic} changed (${u.files.slice(0, 3).join(", ")}${u.files.length > 3 ? ", …" : ""}), but no related decision was recorded.` });
    }
    if (analysis.schemaUndeclared.length) {
      parts.push({ key: `schema:${analysis.schemaUndeclared.join(",")}`, text: `Schema/migration/interface files changed (${analysis.schemaUndeclared.slice(0, 3).join(", ")}), but nothing was recorded under approach.` });
    }
    for (const d of analysis.newDocs) {
      parts.push({ key: `doc:${d}`, text: `New document ${d}. If it holds decisions, plans, todos or a handoff, record them with record / task (a handoff goes in task({ slug, handoff })); the document itself can stay.` });
    }
  }
  // a gone premise is one decision about its whole chain, not one review per thing resting on it
  for (const k of removedPremises(state)) parts.push({ key: `gone:${k}`, text: removedPremiseText(state, k) });
  const selfReview = live(state).filter((s) => s.stale.some((d) => !d.gone) && !GUARDED.includes(s.category));
  for (const s of selfReview) {
    parts.push({ key: `stale:${s.key}@${s.current!.n}`, text: `The premise of ${s.key} "${s.current!.value}" changed${staleNote(s).replace(" ⚠ premise changed", "")}. Review it: if it still holds, record the same value (this re-locks its premises without a new version, and clears what waits on it); otherwise change it.` });
  }
  for (const t of state.tasks.values()) {
    if (t.lifecycle !== "live") continue;
    if (t.status === "needs_review" && t.needsReview.some((d) => !d.gone)) {
      parts.push({ key: `task:${t.slug}:${t.needsReview.map((d) => `${d.key}@${d.current}`).join(",")}`, text: reviewHint(t) });
    }
    if (strictness === "strict" && t.status === "implemented") {
      parts.push({ key: `unverified:${t.slug}`, text: `Task ${t.slug} is implemented but not verified. Run verify with a command that proves it works, or say why it can't be verified yet.` });
    }
  }
  return parts;
}

export function formatNudge(parts: NudgePart[]): string {
  return ["slotledger reminder (shown once; handle it, or confirm nothing is needed, then finish):", ...parts.map((p) => `- ${p.text}`), "If it's only an implementation detail, there's nothing to record; just finish."].join("\n");
}
