import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { HUB_URL } from "./paths.ts";
import { ensureDaemon, postJson } from "./client.ts";
import { LEAD_ACTIONS } from "./lead.ts";

/** stdio MCP server started by Claude Code / Codex; forwards every tool call to the hub. */
export async function runMcp() {
  const cwd = process.cwd();
  let myName: string | null = null;
  let myTeam: string | null = null;
  let leadId: string | null = null;
  const server = new McpServer({ name: "gang", version: "0.1.0" }, {
    instructions: "gang: team hub for coordinating with other coding agents on this repo. Only use it after the user " +
      "has asked you to join a gang team (they give you a name and role). [gang] notices come from this hub.",
  });

  const runtime = () => {
    const n = server.server.getClientVersion()?.name ?? "";
    return /claude/i.test(n) ? "claude" : /codex/i.test(n) ? "codex" : n || "unknown";
  };

  async function call(tool: string, args: Record<string, unknown>, extra: any) {
    const meta = extra?._meta ?? {};
    const sid = meta["x-codex-turn-metadata"]?.session_id ?? null;
    await ensureDaemon();
    const r = await postJson(`${HUB_URL}/rpc`, {
      tool, args, ctx: { runtime: runtime(), cwd, session_id: sid, name: sid ? null : myName, team: sid ? null : myTeam, lead_id: leadId },
    });
    if (!r.ok) return { isError: true, content: [{ type: "text" as const, text: `gang: ${r.error}` }] };
    if (tool === "register") { myName = String(args.name); myTeam = r.result.team_id; }
    if (tool === "lead" && args.action === "register") leadId = r.result.lead_id;
    const text = typeof r.result === "string" ? r.result : JSON.stringify(r.result, null, 2);
    return { content: [{ type: "text" as const, text }] };
  }

  const tool = (name: string, description: string, shape: z.ZodRawShape) =>
    server.registerTool(name, { description, inputSchema: shape }, (args: any, extra: any) => call(name, args, extra));

  tool("register", "Join a gang team under a name and role (the user tells you which). Call once per session before other gang tools. Returns a briefing: teammates, decisions in effect, your tasks, file claims.",
    { team: z.string().optional().describe("team name the user gave you; omit to use the team covering this folder"),
      name: z.string().describe("your agent name, e.g. planner-1"), role: z.string().describe("e.g. planner, implementer, reviewer, researcher") });
  tool("team", "List teammates with their status (working / on_call / asleep / waiting_permission), focus, and unread counts, plus running jobs.", {});
  tool("inspect", "Look at a teammate's recent work: digest (last request, last reply, files touched, recent actions, findings, jobs) or a timeline of events from their transcript.",
    { agent: z.string(), view: z.enum(["digest", "timeline"]).optional(), limit: z.number().int().optional() });
  tool("send", "Send a message to a teammate (or '*' for everyone, or 'human' for the user). Does not wake them; they see a notice at their next tool call.",
    { to: z.string(), body: z.string(), kind: z.enum(["msg", "question", "answer", "handoff", "decision"]).optional(),
      reply_to: z.number().int().optional().describe("message id you are replying to") });
  tool("inbox", "Read (and mark read) your unread team messages.", {});
  tool("wake", "Wake a teammate who has to act soon. The reason is delivered to their inbox as a message, so put your full question/request in it (no separate `send` needed). Rate-limited and shown to the user — use sparingly.",
    { to: z.string(), reason: z.string() });
  tool("post_status", "Set your one-line status/focus shown to teammates and the user's dashboard.", { text: z.string() });
  tool("post_finding", "Broadcast a discovery or result teammates should know about.", { text: z.string() });
  tool("job_start", "Start a long-running shell command (experiment, training, benchmark) detached from your turn. You will be messaged and woken when it finishes or fails, so do not poll the log in a loop: continue other work or end your turn.",
    { cmd: z.string(), name: z.string().optional(), cwd: z.string().optional(),
      notify: z.enum(["wake", "message", "none"]).optional().describe("default: wake") });
  tool("jobs", "List this project's jobs, or show one job's status and log tail.", { id: z.number().int().optional() });
  tool("job_logs", "Tail a job's log.", { id: z.number().int(), lines: z.number().int().optional() });
  tool("job_kill", "Stop a running job.", { id: z.number().int() });

  tool("task_add", "Create a team task. Assign an owner to hand it off (they get a message); use depends_on for ordering.",
    { title: z.string(), body: z.string().optional(), owner: z.string().optional(), depends_on: z.array(z.number().int()).optional() });
  tool("tasks", "List team tasks (default: open ones). Blocked tasks show which tasks they wait on.",
    { filter: z.enum(["open", "mine", "all"]).optional() });
  tool("task_update", "Update a task: claim it, change status (open/in_progress/review/done/cancelled), reassign, or add a note. Finishing a task notifies its creator and owners of tasks it unblocks.",
    { id: z.number().int(), claim: z.boolean().optional(), status: z.enum(["open", "in_progress", "review", "done", "cancelled"]).optional(),
      owner: z.string().optional(), note: z.string().optional() });
  tool("decide", "Record a team-wide decision (conventions, chosen approach, experiment settings). Everyone is notified and it's shown to every agent at session start. Use supersedes to replace an older decision.",
    { title: z.string(), body: z.string().optional(), supersedes: z.number().int().optional() });
  tool("decisions", "List the team's decisions in effect (all=true includes superseded/retracted).", { all: z.boolean().optional() });
  tool("claim", "Claim files/dirs/globs before editing so teammates' edits to them are blocked until you release (default 120 min). Returns conflicts if a teammate holds them.",
    { paths: z.array(z.string()).describe("paths relative to your cwd, dirs, or globs like src/eval/**"), note: z.string().optional(),
      minutes: z.number().int().optional(), exclusive: z.boolean().optional() });
  tool("release", "Release your file claims (all of them if paths is omitted).", { paths: z.array(z.string()).optional() });
  tool("claims", "List active file claims in the team.", {});

  tool("lead", "ONLY for the user's own lead agent (their assistant above all gang teams), and only if the user asked you to be it. " +
    "Briefings on all agents and acting as the user. Start with action \"register\", then \"help\" for the full action list.",
    { action: z.enum(LEAD_ACTIONS as unknown as [string, ...string[]]), team: z.string().optional(), agent: z.string().optional(),
      to: z.string().optional(), body: z.string().optional(), reason: z.string().optional(), id: z.number().int().optional(),
      ids: z.array(z.number().int()).optional(), name: z.string().optional(), role: z.string().optional(), title: z.string().optional(),
      status: z.string().optional(), owner: z.string().optional(), note: z.string().optional(), kind: z.string().optional(),
      view: z.string().optional(), limit: z.number().int().optional(), before_id: z.number().int().optional(),
      depends_on: z.array(z.number().int()).optional(), supersedes: z.number().int().optional(), reply_to: z.number().int().optional(),
      cmd: z.string().optional(), cwd: z.string().optional(), folders: z.array(z.string()).optional(), lines: z.number().int().optional(),
      wake: z.boolean().optional(), on: z.boolean().optional(), peek: z.boolean().optional(), all: z.boolean().optional(),
      existing: z.boolean().optional(), filter: z.string().optional(), settings: z.record(z.string(), z.any()).optional() });

  await server.connect(new StdioServerTransport());
}
