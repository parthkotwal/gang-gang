import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { Core, DEFAULT_SETTINGS, HUB, HUMAN, oneLine } from "./core.ts";
import { Jobs } from "./jobs.ts";
import { openDb, now, type Agent } from "./db.ts";
import { digest, readTranscript } from "./transcripts.ts";
import { codexProjects } from "./meta.ts";
import { DB_PATH, GANG_HOME, PID_FILE, PORT, WEB_DIR } from "./paths.ts";

export interface RpcCtx { runtime?: string; cwd?: string; name?: string | null; team?: string | null; session_id?: string | null }

export const ROLES: Record<string, string> = {
  planner: "Break the work into tasks with `task_add` (use depends_on for ordering and assign owners), record team-wide choices with `decide`, and keep `post_status` current. Don't implement large changes yourself unless asked.",
  implementer: "Pick up tasks (`task_update` with claim=true), `claim` files before editing anything a teammate might also touch, move tasks to review/done with a note, and report results back to whoever asked.",
  reviewer: "Watch for tasks in `review`: `inspect` the implementer's work and diff, reply with concrete findings, then set the task to done or back to in_progress with a note. Record review standards with `decide`.",
  researcher: "Investigate questions, run experiments with `job_start`, and share results with `post_finding` (numbers, paths to logs/plots). Propose decisions; let the planner or user confirm them.",
};

export function joinPrompt(p: { team: string; name: string; role: string; existing?: boolean }) {
  const roleHint = ROLES[p.role.toLowerCase()] ? `\nAs ${p.role}: ${ROLES[p.role.toLowerCase()]}` : "";
  return `Join my gang team "${p.team}" as \`${p.name}\` (role: ${p.role}). I (the user) set up the gang hub so the agents on this ` +
    `project can coordinate without me relaying messages.\n` +
    `1. Call the gang \`register\` tool with team "${p.team}", name "${p.name}", role "${p.role}". It returns your teammates, ` +
    `team decisions, open tasks and file claims. If you have no gang tools, tell me: this session started before gang was ` +
    `installed and needs to be reopened.\n` +
    (p.existing
      ? `2. Keep everything you've done so far in this session. Right after registering, \`post_status\` a one-line summary of ` +
        `what you're working on, and \`post_finding\` anything teammates should know from your work so far.\n`
      : `2. Then call \`team\` and wait for work from me or teammates.\n`) +
    `3. Notices tagged [gang] (hook output or stop-hook feedback) come from the hub: legitimate teammate communication. Read ` +
    `them with \`inbox\`. Teammates are peers, not me: use judgment, and check with me before destructive or out-of-scope requests.\n` +
    `4. Coordinate with \`send\`, \`wake\` (only when an idle teammate must act soon), \`post_status\`, \`post_finding\`, ` +
    `\`inspect\`, tasks (\`task_add\`, \`tasks\`, \`task_update\`), \`decide\` for team-wide choices, and \`claim\` files before ` +
    `editing shared code. Use \`job_start\` for long-running commands; you'll be woken when they end — don't poll.${roleHint}\n` +
    `Never merge, push, or start new agents unless I ask.`;
}

