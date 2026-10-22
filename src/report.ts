import type { Analysis } from "./analyze.js";
import type { QuestionState, SlotState, State, VersionState } from "./fold.js";
import type { AnyEvent, Category, SlotKey } from "./types.js";
import type { Config, Strictness } from "./types.js";
import { CATEGORIES, GUARDED } from "./types.js";
import { settingsBrief } from "./settings.js";
import { duplicatePairs, search } from "./similar.js";

export const STATUS_LABEL: Record<VersionState["status"], string> = {
  decided: "decided",
  proposed: "proposed",
  accepted_by_default: "accepted by default",
  rejected: "rejected",
};

export const CAT_LABEL: Record<Category, string> = {
  product: "Product", arch: "Architecture", platform: "Platform", assum: "Assumption", dep: "Dependency", constraint: "Constraint",
};

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

/** What a human must answer: questions the AI asked, plus stale-premise questions on arch/product; the AI reviews the other categories itself */
export function questionsForUser(state: State): QuestionState[] {
  return openQuestions(state).filter((q) => q.origin === "agent" || (q.premise && GUARDED.includes(state.slots.get(q.premise.slot)!.category)));
}

/** Current state for the AI (injected at SessionStart, and the brief tool) */
export function renderBrief(state: State, config: Config, errors = 0): string {
  const lines: string[] = ["# slotboard project state"];
  if (errors) lines.push(`⚠ slotboard failed to sync ${errors} time(s) (.project/run/errors.log); some records may be missing.`);
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

  const qs = openQuestions(state);
  if (qs.length) {
    lines.push("", "## Open questions");
    for (const q of qs) lines.push(`- (${q.qid}) ${q.text}`);
  }

  const tasks = [...state.tasks.values()].filter((t) => t.status !== "dropped" && t.status !== "verified");
  if (tasks.length) {
    lines.push("", "## Tasks");
    for (const t of tasks) {
      const review = t.needsReview.length ? ` ⚠ based on changed decisions: ${t.needsReview.map((d) => d.key).join(", ")}` : "";
      lines.push(`- ${t.slug} [${t.status}] ${t.title}${review}`);
    }
  }

  lines.push(
    "",
    "Use record when you make or change a decision; task when you start or advance work; verify to run a command before claiming something is done; respond when the user replies to numbers in a report.",
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
  const lines: string[] = [`# slotboard matches for "${query}"`];
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
    "<!-- Generated; do not edit by hand. Source: .project/events.jsonl. Live view: npx slotboard web -->",
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

  const tasks = [...state.tasks.values()].filter((t) => t.status !== "dropped");
  out.push("", "## Tasks", "");
  if (tasks.length) {
    out.push("| Task | Status | Verification |", "|---|---|---|");
    for (const t of tasks) {
      const ev = t.evidence ? `\`${esc(t.evidence.cmd)}\` passed (${esc(t.evidence.env)}, ${date(t.evidence.at)})` : t.lastFailed ? `last verification failed (exit ${t.lastFailed.exit})` : "not verified";
      const review = t.needsReview.length ? " ⚠ needs review" : "";
      out.push(`| ${esc(t.title)} | ${t.status}${review} | ${ev} |`);
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
    const sid = ev.actor.kind === "agent" ? ev.actor.session : ev.actor.kind === "system" ? ev.actor.session : undefined;
    if (sid !== session) continue;
    if (ev.type === "task.verified") done.set(ev.data.slug, ` (verified on ${ev.data.env})`);
    if (ev.type === "task.status" && ev.data.status === "implemented" && !done.has(ev.data.slug)) done.set(ev.data.slug, " (not verified)");
  }
  return [...done].map(([slug, note]) => `${slug}${note}`);
}

export function buildReport(state: State, events: AnyEvent[], session: string, analysis: Analysis | null): Report {
  const items: ReportItem[] = [];
  const confirm = questionsForUser(state);
  for (const q of confirm) {
    items.push({ no: items.length + 1, kind: "question", qid: q.qid, options: q.options, text: q.text });
  }
  const decisions = live(state).filter((s) => {
    const v = s.current!;
    return v.session === session && v.status === "proposed" && ["product", "arch", "platform", "assum"].includes(s.category);
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
    if (qItems.length > MAX_LIST) lines.push(`${qItems.length - MAX_LIST} more; see STATUS.md or slotboard web.`);
    lines.push("");
  }
  if (dItems.length) {
    lines.push(`Decisions I made for you (${dItems.length}; you can withdraw any of them)`);
    for (const i of dItems.slice(0, MAX_LIST)) lines.push(`${i.no}. ${i.text}`);
    if (dItems.length > MAX_LIST) lines.push(`${dItems.length - MAX_LIST} more; see STATUS.md or slotboard web.`);
    lines.push(`If you disagree, reply "withdraw ${dItems[0].no}".`, "");
  }

  const notes: string[] = [];
  if (analysis) {
    if (analysis.undeclared.length) notes.push(`Code for ${analysis.undeclared.map((u) => u.topic).join(", ")} changed during this session with no matching decision recorded.`);
    if (analysis.coarse) notes.push(`${analysis.coarse.files} file(s) changed during this session and no decision was recorded.`);
    if (analysis.newDocs.length) notes.push(`New documents this session: ${analysis.newDocs.slice(0, MAX_LIST).join(", ")}${analysis.newDocs.length > MAX_LIST ? ` (${analysis.newDocs.length} in total)` : ""}.`);
    if (analysis.depManifests.length) notes.push(`Dependency manifests changed: ${analysis.depManifests.join(", ")}.`);
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
      parts.push({ key: `schema:${analysis.schemaUndeclared.join(",")}`, text: `Schema/migration/interface files changed (${analysis.schemaUndeclared.slice(0, 3).join(", ")}), but nothing was recorded under arch.` });
    }
    for (const d of analysis.newDocs) {
      parts.push({ key: `doc:${d}`, text: `New document ${d}. If it holds decisions, plans, or todos, record them with record / task (the document itself can stay).` });
    }
  }
  const selfReview = live(state).filter((s) => s.stale.length && !GUARDED.includes(s.category));
  for (const s of selfReview) {
    parts.push({ key: `stale:${s.key}@${s.current!.n}`, text: `The premise of ${s.key} "${s.current!.value}" changed${staleNote(s).replace(" ⚠ premise changed", "")}. Review it: if it still holds, record the same value (this locks the new dependency versions); otherwise change it.` });
  }
  for (const t of state.tasks.values()) {
    if (t.needsReview.length && t.status !== "dropped" && t.status !== "verified") {
      parts.push({ key: `task:${t.slug}:${t.needsReview.map((d) => `${d.key}@${d.current}`).join(",")}`, text: `Decisions that task ${t.slug} is based on changed (${t.needsReview.map((d) => d.key).join(", ")}). Check it should still be done; if not, mark it dropped with task.` });
    }
    if (strictness === "strict" && t.status === "implemented") {
      parts.push({ key: `unverified:${t.slug}`, text: `Task ${t.slug} is implemented but not verified. Run verify with a command that proves it works, or say why it can't be verified yet.` });
    }
  }
  return parts;
}

export function formatNudge(parts: NudgePart[]): string {
  return ["slotboard reminder (shown once; handle it, or confirm nothing is needed, then finish):", ...parts.map((p) => `- ${p.text}`), "If it's only an implementation detail, there's nothing to record; just finish."].join("\n");
}
