import type { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { basename, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import type { Agent, Claim, Decision, Lead, Message, Session, Status, Task, Team, Wake } from "./db.ts";
import { randomUUID } from "node:crypto";
import { now, slug } from "./db.ts";
import { projectFor } from "./paths.ts";
import { sessionMeta } from "./meta.ts";

export const WAKE_LIMIT_PER_HOUR = Number(process.env.GANG_WAKE_LIMIT ?? 4);

/** Per-team guardrails. Everything an agent can do on its own is bounded by these. */
export const DEFAULT_SETTINGS = {
  paused: false,                       // no agent-initiated wakes, nobody goes on call
  quiet_hours: null as null | { start: string; end: string }, // local "HH:MM"; same effect as paused while inside
  wake_limit_per_agent: WAKE_LIMIT_PER_HOUR, // wakes an agent can receive from teammates per hour
  wake_limit_per_sender: 8,            // wakes one agent can send per hour
  ping_pong_limit: 3,                  // A→B and B→A wakes each, within 30 min, before that pair is held
  autonomy_budget: 10,                 // turns an agent can be woken into before it needs you again
  message_limit: 40,                   // messages one agent can send per 10 min
  max_running_jobs: 4,                 // per team
  max_job_hours: 0,                    // kill jobs running longer than this (0 = no limit)
  approval_nudge_s: 45,                // notify you when an approval has waited this long
};
export type Settings = typeof DEFAULT_SETTINGS;
export const HUMAN = "human";
export const HUB = "gang";
const TASK_STATUSES = ["open", "in_progress", "review", "done", "cancelled"];

type Waiter = { team: string; name: string; resolve: (text: string | null) => void };
export type HookResult = { context?: string | null; deny?: string | null };

/** All hub state transitions. HTTP-free so it can be tested directly. */
export class Core {
  db: DatabaseSync;
  waiters = new Map<string, Waiter>(); // session_id -> pending Stop-hook long-poll
  leadWaiters = new Map<string, (text: string | null) => void>(); // lead session_id -> Stop-hook long-poll
  leadNoticedAt = new Map<string, number>(); // lead id -> when it last got a notice (approvals are live state)
  /** Set while the lead acts on the user's behalf: everything recorded meanwhile is labeled "via <lead>". */
  via: string | null = null;
  notify: (title: string, body: string) => void;
  metaReader: typeof sessionMeta;

  constructor(db: DatabaseSync, opts: { notify?: (t: string, b: string) => void; metaReader?: typeof sessionMeta } = {}) {
    this.db = db;
    this.notify = opts.notify ?? macNotify;
    this.metaReader = opts.metaReader ?? sessionMeta;
  }

  // ---------- activity feed ----------
  activity(team: string, kind: string, actor: string | null, target: string | null, text: string, ref: number | null = null) {
    this.db.prepare("INSERT INTO activity (team, ts, kind, actor, target, text, ref, via) VALUES (?,?,?,?,?,?,?,?)")
      .run(team, now(), kind, actor, target, text, ref, actor === HUMAN ? this.via : null);
  }
  /** How an agent should see a sender: the user, the user via their lead, or a teammate. */
  senderLabel(m: { from_agent: string; via?: string | null }) {
    return m.from_agent === HUMAN ? (m.via ? `the user (via their lead ${m.via})` : "the user") : m.from_agent;
  }

  // ---------- teams ----------
  teams(): (Team & { folderList: string[] })[] {
    return (this.db.prepare("SELECT * FROM teams ORDER BY created").all() as unknown as Team[]).map((t) => ({ ...t, folderList: JSON.parse(t.folders) }));
  }
  team(idOrName: string): Team | undefined {
    return (this.db.prepare("SELECT * FROM teams WHERE id=?").get(idOrName) ??
      this.db.prepare("SELECT * FROM teams WHERE lower(name)=lower(?)").get(idOrName)) as Team | undefined;
  }
  createTeam(name: string, folders: string[], source: string | null = null): Team {
    name = name.trim();
    if (!name) throw new Error("team name is required");
    const existing = this.team(name);
    if (existing) throw new Error(`a team named "${existing.name}" already exists`);
    let id = slug(name); let n = 2;
    while (this.team(id)) id = `${slug(name)}-${n++}`;
    const clean = [...new Set(folders.map(expandHome).filter(Boolean))];
    this.db.prepare("INSERT INTO teams (id, name, folders, source, created) VALUES (?,?,?,?,?)").run(id, name, JSON.stringify(clean), source, now());
    this.activity(id, "team", HUMAN, null, `Team "${name}" created${clean.length ? ` for ${clean.map((f) => basename(f)).join(", ")}` : ""}`);
    return this.team(id)!;
  }
  updateTeam(id: string, p: { name?: string; folders?: string[] }) {
    const t = this.team(id);
    if (!t) throw new Error(`no team "${id}"`);
    if (p.name) this.db.prepare("UPDATE teams SET name=? WHERE id=?").run(p.name.trim(), t.id);
    if (p.folders) this.db.prepare("UPDATE teams SET folders=? WHERE id=?").run(JSON.stringify([...new Set(p.folders.map(expandHome).filter(Boolean))]), t.id);
    return this.team(t.id)!;
  }
  deleteTeam(id: string) {
    for (const t of ["agents", "claims", "tasks", "decisions", "messages", "wakes", "activity", "jobs"]) this.db.prepare(`DELETE FROM ${t} WHERE team=?`).run(id);
    this.db.prepare("DELETE FROM teams WHERE id=?").run(id);
  }
  settings(team: string): Settings {
    const t = this.team(team);
    let saved = {};
    try { saved = JSON.parse(t?.settings || "{}"); } catch {}
    return { ...DEFAULT_SETTINGS, ...saved };
  }
  updateSettings(team: string, patch: Partial<Settings>, by = HUMAN): Settings {
    const t = this.team(team);
    if (!t) throw new Error(`no team "${team}"`);
    const cur = this.settings(t.id);
    const next: any = { ...cur };
    for (const [k, v] of Object.entries(patch)) if (k in DEFAULT_SETTINGS) next[k] = v;
    if (next.quiet_hours && !(/^\d{1,2}:\d{2}$/.test(next.quiet_hours.start) && /^\d{1,2}:\d{2}$/.test(next.quiet_hours.end))) throw new Error("quiet hours must look like 23:00–08:00");
    this.db.prepare("UPDATE teams SET settings=? WHERE id=?").run(JSON.stringify(next), t.id);
    if (patch.paused !== undefined && patch.paused !== cur.paused) {
      this.activity(t.id, "guardrail", by, null, next.paused ? "paused the team: agents finish their current turn, then wait for you" : "resumed the team");
      if (next.paused) this.releaseWaiters(t.id);
    } else this.activity(t.id, "guardrail", by, null, "changed guardrail settings");
    return next;
  }
  /** Why agent-initiated activity is on hold right now (paused / quiet hours), or null. */
  holdReason(team: string): string | null {
    const st = this.settings(team);
    if (st.paused) return "the team is paused";
    if (st.quiet_hours && inWindow(st.quiet_hours.start, st.quiet_hours.end, new Date())) return `it's quiet hours (${st.quiet_hours.start}–${st.quiet_hours.end})`;
    return null;
  }
  releaseWaiters(team: string) {
    for (const [sid, w] of this.waiters) if (w.team === team) {
      this.waiters.delete(sid); w.resolve(null);
      const a = this.agentBySession(sid); if (a) this.setStatus(a, "asleep");
    }
  }
  /** Tell the user a guardrail stopped something (deduped for 10 min per key). */
  trip(team: string, key: string, text: string) {
    const recent = this.db.prepare(`SELECT 1 FROM messages WHERE team=? AND from_agent='gang' AND to_agent='human' AND kind='guardrail' AND body=? AND created > ?`)
      .get(team, text, now() - 600_000);
    this.activity(team, "guardrail", HUB, null, text);
    if (recent) return;
    this.db.prepare(`INSERT INTO messages (team, from_agent, to_agent, kind, body, created) VALUES (?,?,?,?,?,?)`).run(team, HUB, HUMAN, "guardrail", text, now());
    this.notify(`gang: guardrail (${key})`, text.slice(0, 180));
    this.pokeLead(`guardrail in team ${team}: ${oneLine(text, 160)}`);
  }

  teamsForPath(path: string): Team[] {
    return this.teams().filter((t) => t.folderList.some((f) => path === f || path.startsWith(f + "/")));
  }
  /** Pick the team for a registering agent: explicit name, else the one team covering its folder. */
  resolveTeam(requested: string | null | undefined, cwd: string): Team {
    if (requested) {
      const t = this.team(requested);
      if (t) return t;
      return this.createTeam(requested, [projectFor(cwd)], "agent");
    }
    const matches = this.teamsForPath(cwd);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`several teams cover ${cwd} (${matches.map((m) => m.name).join(", ")}); pass \`team\` to choose one`);
    const root = projectFor(cwd);
    return this.createTeam(this.team(basename(root)) ? `${basename(root)}-${Date.now() % 1000}` : basename(root), [root], "auto");
  }

  // ---------- agents & sessions ----------
  agent(team: string, name: string): Agent | undefined {
    return this.db.prepare("SELECT * FROM agents WHERE team=? AND name=?").get(team, name) as Agent | undefined;
  }
  agentBySession(sid: string | null | undefined): Agent | undefined {
    if (!sid) return undefined;
    return this.db.prepare("SELECT * FROM agents WHERE session_id=?").get(sid) as Agent | undefined;
  }
  agents(team?: string): Agent[] {
    return (team
      ? this.db.prepare("SELECT * FROM agents WHERE team=? ORDER BY created").all(team)
      : this.db.prepare("SELECT * FROM agents ORDER BY team, created").all()) as unknown as Agent[];
  }
  session(sid: string): Session | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE session_id=?").get(sid) as Session | undefined;
  }

  setStatus(a: Agent, status: Status) {
    if (a.status === status) {
      this.db.prepare("UPDATE agents SET last_seen=? WHERE team=? AND name=?").run(now(), a.team, a.name);
      return;
    }
    this.db.prepare("UPDATE agents SET status=?, last_seen=? WHERE team=? AND name=?").run(status, now(), a.team, a.name);
    a.status = status;
  }

  register(p: { team: string; name: string; role: string; runtime: string; cwd: string; session_id?: string | null }) {
    const name = p.name.trim();
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(name)) throw new Error("name must be 1-40 chars of letters, digits, _ . -");
    if (name === HUMAN || name === HUB || name === "*") throw new Error(`"${name}" is reserved`);
    const existing = this.agent(p.team, name);
    const t = now();
    if (existing) {
      this.db.prepare("UPDATE agents SET role=?, runtime=?, cwd=?, last_seen=?, status='working' WHERE team=? AND name=?")
        .run(p.role || existing.role, p.runtime, p.cwd, t, p.team, name);
    } else {
      this.db.prepare(`INSERT INTO agents (team, name, role, runtime, cwd, status, last_seen, created)
        VALUES (?,?,?,?,?,'working',?,?)`).run(p.team, name, p.role, p.runtime, p.cwd, t, t);
    }
    if (p.session_id) this.bindSession(p.team, name, p.session_id);
    this.activity(p.team, "register", name, null, `joined the gang as ${p.role || "agent"} (${p.runtime})`);
    return this.agent(p.team, name)!;
  }

  bindSession(team: string, name: string, sid: string) {
    this.db.prepare("UPDATE agents SET session_id=NULL WHERE session_id=? AND NOT (team=? AND name=?)").run(sid, team, name);
    const s = this.session(sid);
    this.db.prepare("UPDATE agents SET session_id=?, transcript_path=COALESCE(?, transcript_path), meta_at=NULL WHERE team=? AND name=?")
      .run(sid, s?.transcript_path ?? null, team, name);
    const a = this.agent(team, name);
    if (a) this.refreshMeta(a, true);
  }

  /** Pull title/model/app/branch/folders from the agent's own app records (throttled). */
  refreshMeta(a: Agent, force = false) {
    if (!force && a.meta_at && now() - a.meta_at < 20_000) return;
    this.db.prepare("UPDATE agents SET meta_at=? WHERE team=? AND name=?").run(now(), a.team, a.name);
    try {
      const m = this.metaReader(a.runtime, a.session_id, a.transcript_path);
      if (!m) return;
      this.db.prepare(`UPDATE agents SET title=COALESCE(?, title), model=COALESCE(?, model), effort=COALESCE(?, effort),
        app=COALESCE(?, app), branch=COALESCE(?, branch), folders=COALESCE(?, folders) WHERE team=? AND name=?`)
        .run(m.title ?? null, m.model ?? null, m.effort ?? null, m.app ?? null, m.branch ?? null,
          m.folders ? JSON.stringify(m.folders) : null, a.team, a.name);
    } catch { /* metadata is best-effort */ }
  }

  removeAgent(team: string, name: string) {
    this.db.prepare("DELETE FROM agents WHERE team=? AND name=?").run(team, name);
    this.db.prepare("UPDATE claims SET released=? WHERE team=? AND agent=? AND released IS NULL").run(now(), team, name);
    this.activity(team, "remove", HUMAN, name, `removed ${name} from the team`);
  }

  // ---------- messages ----------
  send(team: string, from: string, to: string, body: string, kind = "msg", thread_id: number | null = null): Message {
    if (to !== "*" && to !== HUMAN && !this.agent(team, to)) {
      const names = this.agents(team).map((a) => a.name).join(", ") || "(none)";
      throw new Error(`no agent "${to}" in this team. Known: ${names}, human, *`);
    }
    if (from !== HUMAN && from !== HUB) {
      const lim = this.settings(team).message_limit;
      const n = (this.db.prepare("SELECT COUNT(*) n FROM messages WHERE team=? AND from_agent=? AND created > ?").get(team, from, now() - 600_000) as { n: number }).n;
      if (n >= lim) {
        this.trip(team, "messages", `${from} hit the message limit (${lim} per 10 min); further messages are refused until it slows down.`);
        throw new Error(`Message limit reached (${lim} per 10 minutes). Combine updates into fewer, fuller messages.`);
      }
    }
    const r = this.db.prepare(`INSERT INTO messages (team, from_agent, to_agent, kind, body, thread_id, created, via)
      VALUES (?,?,?,?,?,?,?,?)`).run(team, from, to, kind, body, thread_id, now(), from === HUMAN ? this.via : null);
    const id = Number(r.lastInsertRowid);
    if (to === HUMAN) {
      this.notify(`gang: ${from} → you`, body.slice(0, 180));
      this.pokeLead(`${from} sent the user a ${kind === "msg" ? "message" : kind} in team ${team}: "${oneLine(body, 140)}"`);
    }
    const actKind = kind === "finding" ? "finding" : kind === "decision" || kind === "task" ? null : "message";
    if (actKind) this.activity(team, actKind, from, to, body, id);
    return this.db.prepare("SELECT * FROM messages WHERE id=?").get(id) as unknown as Message;
  }

  unread(team: string, name: string, onlyUnnotified = false): Message[] {
    return this.db.prepare(`
      SELECT m.* FROM messages m
      LEFT JOIN receipts r ON r.message_id = m.id AND r.agent = ?
      WHERE m.team = ? AND (m.to_agent = ? OR (m.to_agent = '*' AND m.from_agent != ?))
        AND r.read_at IS NULL ${onlyUnnotified ? "AND r.notified_at IS NULL" : ""}
      ORDER BY m.id`).all(name, team, name, name) as unknown as Message[];
  }

  private mark(ids: number[], name: string, col: "notified_at" | "read_at") {
    const st = this.db.prepare(`INSERT INTO receipts (message_id, agent, ${col}) VALUES (?,?,?)
      ON CONFLICT(message_id, agent) DO UPDATE SET ${col}=excluded.${col}`);
    const t = now();
    for (const id of ids) st.run(id, name, t);
  }

  inbox(team: string, name: string): Message[] {
    const msgs = this.unread(team, name);
    this.mark(msgs.map((m) => m.id), name, "read_at");
    this.db.prepare(`UPDATE wakes SET delivered_at=?, method='read' WHERE team=? AND to_agent=? AND delivered_at IS NULL`)
      .run(now(), team, name);
    return msgs;
  }
  markRead(team: string, name: string, ids: number[]) { this.mark(ids, name, "read_at"); }

  /** Short notice for hook injection: only messages not yet announced. */
  notice(a: Agent): string | null {
    const fresh = this.unread(a.team, a.name, true);
    if (!fresh.length) return null;
    this.mark(fresh.map((m) => m.id), a.name, "notified_at");
    const total = this.unread(a.team, a.name).length;
    const lines = fresh.slice(0, 5).map((m) => `- ${m.kind === "wake" ? "WAKE " : m.kind !== "msg" ? m.kind.toUpperCase() + " " : ""}from ${this.senderLabel(m)}: "${oneLine(m.body, 90)}"`);
    return `[gang] You have ${total} unread team message(s) via the gang hub:\n${lines.join("\n")}\n` +
      `Read them with the gang \`inbox\` tool when you reach a sensible point (now, if urgent).`;
  }

  // ---------- wakes ----------
  wake(team: string, from: string, to: string, reason: string, opts: { exempt?: boolean } = {}) {
    const target = this.agent(team, to);
    if (!target) throw new Error(`no agent "${to}" in this team`);
    const exempt = opts.exempt || from === HUMAN || from === HUB;
    const st = this.settings(team);
    const held = (method: string, why: string, userNote?: string) => {
      this.send(team, from, to, reason, "msg");
      this.activity(team, "wake_limited", from, to, why);
      if (userNote) this.trip(team, method, userNote);
      return { delivered: false, method, note: `Not woken: ${why}. Your note was delivered as a normal message instead.` };
    };
    if (from !== HUMAN) {
      const hold = this.holdReason(team);
      if (hold) return held("held", hold);
    }
    if (from !== HUMAN || this.via) {
      if (target.auto_turns >= st.autonomy_budget)
        return held("budget", `${to} has been woken ${target.auto_turns} times without you`,
          `${to} reached its autonomy budget (${st.autonomy_budget} wakes without you). Wakes are held until you send it a message or wake it yourself.`);
    }
    if (!exempt) {
      const count = (sql: string, ...a: any[]) => (this.db.prepare(sql).get(...a) as { n: number }).n;
      const hour = now() - 3600_000;
      if (count("SELECT COUNT(*) n FROM wakes WHERE team=? AND to_agent=? AND exempt=0 AND created > ?", team, to, hour) >= st.wake_limit_per_agent)
        return held("rate_limited", `${to} already received ${st.wake_limit_per_agent} wakes this hour`);
      if (count("SELECT COUNT(*) n FROM wakes WHERE team=? AND from_agent=? AND exempt=0 AND created > ?", team, from, hour) >= st.wake_limit_per_sender)
        return held("rate_limited", `${from} already sent ${st.wake_limit_per_sender} wakes this hour`);
      const half = now() - 1800_000;
      const ab = count("SELECT COUNT(*) n FROM wakes WHERE team=? AND from_agent=? AND to_agent=? AND created > ?", team, from, to, half);
      const ba = count("SELECT COUNT(*) n FROM wakes WHERE team=? AND from_agent=? AND to_agent=? AND created > ?", team, to, from, half);
      if (ab >= st.ping_pong_limit && ba >= st.ping_pong_limit)
        return held("ping_pong", `${from} and ${to} keep waking each other`,
          `${from} and ${to} have woken each other ${ab}+${ba} times in 30 min; wakes between them are held for now. Check whether they're stuck in a loop.`);
    }
    const msg = this.send(team, from, to, reason, "wake");
    const r = this.db.prepare(`INSERT INTO wakes (team, from_agent, to_agent, reason, created, exempt, via) VALUES (?,?,?,?,?,?,?)`)
      .run(team, from, to, reason, now(), exempt ? 1 : 0, from === HUMAN ? this.via : null);
    const wakeId = Number(r.lastInsertRowid);
    const waiter = target.session_id ? this.waiters.get(target.session_id) : undefined;
    let method: string;
    if (waiter) {
      method = "on_call";
      this.deliverWake(target, waiter);
    } else if (target.status === "working" || target.status === "waiting_permission") {
      method = "pending";
    } else {
      method = "notified";
      this.notify(`gang: ${from} needs ${to}`, `${oneLine(reason, 140)} — open ${to}'s thread to wake it.`);
      this.db.prepare("UPDATE wakes SET method='notified' WHERE id=?").run(wakeId);
    }
    // the message activity row already exists; tag it as a wake
    this.db.prepare("UPDATE activity SET kind='wake', text=? WHERE ref=? AND kind='message'").run(`${method}::${reason}`, msg.id);
    const note = {
      on_call: `${to} was on call and has been woken.`,
      pending: `${to} is busy; it sees a notice at its next tool call and will be woken when its turn ends.`,
      notified: `${to} is asleep; the user was notified to wake it. Your message is in its inbox.`,
    }[method];
    return { delivered: method === "on_call", method, note };
  }

  private pendingWakes(a: Agent): Wake[] {
    return this.db.prepare("SELECT * FROM wakes WHERE team=? AND to_agent=? AND delivered_at IS NULL ORDER BY id")
      .all(a.team, a.name) as unknown as Wake[];
  }

  private deliverWake(a: Agent, waiter: Waiter) {
    const wakes = this.pendingWakes(a);
    const unread = this.unread(a.team, a.name);
    this.db.prepare("UPDATE wakes SET delivered_at=?, method=COALESCE(method,'on_call') WHERE team=? AND to_agent=? AND delivered_at IS NULL")
      .run(now(), a.team, a.name);
    // only the user in person resets the autonomy budget; the lead acting for them does not
    if (wakes.some((w) => w.from_agent === HUMAN && !w.via)) this.db.prepare("UPDATE agents SET auto_turns=0 WHERE team=? AND name=?").run(a.team, a.name);
    else this.db.prepare("UPDATE agents SET auto_turns=auto_turns+1 WHERE team=? AND name=?").run(a.team, a.name);
    const who = [...new Set(wakes.map((w) => this.senderLabel(w)))].join(", ") || "a teammate";
    const reasons = wakes.map((w) => `- ${this.senderLabel(w)}: "${oneLine(w.reason, 160)}"`).join("\n");
    this.waiters.delete(a.session_id!);
    this.setStatus(a, "working");
    waiter.resolve(`[gang] You were woken by ${who} via the gang hub (set up by the user).\n${reasons}\n` +
      `You have ${unread.length} unread message(s): call the gang \`inbox\` tool, act on them as appropriate, then stop when done.`);
  }

  /** Stop hook long-poll. Resolves with continuation text, or null to let the agent stop. */
  stopWait(sid: string, timeoutMs: number, onCancel: (cb: () => void) => void): Promise<string | null> {
    const a = this.agentBySession(sid);
    if (!a) return Promise.resolve(null);
    this.clearApproval(a);
    if (this.holdReason(a.team) && !this.pendingWakes(a).some((w) => w.from_agent === HUMAN)) { this.setStatus(a, "asleep"); return Promise.resolve(null); }
    const prev = this.waiters.get(sid);
    if (prev) { this.waiters.delete(sid); prev.resolve(null); }
    return new Promise((resolve) => {
      let done = false;
      const finish = (text: string | null) => { if (!done) { done = true; clearTimeout(timer); resolve(text); } };
      const waiter: Waiter = { team: a.team, name: a.name, resolve: finish };
      const timer = setTimeout(() => {
        if (this.waiters.get(sid) === waiter) {
          this.waiters.delete(sid);
          const cur = this.agentBySession(sid);
          if (cur) { this.setStatus(cur, "asleep"); this.activity(cur.team, "status", cur.name, null, "on-call window ended, now asleep"); }
        }
        finish(null);
      }, timeoutMs);
      onCancel(() => {
        if (this.waiters.get(sid) === waiter) {
          this.waiters.delete(sid);
          const cur = this.agentBySession(sid);
          if (cur && cur.status === "on_call") this.setStatus(cur, "asleep");
        }
        finish(null);
      });
      this.waiters.set(sid, waiter);
      if (this.pendingWakes(a).length) {
        if (this.unread(a.team, a.name).length) return this.deliverWake(a, waiter);
        this.db.prepare("UPDATE wakes SET delivered_at=?, method='read' WHERE team=? AND to_agent=? AND delivered_at IS NULL")
          .run(now(), a.team, a.name);
      }
      this.setStatus(a, "on_call");
    });
  }

  // ---------- tasks ----------
  tasks(team: string): (Task & { deps: number[]; blocked_by: number[] })[] {
    const all = this.db.prepare("SELECT * FROM tasks WHERE team=? ORDER BY id").all(team) as unknown as Task[];
    const byId = new Map(all.map((t) => [t.id, t]));
    return all.map((t) => {
      const deps: number[] = JSON.parse(t.depends_on);
      return { ...t, deps, blocked_by: deps.filter((d) => byId.get(d) && byId.get(d)!.status !== "done") };
    });
  }
  task(id: number) { return this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as Task | undefined; }

  addTask(team: string, by: string, p: { title: string; body?: string; owner?: string | null; depends_on?: number[] }) {
    if (!p.title?.trim()) throw new Error("title is required");
    if (p.owner && p.owner !== HUMAN && !this.agent(team, p.owner)) throw new Error(`no agent "${p.owner}"`);
    for (const d of p.depends_on ?? []) if (this.task(d)?.team !== team) throw new Error(`no task #${d} in this team`);
    const t = now();
    const r = this.db.prepare(`INSERT INTO tasks (team, title, body, status, owner, created_by, depends_on, created, updated)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(team, p.title.trim(), p.body ?? null, p.owner ? "in_progress" : "open", p.owner ?? null, by,
      JSON.stringify(p.depends_on ?? []), t, t);
    const id = Number(r.lastInsertRowid);
    this.activity(team, "task", by, p.owner ?? null, `created task #${id} “${p.title.trim()}”${p.owner ? ` for ${p.owner}` : ""}`, id);
    if (p.owner && p.owner !== by) this.send(team, by, p.owner, `Assigned you task #${id}: ${p.title}${p.body ? `\n${p.body}` : ""}`, "task", null);
    return this.tasks(team).find((x) => x.id === id)!;
  }

  updateTask(team: string, by: string, id: number, p: { status?: string; owner?: string | null; note?: string; claim?: boolean }) {
    const t = this.task(id);
    if (!t || t.team !== team) throw new Error(`no task #${id}`);
    if (p.status && !TASK_STATUSES.includes(p.status)) throw new Error(`status must be one of ${TASK_STATUSES.join(", ")}`);
    let owner = t.owner;
    if (p.claim) owner = by;
    if (p.owner !== undefined) {
      if (p.owner && p.owner !== HUMAN && !this.agent(team, p.owner)) throw new Error(`no agent "${p.owner}"`);
      owner = p.owner;
    }
    const status = p.status ?? (p.claim && t.status === "open" ? "in_progress" : t.status);
    const notes = JSON.parse(t.notes);
    if (p.note) notes.push({ by, at: now(), text: p.note });
    this.db.prepare("UPDATE tasks SET status=?, owner=?, notes=?, updated=? WHERE id=?").run(status, owner, JSON.stringify(notes), now(), id);
    const changes = [status !== t.status && `moved it to ${status.replace("_", " ")}`, owner !== t.owner && (owner ? `assigned it to ${owner === by ? "themselves" : owner}` : "unassigned it"),
      p.note && `noted “${oneLine(p.note, 120)}”`].filter(Boolean).join(", ");
    this.activity(team, "task", by, owner, `updated task #${id} “${t.title}”: ${changes || "no change"}`, id);
    if (owner && owner !== t.owner && owner !== by) this.send(team, by, owner, `Assigned you task #${id}: ${t.title}`, "task");
    if (status === "done" && t.status !== "done") {
      if (t.created_by !== by && t.created_by !== HUB) this.send(team, by, t.created_by, `Task #${id} done: ${t.title}${p.note ? `\n${p.note}` : ""}`, "task");
      for (const dep of this.tasks(team)) {
        if (dep.deps.includes(id) && dep.blocked_by.length === 0 && dep.status !== "done" && dep.status !== "cancelled") {
          const who = dep.owner ?? dep.created_by;
          if (who !== by) this.send(team, HUB, who, `Task #${dep.id} "${dep.title}" is unblocked (#${id} is done).`, "task");
        }
      }
    }
    return this.tasks(team).find((x) => x.id === id)!;
  }

  // ---------- decisions ----------
  decisions(team: string, all = false): Decision[] {
    return this.db.prepare(`SELECT * FROM decisions WHERE team=? ${all ? "" : "AND status='active'"} ORDER BY id`).all(team) as unknown as Decision[];
  }
  decide(team: string, by: string, title: string, body: string, supersedes: number | null = null): Decision {
    if (!title?.trim()) throw new Error("title is required");
    if (supersedes) {
      const old = this.db.prepare("SELECT * FROM decisions WHERE id=? AND team=?").get(supersedes, team);
      if (!old) throw new Error(`no decision #${supersedes}`);
      this.db.prepare("UPDATE decisions SET status='superseded' WHERE id=?").run(supersedes);
    }
    const r = this.db.prepare("INSERT INTO decisions (team, title, body, decided_by, supersedes, created) VALUES (?,?,?,?,?,?)")
      .run(team, title.trim(), body ?? "", by, supersedes, now());
    const id = Number(r.lastInsertRowid);
    this.send(team, by, "*", `Decision #${id}: ${title}${body ? `\n${body}` : ""}${supersedes ? `\n(supersedes #${supersedes})` : ""}`, "decision");
    this.activity(team, "decision", by, null, `${title}${body ? ` — ${body}` : ""}`, id);
    return this.db.prepare("SELECT * FROM decisions WHERE id=?").get(id) as unknown as Decision;
  }
  retractDecision(team: string, by: string, id: number) {
    const d = this.db.prepare("SELECT * FROM decisions WHERE id=? AND team=?").get(id, team) as Decision | undefined;
    if (!d) throw new Error(`no decision #${id}`);
    this.db.prepare("UPDATE decisions SET status='retracted' WHERE id=?").run(id);
    this.send(team, by, "*", `Decision #${id} "${d.title}" was retracted by ${by}.`, "decision");
    this.activity(team, "decision", by, null, `retracted decision #${id}: ${d.title}`, id);
  }

  // ---------- file claims ----------
  activeClaims(team: string): Claim[] {
    return this.db.prepare("SELECT * FROM claims WHERE team=? AND released IS NULL AND expires > ? ORDER BY id").all(team, now()) as unknown as Claim[];
  }
  claim(a: Agent, patterns: string[], opts: { minutes?: number; exclusive?: boolean; note?: string } = {}) {
    const base = a.cwd ?? "/";
    const abs = patterns.map((p) => (isAbsolute(p) ? p : resolve(base, p)));
    const others = this.activeClaims(a.team).filter((c) => c.agent !== a.name);
    const conflicts = [];
    const claimed = [];
    for (const p of abs) {
      const hit = others.find((c) => (c.exclusive || opts.exclusive !== false) && patternsOverlap(c.pattern, p));
      if (hit) { conflicts.push({ pattern: p, held_by: hit.agent, their_pattern: hit.pattern, note: hit.note, until: new Date(hit.expires).toISOString() }); continue; }
      this.db.prepare("UPDATE claims SET released=? WHERE team=? AND agent=? AND pattern=? AND released IS NULL").run(now(), a.team, a.name, p);
      this.db.prepare("INSERT INTO claims (team, agent, pattern, exclusive, note, created, expires) VALUES (?,?,?,?,?,?,?)")
        .run(a.team, a.name, p, opts.exclusive === false ? 0 : 1, opts.note ?? null, now(), now() + (opts.minutes ?? 120) * 60_000);
      claimed.push(p);
    }
    if (claimed.length) this.activity(a.team, "claim", a.name, null, `claimed ${claimed.map(short).join(", ")}${opts.note ? ` — ${opts.note}` : ""}`);
    return { claimed, conflicts };
  }
  release(a: Agent, patterns?: string[]) {
    const base = a.cwd ?? "/";
    const abs = patterns?.map((p) => (isAbsolute(p) ? p : resolve(base, p)));
    const mine = this.activeClaims(a.team).filter((c) => c.agent === a.name && (!abs || abs.includes(c.pattern)));
    for (const c of mine) this.db.prepare("UPDATE claims SET released=? WHERE id=?").run(now(), c.id);
    if (mine.length) this.activity(a.team, "claim", a.name, null, `released ${mine.map((c) => short(c.pattern)).join(", ")}`);
    return mine.length;
  }
  releaseClaim(team: string, id: number) {
    const c = this.db.prepare("SELECT * FROM claims WHERE id=? AND team=?").get(id, team) as Claim | undefined;
    if (!c) throw new Error(`no claim #${id}`);
    this.db.prepare("UPDATE claims SET released=? WHERE id=?").run(now(), id);
    this.activity(team, "claim", HUMAN, c.agent, `released ${c.agent}'s claim on ${short(c.pattern)}`);
  }
  /** Claims held by others that cover any of these absolute paths. */
  editConflicts(a: Agent, paths: string[]): Claim[] {
    const others = this.activeClaims(a.team).filter((c) => c.agent !== a.name && c.exclusive);
    return others.filter((c) => paths.some((p) => globMatch(c.pattern, p)));
  }

  /** Team context injected at session start / registration. */
  briefing(a: Agent): string {
    const decisions = this.decisions(a.team);
    const myTasks = this.tasks(a.team).filter((t) => t.owner === a.name && t.status !== "done" && t.status !== "cancelled");
    const claims = this.activeClaims(a.team).filter((c) => c.agent !== a.name);
    const mates = this.agents(a.team).filter((x) => x.name !== a.name);
    const team = this.team(a.team);
    const parts = [`[gang] You are ${a.name} (${a.role}) on team "${team?.name ?? a.team}".`];
    if (mates.length) parts.push(`Teammates: ${mates.map((m) => `${m.name} (${m.role}, ${m.status})`).join(", ")}.`);
    if (decisions.length) parts.push(`Team decisions in effect — follow these:\n${decisions.map((d) => `- #${d.id} ${d.title}${d.body ? `: ${oneLine(d.body, 160)}` : ""}`).join("\n")}`);
    if (myTasks.length) parts.push(`Your open tasks:\n${myTasks.map((t) => `- #${t.id} [${t.status}] ${t.title}${t.blocked_by.length ? ` (blocked by #${t.blocked_by.join(", #")})` : ""}`).join("\n")}`);
    if (claims.length) parts.push(`Files claimed by teammates (ask before editing):\n${claims.map((c) => `- ${short(c.pattern)} — ${c.agent}${c.note ? ` (${c.note})` : ""}`).join("\n")}`);
    const unread = this.unread(a.team, a.name).length;
    if (unread) parts.push(`You have ${unread} unread message(s); use \`inbox\`.`);
    return parts.join("\n");
  }

  // ---------- hooks ----------
  hookEvent(runtime: string, event: string, p: Record<string, any>): HookResult {
    const sid: string | undefined = p.session_id;
    if (!sid) return {};
    this.db.prepare(`INSERT INTO sessions (session_id, runtime, cwd, transcript_path, last_event, last_seen)
      VALUES (?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET cwd=COALESCE(excluded.cwd, cwd),
      transcript_path=COALESCE(excluded.transcript_path, transcript_path), last_event=excluded.last_event, last_seen=excluded.last_seen`)
      .run(sid, runtime, p.cwd ?? null, p.transcript_path ?? null, event, now());

    // The lead: bind on its register call, then give it a one-line notice when the user talks to it.
    if (event === "PostToolUse" && /gang.*lead$/.test(String(p.tool_name ?? "")) && p.tool_input?.action === "register") {
      const out = String(typeof p.tool_response === "string" ? p.tool_response : JSON.stringify(p.tool_response ?? ""));
      const id = out.match(/\\?"lead_id\\?":\s*\\?"([^"\\]+)/)?.[1];
      if (id && !this.agentBySession(sid)) this.bindLeadSession(id, sid, p.transcript_path ?? null);
    }
    const lead = this.leadSession(sid);
    if (lead) {
      this.db.prepare("UPDATE leads SET last_seen=?, transcript_path=COALESCE(?, transcript_path) WHERE id=?").run(now(), p.transcript_path ?? null, lead.id);
      if (event === "UserPromptSubmit" || event === "PostToolUse" || event === "SessionStart") { const w = this.leadWaiters.get(sid); if (w) { this.leadWaiters.delete(sid); w(null); } }
      if (lead.status === "approved" && (event === "UserPromptSubmit" || event === "SessionStart")) return { context: this.leadNotice(lead) };
      return {};
    }

    // Claude: bind the session when the agent calls our register tool.
    if (event === "PostToolUse" && /gang.*register$/.test(String(p.tool_name ?? "")) && p.tool_input?.name) {
      const out = String(typeof p.tool_response === "string" ? p.tool_response : JSON.stringify(p.tool_response ?? ""));
      const teamId = out.match(/\\?"team_id\\?":\s*\\?"([^"\\]+)/)?.[1];
      const cand = teamId ? this.agent(teamId, p.tool_input.name) : this.agents().find((x) => x.name === p.tool_input.name && !x.session_id);
      if (cand) this.bindSession(cand.team, cand.name, sid);
    }

    const a = this.agentBySession(sid);
    if (!a) return {};
    if (p.transcript_path && p.transcript_path !== a.transcript_path) {
      this.db.prepare("UPDATE agents SET transcript_path=?, meta_at=NULL WHERE team=? AND name=?").run(p.transcript_path, a.team, a.name);
      a.transcript_path = p.transcript_path; a.meta_at = null;
    }
    this.refreshMeta(a);
    if (event === "PermissionRequest") {
      this.setApproval(a, describeTool(p.tool_name, p.tool_input), p.tool_name ?? null);
      return {};
    }
    if (event === "Notification") {
      if (String(p.notification_type ?? p.message ?? "").match(/permission/i) && !a.approval) this.setApproval(a, String(p.message ?? "a permission prompt"), null);
      return {};
    }
    if (event === "PreToolUse") {
      const paths = editPaths(p.tool_name, p.tool_input, p.cwd ?? a.cwd ?? "/");
      const hits = paths.length ? this.editConflicts(a, paths) : [];
      if (!hits.length) return {};
      const c = hits[0];
      this.activity(a.team, "claim", a.name, c.agent, `was stopped from editing ${short(paths[0])} (claimed by ${c.agent})`);
      return { deny: `[gang] ${short(paths[0])} is claimed by teammate ${c.agent}${c.note ? ` (${c.note})` : ""} until ` +
        `${new Date(c.expires).toLocaleTimeString()}. Coordinate first: \`send\` ${c.agent} a message (or ask the user) and edit after they release it.` };
    }
    if (event === "PostToolUse" || event === "UserPromptSubmit" || event === "SessionStart" || event === "Stop") this.clearApproval(a);
    if (event === "UserPromptSubmit" && !String(p.prompt ?? "").includes("[gang]")) {
      this.db.prepare("UPDATE agents SET auto_turns=0 WHERE team=? AND name=?").run(a.team, a.name); // the user is back in the loop
    }
    if (event === "SessionStart") {
      const w = this.waiters.get(sid);
      if (w) { this.waiters.delete(sid); w.resolve(null); }
      this.setStatus(a, "working");
      return { context: this.briefing(a) };
    }
    if (event === "UserPromptSubmit" || event === "PostToolUse") {
      const w = this.waiters.get(sid);
      if (w) { this.waiters.delete(sid); w.resolve(null); }
      this.setStatus(a, "working");
      return { context: this.notice(a) };
    }
    return {};
  }

  // ---------- the lead (the user's own delegate agent) ----------
  leads(): Lead[] { return this.db.prepare("SELECT * FROM leads WHERE status != 'revoked' ORDER BY created").all() as unknown as Lead[]; }
  lead(id: string) { return this.db.prepare("SELECT * FROM leads WHERE id=?").get(id) as Lead | undefined; }
  activeLead() { return this.db.prepare("SELECT * FROM leads WHERE status='approved' ORDER BY approved DESC LIMIT 1").get() as Lead | undefined; }
  /** The lead bound to this session, unless the session is also a team agent (agent behavior always wins). */
  leadSession(sid: string | null | undefined) { return sid && !this.agentBySession(sid) ? this.leadBySession(sid) : undefined; }
  leadBySession(sid: string | null | undefined) {
    if (!sid) return undefined;
    return this.db.prepare("SELECT * FROM leads WHERE session_id=? AND status != 'revoked' ORDER BY (status='approved') DESC, created DESC LIMIT 1").get(sid) as Lead | undefined;
  }
  /** A session asks to be the user's lead. Stays pending until the user approves it (dashboard / CLI). */
  registerLead(p: { name: string; runtime: string; cwd: string; session_id?: string | null }): Lead {
    const existing = this.leadBySession(p.session_id);
    if (existing) {
      this.db.prepare("UPDATE leads SET name=?, last_seen=? WHERE id=?").run(p.name, now(), existing.id);
      return this.lead(existing.id)!;
    }
    const id = randomUUID();
    this.db.prepare(`INSERT INTO leads (id, name, runtime, session_id, cwd, status, created, last_seen) VALUES (?,?,?,?,?,'pending',?,?)`)
      .run(id, p.name, p.runtime, p.session_id ?? null, p.cwd, now(), now());
    this.notify("gang: a session wants to be your lead", `${p.name} (${p.runtime}) — approve it in the dashboard or with \`gang lead approve\``);
    return this.lead(id)!;
  }
  bindLeadSession(id: string, sid: string, transcript: string | null) {
    const l = this.lead(id);
    if (!l) return;
    const prev = this.db.prepare("SELECT * FROM leads WHERE session_id=? AND id != ? AND status='approved'").get(sid, id) as Lead | undefined;
    this.db.prepare("UPDATE leads SET session_id=?, transcript_path=COALESCE(?, transcript_path) WHERE id=?").run(sid, transcript, id);
    if (prev) { // same session re-registered (e.g. its MCP server restarted): keep its approval
      this.db.prepare("UPDATE leads SET status='approved', approved=?, seen_activity=?, seen_message=?, noticed_message=?, wake_on_needs=? WHERE id=?")
        .run(prev.approved, prev.seen_activity, prev.seen_message, prev.noticed_message, prev.wake_on_needs, id);
      this.db.prepare("UPDATE leads SET status='revoked' WHERE id=?").run(prev.id);
    }
  }
  approveLead(id: string) {
    const l = this.lead(id);
    if (!l) throw new Error("no such lead");
    if (l.status !== "pending") throw new Error(l.status === "approved" ? "that session is already your lead" : "that lead request was rejected or revoked; ask the session to register again");
    const maxA = (this.db.prepare("SELECT COALESCE(MAX(id),0) m FROM activity").get() as any).m;
    const maxM = (this.db.prepare("SELECT COALESCE(MAX(id),0) m FROM messages").get() as any).m;
    this.db.prepare("UPDATE leads SET status='revoked' WHERE status='approved' AND id != ?").run(id);
    this.db.prepare("UPDATE leads SET status='approved', approved=?, seen_activity=?, seen_message=?, noticed_message=? WHERE id=?").run(now(), maxA, maxM, maxM, id);
    return this.lead(id)!;
  }
  revokeLead(id: string) {
    this.db.prepare("UPDATE leads SET status='revoked' WHERE id=?").run(id);
    const l = this.lead(id);
    if (l?.session_id) { const w = this.leadWaiters.get(l.session_id); if (w) { this.leadWaiters.delete(l.session_id); w(null); } }
  }
  setLeadWake(id: string, on: boolean) { this.db.prepare("UPDATE leads SET wake_on_needs=? WHERE id=?").run(on ? 1 : 0, id); }

  /** Things that need the user right now, across all teams. */
  needsYou() {
    const approvals = (this.db.prepare("SELECT * FROM agents WHERE approval IS NOT NULL").all() as unknown as Agent[]).map((a) => ({ team: a.team, agent: a.name, app: a.app, session_title: a.title, ...JSON.parse(a.approval!) }));
    const unread = this.db.prepare(`SELECT m.* FROM messages m LEFT JOIN receipts r ON r.message_id=m.id AND r.agent='human'
      WHERE m.to_agent='human' AND r.read_at IS NULL ORDER BY m.id`).all() as unknown as Message[];
    return { approvals, unread };
  }
  /** One-line hint injected when the user talks to their lead. */
  leadNotice(lead: Lead): string | null {
    const l = { ...lead, last_noticed: this.leadNoticedAt.get(lead.id) ?? 0 };
    const { approvals, unread } = this.needsYou();
    const fresh = unread.filter((m) => m.id > l.noticed_message);
    const maxA = (this.db.prepare("SELECT COALESCE(MAX(id),0) m FROM activity").get() as any).m;
    // the lead's own actions (labeled via) aren't news to it
    const otherNew = (this.db.prepare("SELECT COUNT(*) n FROM activity WHERE id > ? AND via IS NULL").get(Math.max(l.seen_activity, l.noticed_activity)) as any).n;
    const newApprovals = approvals.filter((x) => x.at > l.last_noticed);
    if (!fresh.length && !newApprovals.length && otherNew <= 0) return null;
    const maxM = (this.db.prepare("SELECT COALESCE(MAX(id),0) m FROM messages").get() as any).m;
    this.db.prepare("UPDATE leads SET noticed_message=?, noticed_activity=? WHERE id=?").run(maxM, maxA, l.id);
    this.leadNoticedAt.set(l.id, now());
    const parts = [];
    if (fresh.length) parts.push(`${fresh.length} new for the user (${[...new Set(fresh.map((m) => `${m.from_agent}${m.kind !== "msg" ? ` ${m.kind}` : ""}`))].slice(0, 4).join(", ")})`);
    if (approvals.length) parts.push(`${approvals.length} approval(s) waiting (${approvals.map((a) => a.agent).join(", ")})`);
    if (otherNew > 0) parts.push(`${otherNew} team event(s) since your last brief`);
    return `[gang] Since your last look: ${parts.join("; ")}. Use the gang \`lead\` tool (action "brief") if it's relevant to what the user is asking.`;
  }
  /** Wake the lead (only if the user turned that on) when something needs the user. */
  pokeLead(text: string) {
    const l = this.activeLead();
    if (!l?.wake_on_needs || !l.session_id) return;
    const w = this.leadWaiters.get(l.session_id);
    if (!w) return;
    this.leadWaiters.delete(l.session_id);
    w(`[gang] Something needs the user: ${text}\nCall the gang \`lead\` tool with action "brief", then tell the user briefly in this chat.`);
  }
  leadStopWait(sid: string, timeoutMs: number, onCancel: (cb: () => void) => void): Promise<string | null> {
    const l = this.leadBySession(sid);
    if (!l || l.status !== "approved" || !l.wake_on_needs) return Promise.resolve(null);
    const prev = this.leadWaiters.get(sid);
    if (prev) { this.leadWaiters.delete(sid); prev(null); }
    return new Promise((resolve) => {
      let done = false;
      const finish = (t: string | null) => { if (!done) { done = true; clearTimeout(timer); resolve(t); } };
      const timer = setTimeout(() => { if (this.leadWaiters.get(sid) === finish) this.leadWaiters.delete(sid); finish(null); }, timeoutMs);
      onCancel(() => { if (this.leadWaiters.get(sid) === finish) this.leadWaiters.delete(sid); finish(null); });
      this.leadWaiters.set(sid, finish);
    });
  }

  // ---------- approvals ----------
  setApproval(a: Agent, detail: string, tool: string | null) {
    const at = now();
    this.db.prepare("UPDATE agents SET approval=? WHERE team=? AND name=?").run(JSON.stringify({ tool, detail, at }), a.team, a.name);
    a.approval = JSON.stringify({ tool, detail, at });
    this.setStatus(a, "waiting_permission");
    this.activity(a.team, "approval", a.name, null, `is waiting for your approval: ${detail}`);
    const nudge = this.settings(a.team).approval_nudge_s;
    if (nudge > 0) setTimeout(() => {
      const cur = this.agent(a.team, a.name);
      if (!cur?.approval || JSON.parse(cur.approval).at !== at) return;
      const app = cur.app ?? cur.runtime;
      this.db.prepare(`INSERT INTO messages (team, from_agent, to_agent, kind, body, created) VALUES (?,?,?,?,?,?)`)
        .run(a.team, a.name, HUMAN, "approval", `Waiting ${nudge}s+ for your approval in ${app}${cur.title ? ` (“${cur.title}”)` : ""}: ${detail}`, now());
      this.notify(`gang: ${a.name} needs your approval`, `${detail.slice(0, 120)} — open it in ${app}`);
      this.pokeLead(`${a.name} (team ${a.team}) has waited ${nudge}s for the user's approval: ${detail}`);
    }, nudge * 1000).unref?.();
  }
  clearApproval(a: Agent) {
    if (!a.approval) return;
    this.db.prepare("UPDATE agents SET approval=NULL WHERE team=? AND name=?").run(a.team, a.name);
    a.approval = null;
  }

  // ---------- status ----------
  postStatus(a: Agent, text: string) {
    this.db.prepare("UPDATE agents SET status_text=?, last_seen=? WHERE team=? AND name=?").run(text, now(), a.team, a.name);
    this.activity(a.team, "status", a.name, null, text);
  }
}

