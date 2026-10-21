import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Board, FixableError } from "./board.js";
import { currentSession } from "./session.js";
import { Store, resolveRoot, ulid } from "./store.js";
import { CATEGORIES } from "./types.js";

const VERSION = "0.0.1";

export function createServer(root = resolveRoot()): McpServer {
  const store = new Store(root);
  const board = new Board(store);
  const connectionId = "conn-" + ulid().toLowerCase();
  const server = new McpServer({ name: "slotboard", version: VERSION });

  const run = (where: string, fn: (session: string) => string) => {
    try {
      const s = currentSession(store, connectionId);
      const client = server.server.getClientVersion();
      board.ensureSession(s.id, { name: client?.name ?? "unknown", version: client?.version ?? "" });
      return { content: [{ type: "text" as const, text: fn(s.id) }] };
    } catch (err) {
      if (err instanceof FixableError) return { content: [{ type: "text" as const, text: err.message }], isError: true };
      // 工具故障时放行：记下错误，让 AI 照常工作
      store.logError(where, err);
      return { content: [{ type: "text" as const, text: `slotboard 内部出错，这次没有记上（已记入 .project/run/errors.log）。照常继续工作即可。` }], isError: true };
    }
  };

  server.registerTool("record", {
    description:
      "做出或改变一个决定时调用：产品行为、架构方案、目标平台、前提假设、新依赖、约束。" +
      "同一个 key 再次调用就是升版本。实现细节不用记。用户亲口说的决定要带 userQuote。",
    inputSchema: {
      key: z.string().describe(`<分类>/<短横线名>，分类：${CATEGORIES.join(" | ")}。例：arch/sync-backend、assum/user-os`),
      value: z.string().describe("决定的内容，一句话"),
      rationale: z.string().describe("为什么这么定。前提变化时会用它向用户提问，写清依据"),
      depends: z.array(z.string()).optional().describe("这个决定以哪些槽位为前提（key 列表），会锁定它们当前的版本"),
      topics: z.array(z.string()).optional().describe("所属主题 id，见 .project/config.json"),
      scope: z.array(z.string()).optional().describe("constraint 必填：受约束的路径或范围"),
      retired: z.boolean().optional().describe("true 表示作废这个槽位"),
      userQuote: z.string().optional().describe("用户原话。有它才算用户的决定"),
    },
  }, (args) => run("record", (s) => board.record(s, args)));

  server.registerTool("task", {
    description: "开始一项工作、推进或放弃时调用。用 slug 引用。verified 只能由 verify 产生。",
    inputSchema: {
      slug: z.string().describe("小写短横线，例 migrate-platform-to-macos"),
      title: z.string().optional().describe("新建时必填"),
      status: z.enum(["todo", "in_progress", "implemented", "dropped"]).optional(),
      basedOn: z.array(z.string()).optional().describe("这项工作基于哪些决定（key 列表）；决定变了任务会被标为需复查"),
      rootCause: z.string().optional().describe("修 bug 时写根因"),
      note: z.string().optional(),
    },
  }, (args) => run("task", (s) => board.task(s, args)));

  server.registerTool("verify", {
    description: "声称某项工作完成之前调用：由 slotboard 执行命令并留存证据。通过才会标为 verified，失败时状态不变。",
    inputSchema: {
      slug: z.string(),
      cmd: z.string().describe("能证明它工作的命令，例 npm test -- sync"),
      timeoutSec: z.number().int().positive().max(3600).optional(),
    },
  }, (args) => run("verify", (s) => board.verify(s, args.slug, args.cmd, args.timeoutSec)));

  server.registerTool("ask", {
    description: "有需要用户拍板的问题、而用户不在场时调用；问题会出现在结尾汇报里。用户在场时优先直接问。",
    inputSchema: {
      about: z.array(z.string()).min(1).describe("相关槽位 key"),
      text: z.string(),
      options: z.array(z.object({ id: z.string(), label: z.string(), recommended: z.boolean().optional() })).optional(),
    },
  }, (args) => run("ask", (s) => board.ask(s, args.about, args.text, args.options)));

  server.registerTool("respond", {
    description: "用户回复结尾汇报（如\"1A\"、\"撤回 2\"）或回答了待回答问题时调用，把用户的答复记下。",
    inputSchema: {
      item: z.number().int().positive().optional().describe("汇报里的编号"),
      question: z.string().optional().describe("问题 ID（brief 里括号中的），没有编号时用"),
      choice: z.string().optional().describe("选项，如 A"),
      text: z.string().optional().describe("自由回答；撤回时可作为替代值"),
      withdraw: z.boolean().optional().describe("撤回替用户做的决定"),
      userQuote: z.string().describe("用户原话"),
    },
  }, (args) => run("respond", (s) => board.respond(s, args)));

  server.registerTool("brief", {
    description: "查看当前生效的决定、前提已变的标记、待回答问题和任务。开工前或不确定现状时调用。",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, () => run("brief", () => board.brief()));

  return server;
}

export async function startServer(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
