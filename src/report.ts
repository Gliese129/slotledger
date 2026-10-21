import type { Analysis } from "./analyze.js";
import type { QuestionState, SlotState, State, VersionState } from "./fold.js";
import type { AnyEvent, Category, SlotKey } from "./types.js";
import { CATEGORIES, GUARDED } from "./types.js";

const STATUS_LABEL: Record<VersionState["status"], string> = {
  decided: "已确认",
  proposed: "提议中",
  accepted_by_default: "默认接受",
  rejected: "已否决",
};

const CAT_LABEL: Record<Category, string> = {
  product: "产品", arch: "架构", platform: "平台", assum: "假设", dep: "依赖", constraint: "约束",
};

const MAX_LIST = 3;

function live(state: State): SlotState[] {
  const order = (s: SlotState) => CATEGORIES.indexOf(s.category);
  return [...state.slots.values()].filter((s) => s.current && !s.current.retired).sort((a, b) => order(a) - order(b) || a.key.localeCompare(b.key));
}

function staleNote(s: SlotState): string {
  return s.stale.length ? ` ⚠ 前提已变：${s.stale.map((d) => `${d.key} v${d.locked}→v${d.current}`).join("、")}` : "";
}

export function openQuestions(state: State): QuestionState[] {
  return [...state.questions.values()].filter((q) => q.status === "open");
}

/** 需要人回答的：AI 提的问题，以及 arch/product 的过期前提问题；其他类由 AI 自查 */
export function questionsForUser(state: State): QuestionState[] {
  return openQuestions(state).filter((q) => q.origin === "agent" || (q.premise && GUARDED.includes(state.slots.get(q.premise.slot)!.category)));
}

/** 给 AI 看的当前状态（SessionStart 注入、brief 工具） */
export function renderBrief(state: State, errors = 0): string {
  const lines: string[] = ["# slotboard 项目状态"];
  if (errors) lines.push(`⚠ slotboard 有 ${errors} 次未同步（.project/run/errors.log），相关记录可能缺失。`);

  const slots = live(state);
  if (slots.length) {
    lines.push("", "## 生效决定");
    for (const s of slots) {
      const v = s.current!;
      const deps = v.depends.length ? ` · 依赖 ${v.depends.map((d) => `${d.key}@${d.n}`).join(", ")}` : "";
      const scope = v.scope?.length ? ` · 范围 ${v.scope.join(", ")}` : "";
      lines.push(`- ${s.key} v${v.n}「${v.value}」${STATUS_LABEL[v.status]}${deps}${scope}${staleNote(s)}`);
    }
  } else {
    lines.push("", "还没有记录任何决定。");
  }

  const qs = openQuestions(state);
  if (qs.length) {
    lines.push("", "## 待回答问题");
    for (const q of qs) lines.push(`- (${q.qid}) ${q.text}`);
  }

  const tasks = [...state.tasks.values()].filter((t) => t.status !== "dropped" && t.status !== "verified");
  if (tasks.length) {
    lines.push("", "## 任务");
    for (const t of tasks) {
      const review = t.needsReview.length ? ` ⚠ 基于的决定已变：${t.needsReview.map((d) => d.key).join("、")}` : "";
      lines.push(`- ${t.slug} [${t.status}] ${t.title}${review}`);
    }
  }

  lines.push(
    "",
    "做出或改变决定时用 record；开始/推进工作用 task；声称完成前用 verify 跑命令；用户回复汇报里的编号时用 respond。",
    "计划、待办、决定记在这里，不要另写 PLAN/TODO/handoff 文档。",
  );
  return lines.join("\n");
}