// ---------- helpers ----------
export function inWindow(start: string, end: string, d: Date): boolean {
  const m = (t: string) => { const [h, mi] = t.split(":").map(Number); return h * 60 + mi; };
  const cur = d.getHours() * 60 + d.getMinutes(), s = m(start), e = m(end);
  return s <= e ? cur >= s && cur < e : cur >= s || cur < e;
}
/** One-line, human-readable description of a tool call awaiting approval. */
export function describeTool(tool: string | undefined, input: any): string {
  if (!tool) return "a tool call";
  const i = input ?? {};
  const raw = typeof i === "string" ? i : JSON.stringify(i);
  const patched = [...raw.matchAll(/\*\*\* (?:Add|Update|Delete) File: (.+?)(?=\\n|\n|"|$)/g)].map((m) => m[1].trim());
  if (patched.length) return `apply a patch to ${patched.slice(0, 4).join(", ")}${patched.length > 4 ? "…" : ""}`;
  if (tool === "Bash" || (typeof i.command === "string") || typeof i.cmd === "string")
    return `run \`${oneLine(String(i.command ?? i.cmd ?? ""), 160)}\``;
  if (i.file_path) return `${tool === "Write" ? "write" : "edit"} ${String(i.file_path).replace(process.env.HOME ?? "~", "~")}`;
  if (tool.startsWith("mcp__")) return `use ${tool.replace(/^mcp__/, "").replace("__", ": ")} ${oneLine(JSON.stringify(i), 100)}`;
  if (i.url) return `${tool} ${i.url}`;
  return `${tool} ${oneLine(JSON.stringify(i), 120)}`;
}
const expandHome = (f: string) => f.trim().replace(/^~(?=\/|$)/, homedir()).replace(/\/+$/, "");
export function oneLine(s: string, n: number) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}
const short = (p: string) => p.replace(process.env.HOME ?? "~", "~");

function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
/** A claim pattern matches a path exactly, as a directory prefix, or as a glob. */
export function globMatch(pattern: string, path: string): boolean {
  if (/[*?]/.test(pattern)) return globToRegex(pattern).test(path);
  const dir = pattern.replace(/\/+$/, "");
  return path === dir || path.startsWith(dir + "/");
}
function patternsOverlap(a: string, b: string) {
  const lit = (p: string) => p.split(/[*?]/)[0].replace(/\/+$/, "");
  return globMatch(a, b) || globMatch(b, a) || lit(a).startsWith(lit(b)) || lit(b).startsWith(lit(a));
}
/** File paths an edit-type tool call would touch (Claude Edit/Write/MultiEdit/NotebookEdit, Codex apply_patch). */
export function editPaths(tool: string, input: any, cwd: string): string[] {
  const out = new Set<string>();
  const add = (p: string) => out.add(isAbsolute(p) ? p : resolve(cwd, p));
  if (input?.file_path) add(input.file_path);
  if (input?.notebook_path) add(input.notebook_path);
  const text = typeof input === "string" ? input : JSON.stringify(input ?? "");
  for (const m of text.matchAll(/\*\*\* (?:Add|Update|Delete) File: ([^\n"\\]+)/g)) add(m[1].trim());
  for (const m of text.matchAll(/\*\*\* Move to: ([^\n"\\]+)/g)) add(m[1].trim());
  return [...out];
}

export function macNotify(title: string, body: string) {
  if (process.platform !== "darwin" || process.env.GANG_NO_NOTIFY) return;
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  execFile("osascript", ["-e", `display notification "${esc(body)}" with title "${esc(title)}"`], () => {});
}
