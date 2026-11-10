// The user's lead agent: one `lead` tool that can see and do everything the dashboard can, as the user.
// Responses are deliberately compact (deltas, one-liners, caps) so the lead's context stays small.
import type { Core } from "./core.ts";
import { HUMAN, oneLine } from "./core.ts";
import type { Jobs } from "./jobs.ts";
import type { Agent, Lead, Message } from "./db.ts";
import { now } from "./db.ts";

export const LEAD_ACTIONS = [
  "help", "register", "status", "brief", "teams", "inspect", "transcript", "activity", "thread", "inbox", "read",
  "send", "reply", "wake", "tasks", "task_add", "task_update", "decisions", "decide", "retract", "claims", "release_claim",
  "jobs", "job_start", "job_logs", "job_kill", "pause", "resume", "settings", "team_create", "join_prompt", "set_wake",
] as const;

export const LEAD_HELP = `gang lead tool — you act for the user across all their gang teams. Call with {action, ...}.
Read (cheap first, drill down only as needed):
  brief {team?, peek?}            what's new since your last brief + what needs the user (approvals, questions). Start here.
                                  (only a full brief, without team or peek, marks things as seen)
  teams                           teams, folders, agent counts, on-hold state
  inspect {team?, agent, view?}   one agent: status, session/app, tasks, claims, jobs, findings, recent actions
  transcript {team?, agent, limit?}  that agent's recent conversation (max 60 events)
  activity {team?, limit?, kind?, agent?, before_id?}  readable feed lines (max 40)
  thread {id}                     a message and its replies
  inbox {all?}                    messages to the user (unread by default); read {ids?} marks them read
  tasks {team?, filter?} · decisions {team?} · claims {team?} · jobs {team?} · job_logs {id, lines?}
Act as the user (labeled "via lead" everywhere; agents treat it as the user for coordination):
  send {team?, to, body, kind?, reply_to?, wake?}   reply {id, body, wake?}   wake {team?, to, reason}
  task_add {team?, title, body?, owner?, depends_on?}   task_update {team?, id, status?, owner?, note?}
  decide {team?, title, body?, supersedes?}   retract {team?, id}   release_claim {team?, id}
  job_start {team?, cmd, cwd?, name?, owner?}   job_kill {id}
  pause {team?} · resume {team?} · settings {team?, settings?}   (settings without values = read)
  team_create {name, folders[]}   join_prompt {team?, name, role, existing?}  (hand the prompt to the user; never start agents)
  set_wake {on}                   wake this chat when something needs the user (default off)
Rules: confirm with the user before anything big or irreversible (killing jobs, retracting decisions, pausing, assigning
large work). Summarize for the user in plain words; don't paste raw tool output. Wakes you send count against an agent's
autonomy budget; only the user talking to the agent directly resets it.`;

const clip = (s: string, n: number) => oneLine(String(s ?? ""), n);