/** 只读快照 STATUS.md，给人看 */
export function renderStatusMd(state: State): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const date = (s: string) => s.slice(0, 16).replace("T", " ");
  const out: string[] = [
    "<!-- 自动生成，请勿手改。来源：.project/events.jsonl -->",
    "# 项目状态",
    "",
  ];

  const slots = live(state);
  out.push("## 生效决定", "");
  if (slots.length) {
    out.push("| 分类 | 槽位 | 当前值 | 状态 | 来源 | 更新时间 | 备注 |", "|---|---|---|---|---|---|---|");
    for (const s of slots) {
      const v = s.current!;
      const notes = [
        s.stale.length ? `⚠ 前提已变（${s.stale.map((d) => d.key).join("、")}）` : "",
        v.scope?.length ? `范围：${v.scope.join(", ")}` : "",
      ].filter(Boolean).join("；");
      out.push(`| ${CAT_LABEL[s.category]} | ${s.key} | ${esc(v.value)} | ${STATUS_LABEL[v.status]} | ${v.source === "user" ? "用户" : "AI"} | ${date(v.at)} | ${esc(notes)} |`);
    }
  } else {
    out.push("（暂无）");
  }

  const qs = questionsForUser(state);
  out.push("", "## 待回答问题", "");
  out.push(...(qs.length ? qs.map((q) => `- ${q.text}`) : ["（暂无）"]));

  const tasks = [...state.tasks.values()].filter((t) => t.status !== "dropped");
  out.push("", "## 任务", "");
  if (tasks.length) {
    out.push("| 任务 | 状态 | 验证 |", "|---|---|---|");
    for (const t of tasks) {
      const ev = t.evidence ? `\`${esc(t.evidence.cmd)}\` 通过（${esc(t.evidence.env)}，${date(t.evidence.at)}）` : t.lastFailed ? `最近一次验证失败（exit ${t.lastFailed.exit}）` : "未验证";
      const review = t.needsReview.length ? " ⚠ 需复查" : "";
      out.push(`| ${esc(t.title)} | ${t.status}${review} | ${ev} |`);
    }
  } else {
    out.push("（暂无）");
  }

  const history = [...state.slots.values()].filter((s) => s.versions.length > 1 || s.current?.retired || !s.current);
  if (history.length) {
    out.push("", "## 变更历史", "");
    for (const s of history) {
      out.push(`- ${s.key}：` + s.versions.map((v) => `v${v.n}「${esc(v.value)}」${v.retired ? "（作废）" : ""}${v.status === "rejected" ? "（否决）" : ""}`).join(" → "));
    }
  }
  return out.join("\n") + "\n";
}