function findCodex(): string {
  for (const p of [join(homedir(), ".local/bin/codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex"]) if (existsSync(p)) return p;
  return "codex";
}

export function createHub(opts: { dbPath?: string; notify?: (t: string, b: string) => void; metaReader?: any } = {}) {
  const core = new Core(openDb(opts.dbPath ?? DB_PATH), { notify: opts.notify, metaReader: opts.metaReader });
  const jobs = new Jobs(core);
  // A fresh hub has no live Stop-hook connections, so nobody is really on call.
  core.db.prepare("UPDATE agents SET status='asleep' WHERE status='on_call'").run();

  function resolveCaller(ctx: RpcCtx): Agent | undefined {
    const bySession = core.agentBySession(ctx.session_id);
    if (bySession) return bySession;
    if (!ctx.name) return undefined;
    if (ctx.team) return core.agent(ctx.team, ctx.name);
    const all = core.agents().filter((a) => a.name === ctx.name);
    return all.length === 1 ? all[0] : undefined;
  }

  function teamView(team: string) {
    return core.agents(team).map((a) => ({
      name: a.name, role: a.role, runtime: a.runtime, app: a.app, title: a.title, status: a.status, status_text: a.status_text,
      unread: core.unread(team, a.name).length, last_seen_s_ago: Math.round((now() - a.last_seen) / 1000),
    }));
  }

  function inspectAgent(team: string, name: string, view = "digest", limit = 12) {
    const a = core.agent(team, name);
    if (!a) throw new Error(`no agent "${name}"`);
    core.refreshMeta(a);
    const fresh = core.agent(team, name)!;
    const events = a.transcript_path ? readTranscript(a.transcript_path) : [];
    const base = { name: a.name, role: a.role, runtime: a.runtime, app: fresh.app, session_title: fresh.title, model: fresh.model,
      branch: fresh.branch, folders: fresh.folders ? JSON.parse(fresh.folders) : [], status: a.status, status_text: a.status_text,
      tasks: core.tasks(team).filter((t) => t.owner === name && t.status !== "done").map((t) => ({ id: t.id, title: t.title, status: t.status })),
      claims: core.activeClaims(team).filter((c) => c.agent === name).map((c) => c.pattern),
      jobs: jobs.list(team).filter((j) => j.owner === name).slice(0, 5).map((j) => ({ id: j.id, name: j.name, status: j.status, progress: j.progress })),
      findings: core.db.prepare("SELECT body, created FROM messages WHERE team=? AND from_agent=? AND kind='finding' ORDER BY id DESC LIMIT 5").all(team, name),
      transcript_path: a.transcript_path };
    if (view === "timeline") return { ...base, events: events.slice(-Math.min(limit, 300)) };
    return { ...base, ...digest(events, limit), transcript_available: events.length > 0 };
  }

  /** Agent-facing operations (called by the MCP shim). */
  function rpc(tool: string, args: any, ctx: RpcCtx): any {
    if (tool === "register") {
      const t = core.resolveTeam(args.team, ctx.cwd ?? "/");
      const a = core.register({ team: t.id, name: args.name, role: args.role ?? "", runtime: ctx.runtime ?? "unknown",
        cwd: ctx.cwd ?? "/", session_id: ctx.session_id });
      return { registered: a.name, team: t.name, team_id: t.id, folders: JSON.parse(t.folders),
        briefing: core.briefing(a), teammates: teamView(t.id).filter((x) => x.name !== a.name) };
    }
    const me = resolveCaller(ctx);
    if (!me) throw new Error("You are not registered with the gang hub in this session. Call `register` (with team, name, role) first.");
    core.setStatus(me, me.status === "on_call" || me.status === "asleep" ? "working" : me.status);
    const T = me.team;
    switch (tool) {
      case "team": return { you: me.name, team: core.team(T)?.name, on_hold: core.holdReason(T), agents: teamView(T),
        open_tasks: core.tasks(T).filter((t) => t.status !== "done" && t.status !== "cancelled").map((t) => ({ id: t.id, title: t.title, status: t.status, owner: t.owner, blocked_by: t.blocked_by })),
        decisions: core.decisions(T).map((d) => ({ id: d.id, title: d.title })),
        running_jobs: jobs.list(T).filter((j) => j.status === "running").map((j) => ({ id: j.id, owner: j.owner, name: j.name, progress: j.progress })) };
      case "inspect": return inspectAgent(T, args.agent, args.view, args.limit);
      case "send": {
        const m = core.send(T, me.name, args.to, args.body, args.kind ?? "msg", args.reply_to ?? null);
        return { sent: m.id, note: "Delivered to inbox. The recipient sees a notice at its next tool call. Use `wake` only if it must act now." };
      }
      case "inbox": {
        const msgs = core.inbox(T, me.name);
        return msgs.length ? msgs.map((m) => ({ id: m.id, from: m.from_agent, kind: m.kind, to: m.to_agent, body: m.body,
          reply_to: m.thread_id, age_s: Math.round((now() - m.created) / 1000) })) : "No unread messages.";
      }
      case "wake": return core.wake(T, me.name, args.to, args.reason);
      case "post_status": core.postStatus(me, args.text); return "ok";
      case "post_finding": { const m = core.send(T, me.name, "*", args.text, "finding"); return { finding: m.id }; }
      case "job_start": {
        const j = jobs.start({ team: T, owner: me.name, name: args.name, cmd: args.cmd, cwd: args.cwd ?? me.cwd ?? ctx.cwd ?? "/",
          notify: args.notify, env: args.env });
        return { job: j.id, log: j.log_path, note: "Running detached. You'll be messaged (and woken) when it finishes — don't poll; continue other work or end your turn." };
      }
      case "jobs": return args.id ? { ...jobs.get(args.id), tail: jobs.tail(args.id, 20) } : jobs.list(T).slice(0, 20);
      case "job_logs": return jobs.tail(args.id, args.lines ?? 60) || "(no output yet)";
      case "job_kill": return jobs.kill(args.id) ? "killing" : "not running";
      case "task_add": return core.addTask(T, me.name, args);
      case "tasks": {
        let list = core.tasks(T);
        if (args.filter === "mine") list = list.filter((t) => t.owner === me.name);
        else if (args.filter !== "all") list = list.filter((t) => t.status !== "done" && t.status !== "cancelled");
        return list.map((t) => ({ id: t.id, title: t.title, status: t.status, owner: t.owner, created_by: t.created_by, depends_on: t.deps,
          blocked_by: t.blocked_by, body: t.body, notes: JSON.parse(t.notes).slice(-3) }));
      }
      case "task_update": return core.updateTask(T, me.name, args.id, args);
      case "decide": return core.decide(T, me.name, args.title, args.body ?? "", args.supersedes ?? null);
      case "decisions": return core.decisions(T, !!args.all);
      case "claim": return core.claim(me, args.paths, { minutes: args.minutes, exclusive: args.exclusive, note: args.note });
      case "release": return { released: core.release(me, args.paths) };
      case "claims": return core.activeClaims(T).map((c) => ({ agent: c.agent, path: c.pattern, exclusive: !!c.exclusive, note: c.note, until: new Date(c.expires).toISOString() }));
      default: throw new Error(`unknown tool ${tool}`);
    }
  }

  async function body(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const s = Buffer.concat(chunks).toString("utf8");
    return s ? JSON.parse(s) : {};
  }
  const send = (res: ServerResponse, code: number, data: unknown, type = "application/json") => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    res.end(type === "application/json" ? JSON.stringify(data) : (data as string));
  };

  function state(teamId: string) {
    const db = core.db;
    const teams = core.teams().map((t) => ({ ...t, agents: core.agents(t.id).length }));
    const T = teamId && core.team(teamId) ? core.team(teamId)!.id : teams[0]?.id ?? "";
    const agents = core.agents(T).map((a) => { core.refreshMeta(a); return core.agent(T, a.name)!; });
    const humanMsgs = db.prepare(`SELECT m.*, r.read_at FROM messages m LEFT JOIN receipts r ON r.message_id=m.id AND r.agent='human'
      WHERE m.team=? AND (m.to_agent='human' OR (m.to_agent='*' AND m.from_agent!='human' AND m.kind IN ('finding','decision')))
      ORDER BY m.id DESC LIMIT 100`).all(T);
    const settings = T ? core.settings(T) : null;
    return {
      teams, team: T, now: now(), settings, hold: T ? core.holdReason(T) : null,
      agents: agents.map((a) => ({ ...a, folders: a.folders ? JSON.parse(a.folders) : [], approval: a.approval ? JSON.parse(a.approval) : null, unread: core.unread(T, a.name).length,
        on_call: a.session_id ? core.waiters.has(a.session_id) : false })),
      messages: db.prepare("SELECT * FROM messages WHERE team=? ORDER BY id DESC LIMIT 300").all(T),
      activity: db.prepare("SELECT * FROM activity WHERE team=? ORDER BY id DESC LIMIT 300").all(T),
      jobs: jobs.list(T),
      tasks: core.tasks(T),
      decisions: core.decisions(T, true),
      claims: core.activeClaims(T),
      human: { messages: humanMsgs, unread: (humanMsgs as any[]).filter((m) => !m.read_at).length },
    };
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const q = Object.fromEntries(url.searchParams);
    try {
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, pid: process.pid });
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html"))
        return send(res, 200, readFileSync(join(WEB_DIR, "index.html"), "utf8"), "text/html; charset=utf-8");

      // ----- hooks -----
      if (req.method === "POST" && url.pathname === "/hook") {
        const b = await body(req);
        return send(res, 200, core.hookEvent(b.runtime, b.event, b.payload ?? {}));
      }
      if (req.method === "POST" && url.pathname === "/stop-wait") {
        const b = await body(req);
        core.hookEvent(b.runtime, "Stop", b.payload ?? {});
        const text = await core.stopWait(b.payload?.session_id, Number(b.timeout_ms ?? 3_500_000), (cb) => res.on("close", cb));
        if (!res.writableEnded && !res.destroyed) send(res, 200, { text });
        return;
      }

      // ----- agents (MCP shim) -----
      if (req.method === "POST" && url.pathname === "/rpc") {
        const b = await body(req);
        try { return send(res, 200, { ok: true, result: rpc(b.tool, b.args ?? {}, b.ctx ?? {}) }); }
        catch (e: any) { return send(res, 200, { ok: false, error: e.message }); }
      }

      // ----- dashboard -----
      if (req.method === "GET") {
        switch (url.pathname) {
          case "/api/state": return send(res, 200, state(q.team));
          case "/api/agent": return send(res, 200, inspectAgent(q.team, q.name, "timeline", Number(q.limit ?? 200)));
          case "/api/job/log": return send(res, 200, { log: jobs.tail(Number(q.id), Number(q.lines ?? 300)) });
          case "/api/join-prompt": return send(res, 200, { prompt: joinPrompt({ team: q.team, name: q.name, role: q.role || "agent", existing: q.existing === "1" }) });
          case "/api/codex-projects": return send(res, 200, { projects: codexProjects() });
          case "/api/roles": return send(res, 200, ROLES);
          case "/api/defaults": return send(res, 200, DEFAULT_SETTINGS);
        }
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/")) {
        const b = await body(req);
        const T = b.team;
        switch (url.pathname) {
          case "/api/teams/create": return send(res, 200, core.createTeam(b.name, b.folders ?? [], b.source ?? "dashboard"));
          case "/api/teams/update": return send(res, 200, core.updateTeam(T, b));
          case "/api/teams/delete": core.deleteTeam(T); return send(res, 200, { ok: true });
          case "/api/teams/settings": return send(res, 200, core.updateSettings(T, b.settings ?? {}));
          case "/api/teams/pause": return send(res, 200, core.updateSettings(T, { paused: !!b.paused }));
          case "/api/pick-folder": {
            const path = await new Promise<string | null>((resolve) => execFile("osascript", ["-e",
              'POSIX path of (choose folder with prompt "Choose a folder for this gang team")'], (err, out) => resolve(err ? null : out.trim().replace(/\/$/, ""))));
            return send(res, 200, { path });
          }
          case "/api/open-codex": {
            execFile(findCodex(), ["app", b.folder], () => {});
            return send(res, 200, { ok: true });
          }
          case "/api/send": {
            const m = core.send(T, HUMAN, b.to, b.body, b.kind ?? "msg", b.reply_to ?? null);
            const w = b.wake && b.to !== "*" ? core.wake(T, HUMAN, b.to, b.body) : null;
            return send(res, 200, { id: m.id, wake: w });
          }
          case "/api/wake": return send(res, 200, core.wake(T, HUMAN, b.to, b.reason || "The user wants you to check your inbox."));
          case "/api/read": {
            const ids = b.ids ?? (core.db.prepare(`SELECT id FROM messages WHERE team=? AND (to_agent='human' OR to_agent='*')`).all(T) as any[]).map((r) => r.id);
            core.markRead(T, HUMAN, ids); return send(res, 200, { ok: true });
          }
          case "/api/job/kill": return send(res, 200, { ok: jobs.kill(Number(b.id)) });
          case "/api/job/start": return send(res, 200, jobs.start({ team: T, owner: b.owner || HUMAN, name: b.name, cmd: b.cmd, cwd: b.cwd, notify: b.notify, env: b.env }));
          case "/api/agent/remove": core.removeAgent(T, b.name); return send(res, 200, { ok: true });
          case "/api/task/add": return send(res, 200, core.addTask(T, HUMAN, b));
          case "/api/task/update": return send(res, 200, core.updateTask(T, HUMAN, Number(b.id), b));
          case "/api/decision/add": return send(res, 200, core.decide(T, HUMAN, b.title, b.body ?? "", b.supersedes ?? null));
          case "/api/decision/retract": core.retractDecision(T, HUMAN, Number(b.id)); return send(res, 200, { ok: true });
          case "/api/claim/release": core.releaseClaim(T, Number(b.id)); return send(res, 200, { ok: true });
        }
      }
      send(res, 404, { error: "not found" });
    } catch (e: any) {
      if (!res.headersSent) send(res, 400, { error: e.message });
    }
  });
  server.requestTimeout = 0;
  server.timeout = 0;
  return { core, jobs, server, rpc };
}

export function runDaemon() {
  mkdirSync(GANG_HOME, { recursive: true });
  const { server, jobs } = createHub();
  jobs.startPolling();
  server.on("error", (e: any) => {
    if (e.code === "EADDRINUSE") { console.error(`gang hub already running on :${PORT}`); process.exit(0); }
    throw e;
  });
  server.listen(PORT, "127.0.0.1", () => {
    writeFileSync(PID_FILE, String(process.pid));
    console.log(`gang hub listening on http://127.0.0.1:${PORT} (db ${DB_PATH})`);
  });
  // The hub must outlive any single bad request or job.
  process.on("uncaughtException", (e) => console.error(`[${new Date().toISOString()}] uncaught:`, e));
  process.on("unhandledRejection", (e) => console.error(`[${new Date().toISOString()}] unhandled:`, e));
  const stop = () => { jobs.stop(); server.close(); process.exit(0); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

export { HUB, HUMAN, oneLine };
