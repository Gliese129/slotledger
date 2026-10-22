import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Board, FixableError } from "./board.js";
import { EXPORT_FORMATS } from "./export.js";
import { currentSession } from "./session.js";
import { Store, resolveRoot, ulid } from "./store.js";
import { CATEGORIES, SETTABLE_STATUSES } from "./types.js";

const VERSION = "0.0.1";

export function createServer(root = resolveRoot()): McpServer {
  const store = new Store(root);
  const board = new Board(store);
  const connectionId = "conn-" + ulid().toLowerCase();
  const server = new McpServer({ name: "slotboard", version: VERSION });
  // Tool descriptions are read once at startup; brief carries the live settings
  const language = store.readConfig().language;
  const writeIn = language ? ` Write value and rationale in ${language}.` : "";

  const run = (where: string, fn: (session: string) => string, meta?: Record<string, unknown>) => {
    try {
      const s = currentSession(store, connectionId, meta);
      const client = server.server.getClientVersion();
      board.ensureSession(s.id, { name: client?.name ?? "unknown", version: client?.version ?? "" });
      return { content: [{ type: "text" as const, text: fn(s.id) }] };
    } catch (err) {
      if (err instanceof FixableError) return { content: [{ type: "text" as const, text: err.message }], isError: true };
      // Fail open: log the error and let the AI keep working
      store.logError(where, err);
      return { content: [{ type: "text" as const, text: `slotboard hit an internal error and didn't record this (logged to .project/run/errors.log). Carry on working as usual.` }], isError: true };
    }
  };

  server.registerTool("record", {
    description:
      "Call when you make or change a decision: a goal (what is wanted, what counts as success), an approach (how it's done: design, method, experiment plan), the environment it's bound to, an assumption, a dependency (library, dataset, model, source), a constraint. " +
      "Calling again with the same key creates a new version, so reuse existing keys (find them with brief({ query })). A new key that looks like an existing one is held back once with the similar keys listed. " +
      "Skip execution details. Decisions the user stated themselves need userQuote." + writeIn,
    inputSchema: {
      key: z.string().describe(`<category>/<dashed-name>; categories: ${CATEGORIES.join(" | ")}. E.g. approach/sync-backend, goal/success-metric, env/target-os, assum/user-os. Old prefixes product/, arch/, platform/ still work`),
      value: z.string().describe("The decision, in one sentence"),
      rationale: z.string().describe("Why. Used to question the user when a premise changes, so state the basis clearly"),
      depends: z.array(z.string()).optional().describe("Slots this decision rests on (list of keys); their current versions get locked"),
      topics: z.array(z.string()).optional().describe("Topic ids, see .project/config.json"),
      scope: z.array(z.string()).optional().describe("Required for constraint: the paths or area it covers"),
      retired: z.boolean().optional().describe("true retires this slot"),
      userQuote: z.string().optional().describe("The user's exact words. Only with this does it count as the user's decision"),
      new: z.boolean().optional().describe("true after the similar-key check, when this really is a separate decision"),
      replaces: z.array(z.string()).optional().describe("Keys this decision merges in: they are retired, and decisions depending on them are re-pointed to this key"),
    },
  }, (args, extra) => run("record", (s) => board.record(s, args), extra._meta));

  server.registerTool("task", {
    description:
      "Call when you start, advance, or drop a piece of work. Refer to it by slug. Each task has one status: todo, in_progress, implemented, needs_review, verified, dropped. " +
      "Only verify can set verified. slotboard sets needs_review when decisions in basedOn change; resolve it by re-verifying, by passing basedOn again with a note saying why it still holds, or by dropping it.",
    inputSchema: {
      slug: z.string().describe("Lowercase with dashes, e.g. migrate-platform-to-macos"),
      title: z.string().optional().describe("Required when creating"),
      status: z.enum(SETTABLE_STATUSES).optional(),
      basedOn: z.array(z.string()).optional().describe("Decisions this work is based on (list of keys), locked to their current versions; if they change, the task becomes needs_review. On an existing task, passing it again (with note) re-locks it: use this to confirm the task still holds after review"),
      rootCause: z.string().optional().describe("Root cause, when fixing a bug"),
      note: z.string().optional(),
    },
  }, (args, extra) => run("task", (s) => board.task(s, args), extra._meta));

  server.registerTool("verify", {
    description:
      "Call before claiming work is done, with exactly one kind of evidence. " +
      "run: pass cmd and slotboard runs it (exit 0 passes); prefer this whenever a command can check the work. " +
      "ref: when the evidence was produced elsewhere (a report, a receipt, an experiment log, a job in another system), pass refs, summary and passed; local files get hashed so the evidence names the exact version. " +
      "human: when a person checked it themselves, pass userQuote (their exact words), scope and passed. " +
      "Only a pass marks the task verified; on failure the status stays. The source is shown with the result, so a ref or human pass never reads as a run slotboard did.",
    inputSchema: {
      slug: z.string(),
      cmd: z.string().optional().describe("run: a command that proves it works, e.g. npm test -- sync"),
      timeoutSec: z.number().int().positive().max(3600).optional().describe("run only"),
      refs: z.array(z.string()).optional().describe("ref: project paths, URLs, or IDs in other systems, e.g. reports/eval.md, slurm job 1234"),
      summary: z.string().optional().describe("ref: what the evidence shows"),
      metrics: z.record(z.string(), z.union([z.string(), z.number()])).optional().describe("ref: key numbers, e.g. { accuracy: 0.93 }"),
      userQuote: z.string().optional().describe("human: the person's exact words"),
      scope: z.string().optional().describe("human: what the acceptance covers, e.g. iPhone 15 on iOS 18"),
      passed: z.boolean().optional().describe("ref and human: whether it passed"),
    },
  }, (args, extra) => run("verify", (s) => board.verify(s, args), extra._meta));

  server.registerTool("ask", {
    description: "Call when a question needs the user's call and the user isn't around; it appears in the end-of-turn report. If the user is around, ask them directly instead.",
    inputSchema: {
      about: z.array(z.string()).min(1).describe("Keys of the related slots"),
      text: z.string(),
      options: z.array(z.object({ id: z.string(), label: z.string(), recommended: z.boolean().optional() })).optional(),
    },
  }, (args, extra) => run("ask", (s) => board.ask(s, args.about, args.text, args.options), extra._meta));

  server.registerTool("respond", {
    description: "Call when the user replies to the end-of-turn report (e.g. \"1A\", \"withdraw 2\") or answers an open question, to record their answer.",
    inputSchema: {
      item: z.number().int().positive().optional().describe("The number in the report"),
      question: z.string().optional().describe("Question ID (in parentheses in brief), when there is no number"),
      choice: z.string().optional().describe("Option, e.g. A"),
      text: z.string().optional().describe("Free-form answer; when withdrawing, the replacement value"),
      withdraw: z.boolean().optional().describe("Withdraw a decision made on the user's behalf"),
      userQuote: z.string().describe("The user's exact words"),
    },
  }, (args, extra) => run("respond", (s) => board.respond(s, args), extra._meta));

  server.registerTool("brief", {
    description: "Show live decisions, stale-premise flags, open questions, and tasks. Call before starting work or when unsure of the current state. With query, search decisions (including retired ones) and tasks, e.g. before adding a new key.",
    inputSchema: {
      query: z.string().optional().describe("Words to search slot keys, values, rationales and tasks for"),
      prompt: z.string().optional().describe("The user's reply, e.g. 1A or withdraw 2, to resolve report numbers when prompt hooks are unavailable"),
    },
    annotations: { readOnlyHint: true },
  }, (args, extra) => run("brief", (s) => [board.brief(args.query), args.prompt ? board.replyContext(s, args.prompt) : null].filter(Boolean).join("\n\n"), extra._meta));

  server.registerTool("checkpoint", {
    description: "Before finishing a turn without lifecycle hooks, check git changes and build the slotboard report. Address any nudge, then call again with continued: true and show the returned report to the user verbatim.",
    inputSchema: {
      continued: z.boolean().optional().describe("true after addressing a previous checkpoint nudge"),
    },
  }, (args, extra) => run("checkpoint", (s) => {
    const result = board.stop(s, !!args.continued);
    return result.block ?? result.message ?? "No new findings.";
  }, extra._meta));

  server.registerTool("export", {
    description:
      "Export decisions, questions waiting on the team, and tasks for a shared team doc (Notion or similar). " +
      "Write the output to the doc as is: replace the whole page, or each entry under its heading (slot key, question ID, task slug); don't summarize or reword it. " +
      "When you read a shared doc and find a teammate's edit or comment, record it here before acting on it: record with userQuote for a decision someone stated, respond with the question ID for an answer, ask when it needs the user.",
    inputSchema: {
      format: z.enum(EXPORT_FORMATS).optional().describe("markdown (default) for doc pages; json for databases, one row per entry"),
    },
    annotations: { readOnlyHint: true },
  }, (args, extra) => run("export", () => board.export(args.format), extra._meta));

  return server;
}

export async function startServer(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