// ---------- 结尾汇报 ----------

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
    if (ev.type === "task.verified") done.set(ev.data.slug, `（已验证：${ev.data.env}）`);
    if (ev.type === "task.status" && ev.data.status === "implemented" && !done.has(ev.data.slug)) done.set(ev.data.slug, "（未验证）");
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
    items.push({ no: items.length + 1, kind: "decision", key: s.key, n: v.n, text: `${s.key}：${v.value}（${v.rationale}）` });
  }

  const lines: string[] = [];
  const qItems = items.filter((i) => i.kind === "question");
  const dItems = items.filter((i) => i.kind === "decision");
  if (qItems.length) {
    lines.push(`需要你确认（${qItems.length} 项，相关部分已暂停）`);
    for (const i of qItems.slice(0, MAX_LIST)) {
      const rec = i.options?.find((o) => (o as { recommended?: boolean }).recommended);
      const opts = i.options?.length ? `（${i.options.map((o) => `${o.id} ${o.label}`).join(" / ")}）` : "";
      const reply = i.options?.length ? `直接回复"${i.no}${rec?.id ?? i.options[0].id}"即可。` : `直接回复"${i.no} <你的答复>"即可。`;
      lines.push(`${i.no}. ${i.text}${opts}${rec ? `推荐 ${rec.id}。` : ""}${reply}`);
    }
    if (qItems.length > MAX_LIST) lines.push(`另有 ${qItems.length - MAX_LIST} 项，见 STATUS.md。`);
    lines.push("");
  }
  if (dItems.length) {
    lines.push(`我先替你做了决定（${dItems.length} 项，可随时撤回）`);
    for (const i of dItems.slice(0, MAX_LIST)) lines.push(`${i.no}. ${i.text}`);
    if (dItems.length > MAX_LIST) lines.push(`另有 ${dItems.length - MAX_LIST} 项，见 STATUS.md。`);
    lines.push(`不同意回复"撤回 ${dItems[0].no}"即可。`, "");
  }

  const notes: string[] = [];
  if (analysis) {
    if (analysis.undeclared.length) notes.push(`本次期间改动了 ${analysis.undeclared.map((u) => u.topic).join("、")} 相关代码，没有对应的决定记录。`);
    if (analysis.coarse) notes.push(`本次期间改动了 ${analysis.coarse.files} 个文件，没有记录任何决定。`);
    if (analysis.newDocs.length) notes.push(`本次新增了文档：${analysis.newDocs.slice(0, MAX_LIST).join("、")}${analysis.newDocs.length > MAX_LIST ? ` 等 ${analysis.newDocs.length} 份` : ""}。`);
    if (analysis.depManifests.length) notes.push(`依赖清单有改动：${analysis.depManifests.join("、")}。`);
  }
  const done = sessionCompletions(events, session);
  if (done.length) lines.push(`${items.length ? "其他部分已经完成" : "已完成"}：${done.slice(0, MAX_LIST).join("、")}${done.length > MAX_LIST ? ` 等 ${done.length} 项` : ""}`);
  lines.push(...notes);

  const signature = JSON.stringify({ i: items.map((i) => i.qid ?? `${i.key}@${i.n}`), notes, done });
  return { session, at: new Date().toISOString(), items, text: lines.join("\n").trim(), signature };
}

/** Stop 时给 AI 的一次性提醒（不给用户看） */
export interface NudgePart {
  key: string;
  text: string;
}

export function buildNudge(state: State, analysis: Analysis | null): NudgePart[] {
  const parts: NudgePart[] = [];
  if (analysis) {
    for (const u of analysis.undeclared) {
      parts.push({ key: `topic:${u.topic}`, text: `改动了主题 ${u.topic} 的文件（${u.files.slice(0, 3).join(", ")}${u.files.length > 3 ? " 等" : ""}），但没有记录相关决定。` });
    }
    if (analysis.schemaUndeclared.length) {
      parts.push({ key: `schema:${analysis.schemaUndeclared.join(",")}`, text: `改动了 schema/迁移/接口文件（${analysis.schemaUndeclared.slice(0, 3).join(", ")}），但没有 arch 类记录。` });
    }
    for (const d of analysis.newDocs) {
      parts.push({ key: `doc:${d}`, text: `新增了文档 ${d}。如果里面有决定、计划或待办，请用 record / task 记下（文档本身可以保留）。` });
    }
  }
  const selfReview = live(state).filter((s) => s.stale.length && !GUARDED.includes(s.category));
  for (const s of selfReview) {
    parts.push({ key: `stale:${s.key}@${s.current!.n}`, text: `${s.key}「${s.current!.value}」的前提变了${staleNote(s).replace(" ⚠ 前提已变", "")}，请复查：仍成立就用 record 写同样的值（会锁定新的依赖版本），不成立就改。` });
  }
  for (const t of state.tasks.values()) {
    if (t.needsReview.length && t.status !== "dropped" && t.status !== "verified") {
      parts.push({ key: `task:${t.slug}:${t.needsReview.map((d) => `${d.key}@${d.current}`).join(",")}`, text: `任务 ${t.slug} 基于的决定变了（${t.needsReview.map((d) => d.key).join("、")}），请确认它是否还该做，不该做就 task 标为 dropped。` });
    }
  }
  return parts;
}

export function formatNudge(parts: NudgePart[]): string {
  return ["slotboard 提醒（只出现一次，处理完或确认无需处理即可结束）：", ...parts.map((p) => `- ${p.text}`), "只是实现细节的话不用记录，直接结束。"].join("\n");
}