export function leadAction(core: Core, jobs: Jobs, deps: { inspectAgent: Function; joinPrompt: Function },
  lead: Lead, action: string, a: any): any {
  const teamOf = (t?: string) => {
    if (t) { const x = core.team(t); if (!x) throw new Error(`no team "${t}". Teams: ${core.teams().map((x) => x.name).join(", ")}`); return x.id; }
    const all = core.teams();
    if (all.length === 1) return all[0].id;
    const withAgents = all.filter((x) => core.agents(x.id).length);
    if (withAgents.length === 1) return withAgents[0].id;
    throw new Error(`which team? pass team: one of ${all.map((x) => x.name).join(", ")}`);
  };
  const ago = (t: number) => { const s = Math.round((now() - t) / 1000); return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${(s / 3600).toFixed(1)}h ago`; };
  const agentLine = (x: Agent) => {
    const appr = x.approval ? ` ⚠ waiting for user approval: ${clip(JSON.parse(x.approval).detail, 80)}` : "";
    return `${x.name} (${x.role}, ${x.app ?? x.runtime}${x.title ? ` “${clip(x.title, 40)}”` : ""}) ${x.status}${x.status_text ? ` — ${clip(x.status_text, 90)}` : ""}` +
      `${core.unread(x.team, x.name).length ? ` [${core.unread(x.team, x.name).length} unread]` : ""}${appr}`;
  };
  const msgLine = (m: Message & { via?: string | null }, full = false) =>
    `#${m.id} ${m.from_agent === HUMAN ? (m.via ? `user via ${m.via}` : "user") : m.from_agent} → ${m.to_agent === "*" ? "everyone" : m.to_agent === HUMAN ? "user" : m.to_agent}` +
    `${m.kind !== "msg" ? ` [${m.kind}]` : ""}${m.thread_id ? ` (re #${m.thread_id})` : ""} ${ago(m.created)}: ${full ? String(m.body ?? "").slice(0, 4000) : clip(m.body, 300)}`;

  switch (action) {
    case "help": return LEAD_HELP;
    case "status": return { you: lead.name, status: lead.status, wake_on_needs: !!lead.wake_on_needs };
    case "set_wake": core.setLeadWake(lead.id, !!a.on); return { wake_on_needs: !!a.on };

    case "brief": {
      const teams = a.team ? [core.team(teamOf(a.team))!] : core.teams().filter((t) => core.agents(t.id).length);
      const { approvals, unread } = core.needsYou();
      const db = core.db;
      const out: any = {
        needs_user: {
          approvals: approvals.map((x) => `${x.agent} (${x.team}) wants to ${clip(x.detail, 140)} — waiting ${ago(x.at)}; approve in ${x.app ?? "its app"}${x.session_title ? ` “${x.session_title}”` : ""}`),
          messages: unread.slice(-10).map(msgLine),
          ...(unread.length > 10 ? { more_messages: unread.length - 10 } : {}),
        },
        teams: [] as any[],
      };
      for (const t of teams) {
        const rows = db.prepare("SELECT * FROM activity WHERE team=? AND id > ? ORDER BY id").all(t.id, lead.seen_activity) as any[];
        const pick = (pred: (r: any) => boolean, n: number, len = 160) => {
          const r = rows.filter(pred); const lines = r.slice(-n).map((x) => `${x.actor ?? ""}${x.via ? ` (via ${x.via})` : ""}: ${clip(x.text, len)}`);
          return r.length > n ? [...lines, `+${r.length - n} more`] : lines;
        };
        const tasks = core.tasks(t.id);
        const entry: any = {
          team: t.name, on_hold: core.holdReason(t.id),
          agents: core.agents(t.id).map(agentLine),
          open_tasks: tasks.filter((x) => !["done", "cancelled"].includes(x.status)).length,
          blocked_tasks: tasks.filter((x) => x.blocked_by.length && x.status !== "done").map((x) => `#${x.id} ${clip(x.title, 60)} waits on #${x.blocked_by.join(",#")}`),
          running_jobs: jobs.list(t.id).filter((j) => j.status === "running").map((j) => `#${j.id} ${j.owner}: ${clip(j.name, 50)} ${j.progress ?? ""}`),
        };
        const nw: any = {
          findings: pick((r) => r.kind === "finding", 5, 240),
          decisions: pick((r) => r.kind === "decision", 5, 200),
          jobs_finished: pick((r) => r.kind === "job" && /succeeded|failed|killed/.test(r.text), 5),
          task_changes: pick((r) => r.kind === "task", 6, 140),
          guardrails: pick((r) => r.kind === "guardrail" || r.kind === "wake_limited", 4),
          joined: pick((r) => r.kind === "register", 4),
          agent_messages: rows.filter((r) => r.kind === "message" && r.actor !== HUMAN).length,
          wakes: rows.filter((r) => r.kind === "wake").length,
        };
        for (const k of Object.keys(nw)) if (Array.isArray(nw[k]) ? !nw[k].length : !nw[k]) delete nw[k];
        if (Object.keys(nw).length) entry.new_since_last_brief = nw;
        out.teams.push(entry);
      }
      // Read marks are global, so only a full brief moves them; a one-team brief would hide other teams' news.
      if (!a.peek && !a.team) {
        const maxA = (db.prepare("SELECT COALESCE(MAX(id),0) m FROM activity").get() as any).m;
        const maxM = (db.prepare("SELECT COALESCE(MAX(id),0) m FROM messages").get() as any).m;
        db.prepare("UPDATE leads SET seen_activity=?, seen_message=?, noticed_message=?, noticed_activity=? WHERE id=?").run(maxA, maxM, maxM, maxA, lead.id);
        core.leadNoticedAt.set(lead.id, now());
      }
      if (!out.teams.length) out.hint = "No teams with agents yet. Use team_create, then join_prompt to give the user prompts to paste into sessions.";
      return out;
    }

    case "teams": return core.teams().map((t) => ({ team: t.name, id: t.id, folders: t.folderList, agents: core.agents(t.id).length, on_hold: core.holdReason(t.id) }));
    case "inspect": { const T = teamOf(a.team); const d = deps.inspectAgent(T, a.agent, "digest", Math.min(a.limit ?? 10, 20)); return d; }
    case "transcript": {
      const T = teamOf(a.team);
      const d = deps.inspectAgent(T, a.agent, "timeline", Math.min(a.limit ?? 30, 60));
      return { agent: a.agent, events: d.events.map((e: any) => `${e.ts ? e.ts.slice(11, 16) : ""} ${e.kind === "tool_call" ? `→ ${e.tool}` : e.kind}: ${clip(e.text, e.kind.startsWith("tool") ? 140 : 500)}`) };
    }
    case "activity": {
      const T = teamOf(a.team);
      const lim = Math.min(a.limit ?? 20, 40);
      const rows = core.db.prepare(`SELECT * FROM activity WHERE team=? ${a.before_id ? "AND id < ?" : ""} ${a.kind ? "AND kind = ?" : ""}
        ${a.agent ? "AND (actor = ? OR target = ?)" : ""} ORDER BY id DESC LIMIT ?`)
        .all(...[T, ...(a.before_id ? [a.before_id] : []), ...(a.kind ? [a.kind] : []), ...(a.agent ? [a.agent, a.agent] : []), lim]) as any[];
      return rows.map((r) => `#${r.id} ${ago(r.ts)} ${r.kind} ${r.actor ?? ""}${r.via ? ` (via ${r.via})` : ""}${r.target ? ` → ${r.target}` : ""}: ${clip(r.text, 300)}`);
    }
    case "thread": {
      const root = core.db.prepare("SELECT * FROM messages WHERE id=?").get(a.id) as any;
      if (!root) throw new Error(`no message #${a.id}`);
      const top = root.thread_id ? core.db.prepare("SELECT * FROM messages WHERE id=?").get(root.thread_id) as any ?? root : root;
      const replies = core.db.prepare("SELECT * FROM messages WHERE thread_id=? ORDER BY id").all(top.id) as any[];
      return [top, ...replies].map((m) => msgLine(m, true));
    }
    case "inbox": {
      const rows = core.db.prepare(`SELECT m.*, r.read_at FROM messages m LEFT JOIN receipts r ON r.message_id=m.id AND r.agent='human'
        WHERE m.to_agent='human' ${a.all ? "" : "AND r.read_at IS NULL"} ORDER BY m.id DESC LIMIT 20`).all() as any[];
      return rows.length ? rows.reverse().map((m) => `${m.read_at ? "" : "• "}${msgLine(m)}`) : "Nothing unread for the user.";
    }
    case "read": {
      const ids = a.ids ?? (core.db.prepare(`SELECT id FROM messages WHERE to_agent='human'`).all() as any[]).map((r) => r.id);
      for (const t of core.teams()) core.markRead(t.id, HUMAN, ids);
      return { marked: ids.length };
    }
    case "tasks": {
      const T = teamOf(a.team);
      let list = core.tasks(T);
      if (a.filter !== "all") list = list.filter((t) => !["done", "cancelled"].includes(t.status));
      return list.map((t) => `#${t.id} [${t.status}] ${t.title}${t.owner ? ` — ${t.owner}` : ""}${t.blocked_by.length ? ` (waits on #${t.blocked_by.join(",#")})` : ""}`);
    }
    case "decisions": return core.decisions(teamOf(a.team)).map((d) => `#${d.id} ${d.title}${d.body ? `: ${clip(d.body, 200)}` : ""} (${d.decided_by})`);
    case "claims": return core.activeClaims(teamOf(a.team)).map((c) => `#${c.id} ${c.agent}: ${c.pattern}${c.note ? ` — ${c.note}` : ""} until ${new Date(c.expires).toLocaleTimeString()}`);
    case "jobs": return jobs.list(teamOf(a.team)).slice(0, 15).map((j) => `#${j.id} [${j.status}${j.exit_code != null ? ` exit ${j.exit_code}` : ""}] ${j.owner}: ${clip(j.name, 60)} ${j.progress ?? ""}`);
    case "job_logs": return jobs.tail(a.id, Math.min(a.lines ?? 40, 200)) || "(no output yet)";
  }

  // ----- acting as the user: everything below is labeled "via <lead>" -----
  core.via = lead.name;
  try {
    switch (action) {
      case "send": {
        const T = teamOf(a.team);
        const m = core.send(T, HUMAN, a.to, a.body, a.kind ?? "msg", a.reply_to ?? null);
        const w = a.wake && a.to !== "*" ? core.wake(T, HUMAN, a.to, a.body) : null;
        return { sent: m.id, ...(w ? { wake: w.note } : {}) };
      }
      case "reply": {
        const m = core.db.prepare("SELECT * FROM messages WHERE id=?").get(a.id) as any;
        if (!m) throw new Error(`no message #${a.id}`);
        if (m.from_agent === HUMAN || m.from_agent === "gang") throw new Error("that message isn't from an agent; use send");
        const r = core.send(m.team, HUMAN, m.from_agent, a.body, "answer", m.id);
        core.markRead(m.team, HUMAN, [m.id]);
        const w = a.wake ? core.wake(m.team, HUMAN, m.from_agent, a.body) : null;
        return { sent: r.id, to: m.from_agent, ...(w ? { wake: w.note } : {}) };
      }
      case "wake": return core.wake(teamOf(a.team), HUMAN, a.to, a.reason);
      case "task_add": return core.addTask(teamOf(a.team), HUMAN, a);
      case "task_update": return core.updateTask(teamOf(a.team), HUMAN, a.id, a);
      case "decide": return core.decide(teamOf(a.team), HUMAN, a.title, a.body ?? "", a.supersedes ?? null);
      case "retract": core.retractDecision(teamOf(a.team), HUMAN, a.id); return "retracted";
      case "release_claim": core.releaseClaim(teamOf(a.team), a.id); return "released";
      case "job_start": {
        const T = teamOf(a.team);
        const j = jobs.start({ team: T, owner: a.owner ?? HUMAN, name: a.name, cmd: a.cmd, cwd: a.cwd ?? JSON.parse(core.team(T)!.folders)[0] ?? "/", notify: a.notify });
        return { job: j.id, log: j.log_path };
      }
      case "job_kill": return jobs.kill(a.id) ? "stopping" : "not running";
      case "pause": core.updateSettings(teamOf(a.team), { paused: true }); return "paused";
      case "resume": core.updateSettings(teamOf(a.team), { paused: false }); return "resumed";
      case "settings": return a.settings ? core.updateSettings(teamOf(a.team), a.settings) : core.settings(teamOf(a.team));
      case "team_create": { const t = core.createTeam(a.name, a.folders ?? [], "lead"); return { team: t.name, id: t.id, folders: JSON.parse(t.folders) }; }
      case "join_prompt": {
        const T = teamOf(a.team);
        return { prompt: deps.joinPrompt({ team: core.team(T)!.name, name: a.name, role: a.role ?? "agent", existing: !!a.existing }),
          note: "Give this to the user to paste into a Codex or Claude session (new or existing). Don't start sessions yourself." };
      }
      default: throw new Error(`unknown action "${action}". Try action "help".`);
    }
  } finally { core.via = null; }
}

export function leadJoinPrompt(name = "lead") {
  return `You're my gang lead (\`${name}\`): my own assistant for orchestrating my coding agents with the gang hub. ` +
    `You don't do the team's coding work; you help me see what's going on, understand results and messages, and act for me when I ask.\n` +
    `1. Call the gang \`lead\` tool with action "register" and name "${name}". I'll approve you in the dashboard (or with \`gang lead approve\`). ` +
    `If you have no gang tools, tell me: this session started before gang was installed and needs reopening.\n` +
    `2. Once approved, call action "help" once, then "brief" whenever I ask what's happening (it returns only what's new, plus anything waiting on me).\n` +
    `3. Keep your context lean: brief first, drill into one agent/thread only when needed, and summarize for me in plain words instead of pasting tool output.\n` +
    `4. When you message, wake, or assign work, you're acting as me and agents will treat it that way, so do it when I ask or when it's clearly routine coordination, ` +
    `and check with me before anything big or irreversible. Never start or spawn agents; give me join prompts to paste instead.\n` +
    `A [gang] line in your context when I message you is just a heads-up about new activity; mention it only if relevant.`;
}
