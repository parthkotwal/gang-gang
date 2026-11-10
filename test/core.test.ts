import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.GANG_HOME = mkdtempSync(join(tmpdir(), "gang-test-"));
const { Core, globMatch, editPaths, inWindow, describeTool } = await import("../src/core.ts");
const { Jobs } = await import("../src/jobs.ts");
const { openDb } = await import("../src/db.ts");
const pathsMod = await import("../src/paths.ts");
assert.ok(pathsMod.JOBS_DIR.startsWith(process.env.GANG_HOME!), "tests must not touch the real ~/.gang");

const noMeta = () => null;
function setup() {
  const notes: string[] = [];
  const core = new Core(openDb(join(process.env.GANG_HOME!, `t${Math.random()}.db`)), { notify: (t, b) => notes.push(`${t}|${b}`), metaReader: noMeta });
  const team = core.createTeam("Bench", ["/repo", "/data/bench"]);
  const T = team.id;
  core.register({ team: T, name: "planner", role: "planner", runtime: "claude", cwd: "/repo", session_id: "s-plan" });
  core.register({ team: T, name: "impl", role: "implementer", runtime: "codex", cwd: "/repo", session_id: "s-impl" });
  return { core, T, notes };
}
const never = () => {};

test("teams: multi-folder, lookup by name, resolve by folder", () => {
  const { core, T } = setup();
  assert.equal(core.team("bench")!.id, T);
  assert.deepEqual(core.teamsForPath("/data/bench/runs/1").map((t) => t.id), [T]);
  assert.equal(core.resolveTeam(null, "/data/bench/x").id, T);
  assert.equal(core.resolveTeam("Bench", "/elsewhere").id, T);
  assert.throws(() => core.createTeam("bench", []), /already exists/);
  core.createTeam("Other", ["/repo"]);
  assert.throws(() => core.resolveTeam(null, "/repo/src"), /several teams/);
  const auto = core.resolveTeam(null, process.cwd());
  assert.equal(auto.source, "auto");
});

test("messages: notice once, inbox marks read, broadcast excludes sender", () => {
  const { core, T } = setup();
  core.send(T, "planner", "impl", "can you check the loader?", "question");
  core.send(T, "planner", "*", "baseline is 71.2%", "finding");
  const impl = core.agent(T, "impl")!;
  assert.match(core.notice(impl)!, /2 unread/);
  assert.equal(core.notice(impl), null, "already notified");
  assert.equal(core.unread(T, "planner").length, 0);
  assert.equal(core.inbox(T, "impl").length, 2);
  assert.throws(() => core.send(T, "planner", "nobody", "x"), /no agent/);
});

test("hook events: unregistered sessions ignored; SessionStart gives a briefing", () => {
  const { core, T } = setup();
  assert.deepEqual(core.hookEvent("codex", "PostToolUse", { session_id: "hidden-helper", cwd: "/repo" }), {});
  core.decide(T, "planner", "Use seeds 1-3 for every run", "and report mean ± std");
  const r = core.hookEvent("codex", "SessionStart", { session_id: "s-impl", cwd: "/repo", transcript_path: "/t.jsonl" });
  assert.match(r.context!, /team "Bench"[\s\S]*Use seeds 1-3/);
  assert.equal(core.agent(T, "impl")!.transcript_path, "/t.jsonl");
});

test("claude session binds via PostToolUse of register (team_id in tool response)", () => {
  const { core, T } = setup();
  core.register({ team: T, name: "rev", role: "reviewer", runtime: "claude", cwd: "/repo" });
  core.hookEvent("claude", "PostToolUse", { session_id: "s-rev", cwd: "/repo", tool_name: "mcp__gang__register",
    tool_input: { name: "rev", team: "Bench" }, tool_response: [{ type: "text", text: JSON.stringify({ registered: "rev", team_id: T }) }] });
  assert.equal(core.agentBySession("s-rev")?.name, "rev");
});

test("wakes: on-call release, pending until stop, notify when asleep, rate limit", async () => {
  const { core, T, notes } = setup();
  const p = core.stopWait("s-impl", 5000, never);
  assert.equal(core.agent(T, "impl")!.status, "on_call");
  assert.equal(core.wake(T, "planner", "impl", "loader fixed").method, "on_call");
  assert.match((await p)!, /woken by planner/);

  core.hookEvent("codex", "PostToolUse", { session_id: "s-impl", cwd: "/repo" });
  assert.equal(core.wake(T, "planner", "impl", "urgent").method, "pending");
  assert.match((await core.stopWait("s-impl", 5000, never))!, /urgent/);

  core.setStatus(core.agent(T, "impl")!, "asleep");
  assert.equal(core.wake(T, "planner", "impl", "3").method, "notified");
  assert.equal(notes.length, 1);
  core.wake(T, "planner", "impl", "4");
  assert.equal(core.wake(T, "planner", "impl", "5").method, "rate_limited");
  assert.notEqual(core.wake(T, "human", "impl", "6").method, "rate_limited", "human is exempt");
  const kinds = (core.db.prepare("SELECT kind FROM activity WHERE team=?").all(T) as any[]).map((r) => r.kind);
  assert.ok(kinds.includes("wake") && kinds.includes("wake_limited"));
});

test("stop waits: replaced, cancelled → asleep, unregistered → immediate", async () => {
  const { core, T } = setup();
  const first = core.stopWait("s-plan", 5000, never);
  let cancel = () => {};
  const second = core.stopWait("s-plan", 5000, (cb) => (cancel = cb));
  assert.equal(await first, null);
  cancel();
  assert.equal(await second, null);
  assert.equal(core.agent(T, "planner")!.status, "asleep");
  assert.equal(await core.stopWait("nope", 5000, never), null);
});

test("tasks: assign notifies owner; done notifies creator and unblocks dependents", () => {
  const { core, T } = setup();
  const a = core.addTask(T, "planner", { title: "fix truncation", owner: "impl" });
  const b = core.addTask(T, "planner", { title: "run 8k sweep", depends_on: [a.id] });
  assert.equal(a.status, "in_progress");
  assert.deepEqual(core.tasks(T).find((t) => t.id === b.id)!.blocked_by, [a.id]);
  assert.match(core.inbox(T, "impl")[0].body, /Assigned you task #\d+: fix truncation/);
  core.updateTask(T, "impl", a.id, { status: "done", note: "load_prompt no longer truncates" });
  const planner = core.inbox(T, "planner").map((m) => m.body).join("\n");
  assert.match(planner, /Task #\d+ done: fix truncation/);
  assert.match(planner, /"run 8k sweep" is unblocked/);
  assert.deepEqual(core.tasks(T).find((t) => t.id === b.id)!.blocked_by, []);
  core.updateTask(T, "impl", b.id, { claim: true });
  assert.equal(core.task(b.id)!.owner, "impl");
  assert.throws(() => core.updateTask(T, "impl", b.id, { status: "nope" }), /status must be/);
});

test("decisions: broadcast, supersede, retract", () => {
  const { core, T } = setup();
  const d1 = core.decide(T, "planner", "ctx 4096", "");
  const d2 = core.decide(T, "planner", "ctx 8192", "for the sweep", d1.id);
  assert.deepEqual(core.decisions(T).map((d) => d.id), [d2.id]);
  assert.match(core.inbox(T, "impl").at(-1)!.body, /supersedes #/);
  core.retractDecision(T, "human", d2.id);
  assert.equal(core.decisions(T).length, 0);
});

test("claims: conflicts, PreToolUse deny for Claude Edit and Codex apply_patch, release", () => {
  const { core, T } = setup();
  const impl = core.agent(T, "impl")!;
  const planner = core.agent(T, "planner")!;
  const r = core.claim(impl, ["eval/**", "config.py"], { note: "fixing truncation" });
  assert.equal(r.claimed.length, 2);
  assert.equal(core.claim(planner, ["eval/harness.py"]).conflicts[0].held_by, "impl");
  const deny = core.hookEvent("claude", "PreToolUse", { session_id: "s-plan", cwd: "/repo", tool_name: "Edit", tool_input: { file_path: "/repo/eval/harness.py" } });
  assert.match(deny.deny!, /claimed by teammate impl \(fixing truncation\)/);
  const patch = "*** Begin Patch\n*** Update File: config.py\n@@\n-A\n+B\n*** End Patch";
  assert.ok(core.hookEvent("codex", "PreToolUse", { session_id: "s-plan", cwd: "/repo", tool_name: "apply_patch", tool_input: { command: patch } }).deny);
  assert.deepEqual(core.hookEvent("codex", "PreToolUse", { session_id: "s-impl", cwd: "/repo", tool_name: "apply_patch", tool_input: { command: patch } }), {}, "own claim is fine");
  assert.equal(core.release(impl), 2);
  assert.deepEqual(core.hookEvent("claude", "PreToolUse", { session_id: "s-plan", cwd: "/repo", tool_name: "Edit", tool_input: { file_path: "/repo/eval/harness.py" } }), {});
});

test("glob + edit path helpers", () => {
  assert.ok(globMatch("/r/src/**", "/r/src/a/b.ts"));
  assert.ok(globMatch("/r/src/*.ts", "/r/src/a.ts"));
  assert.ok(!globMatch("/r/src/*.ts", "/r/src/a/b.ts"));
  assert.ok(globMatch("/r/src", "/r/src/x.py"));
  assert.ok(!globMatch("/r/src", "/r/srcx/x.py"));
  assert.deepEqual(editPaths("apply_patch", "*** Add File: a/b.py\n*** Delete File: c.py", "/r"), ["/r/a/b.py", "/r/c.py"]);
});

test("migration from v1 (project column) creates teams", () => {
  const path = join(process.env.GANG_HOME!, "v1.db");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE agents (project TEXT, name TEXT, role TEXT, runtime TEXT, session_id TEXT, transcript_path TEXT, cwd TEXT, status TEXT, status_text TEXT, last_seen INTEGER, created INTEGER, PRIMARY KEY (project, name));
    CREATE TABLE messages (id INTEGER PRIMARY KEY, project TEXT, from_agent TEXT, to_agent TEXT, kind TEXT, body TEXT, thread_id INTEGER, created INTEGER);
    CREATE TABLE wakes (id INTEGER PRIMARY KEY, project TEXT, from_agent TEXT, to_agent TEXT, reason TEXT, created INTEGER, delivered_at INTEGER, method TEXT, exempt INTEGER);
    CREATE TABLE jobs (id INTEGER PRIMARY KEY, project TEXT, owner TEXT, name TEXT, cmd TEXT, cwd TEXT, pid INTEGER, status TEXT, exit_code INTEGER, log_path TEXT, progress TEXT, notify TEXT, started INTEGER, ended INTEGER);
    CREATE TABLE activity (id INTEGER PRIMARY KEY, project TEXT, ts INTEGER, kind TEXT, actor TEXT, target TEXT, text TEXT);
    INSERT INTO agents VALUES ('/Users/x/gang-test','impl-1','implementer','codex','sid',NULL,'/Users/x/gang-test','asleep',NULL,1,1);`);
  old.close();
  const core = new Core(openDb(path), { metaReader: noMeta });
  const t = core.teams()[0];
  assert.equal(t.name, "gang-test");
  assert.deepEqual(t.folderList, ["/Users/x/gang-test"]);
  assert.equal(core.agentBySession("sid")!.team, t.id);
});

test("jobs: run, progress, finish wakes owner (exempt from limit); bad cwd rejected; kill", async () => {
  const { core, T } = setup();
  const jobs = new Jobs(core);
  for (let i = 0; i < 6; i++) core.db.prepare("INSERT INTO wakes (team, from_agent, to_agent, reason, created, exempt) VALUES (?,?,?,?,?,0)").run(T, "x", "impl", "r", Date.now());
  const waiting = core.stopWait("s-impl", 10_000, never);
  const j = jobs.start({ team: T, owner: "impl", name: "eval", cmd: "echo step 3/10; sleep 0.3; echo done; exit 3", cwd: process.cwd(), env: { PATH: process.env.PATH! } });
  for (let i = 0; i < 40 && jobs.get(j.id)!.status === "running"; i++) { await new Promise((r) => setTimeout(r, 100)); jobs.poll(); }
  assert.equal(jobs.get(j.id)!.status, "failed");
  assert.match((await waiting)!, /woken by gang/);
  assert.match(core.inbox(T, "impl").at(-1)!.body, /Job #\d+ "eval" failed \(exit 3\)[\s\S]*done/);
  assert.throws(() => jobs.start({ team: T, owner: "impl", cmd: "true", cwd: "/definitely/not/here" }), /does not exist/);
  const k = jobs.start({ team: T, owner: "planner", cmd: "sleep 30", cwd: process.cwd(), notify: "message", env: { PATH: process.env.PATH! } });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(jobs.kill(k.id));
  for (let i = 0; i < 30 && jobs.get(k.id)!.status === "running"; i++) { await new Promise((r) => setTimeout(r, 100)); jobs.poll(); }
  assert.equal(jobs.get(k.id)!.status, "killed");
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("guardrails: pause holds agent wakes and on-call; the user's own wakes still go through", async () => {
  const { core, T } = setup();
  const waiting = core.stopWait("s-impl", 5000, never);
  core.updateSettings(T, { paused: true });
  assert.equal(await waiting, null, "pausing releases agents that were on call");
  assert.equal(core.wake(T, "planner", "impl", "go").method, "held");
  assert.equal(await core.stopWait("s-impl", 5000, never), null, "no on-call while paused");
  assert.equal(core.agent(T, "impl")!.status, "asleep");
  assert.notEqual(core.wake(T, "human", "impl", "you go").method, "held");
  core.updateSettings(T, { paused: false });
  assert.equal(core.holdReason(T), null);
});

test("guardrails: quiet hours window math (incl. overnight)", () => {
  const at = (h: number, m = 0) => new Date(2026, 0, 1, h, m);
  assert.ok(inWindow("23:00", "08:00", at(2)));
  assert.ok(inWindow("23:00", "08:00", at(23, 30)));
  assert.ok(!inWindow("23:00", "08:00", at(12)));
  assert.ok(inWindow("09:00", "17:00", at(12)));
  assert.ok(!inWindow("09:00", "17:00", at(17)));
});

test("guardrails: autonomy budget holds wakes until the user talks to the agent", async () => {
  const { core, T } = setup();
  core.updateSettings(T, { autonomy_budget: 2 });
  for (let i = 0; i < 2; i++) {
    const p = core.stopWait("s-impl", 5000, never);
    assert.equal(core.wake(T, i ? "gang" : "planner", "impl", `w${i}`, { exempt: i === 1 }).method, "on_call");
    await p;
  }
  assert.equal(core.agent(T, "impl")!.auto_turns, 2);
  const r = core.wake(T, "planner", "impl", "again");
  assert.equal(r.method, "budget");
  assert.ok(core.unread(T, "human").some((m) => m.kind === "guardrail" && /autonomy budget/.test(m.body)));
  core.hookEvent("codex", "UserPromptSubmit", { session_id: "s-impl", cwd: "/repo", prompt: "[gang] You were woken…" });
  assert.equal(core.agent(T, "impl")!.auto_turns, 2, "hub continuations don't count as the user");
  core.hookEvent("codex", "UserPromptSubmit", { session_id: "s-impl", cwd: "/repo", prompt: "keep going on the sweep" });
  assert.equal(core.agent(T, "impl")!.auto_turns, 0);
});

test("guardrails: ping-pong, per-sender and message limits", () => {
  const { core, T } = setup();
  core.register({ team: T, name: "rev", role: "reviewer", runtime: "claude", cwd: "/repo", session_id: "s-rev" });
  core.updateSettings(T, { ping_pong_limit: 2, wake_limit_per_sender: 3, message_limit: 5 });
  core.wake(T, "planner", "impl", "a"); core.wake(T, "impl", "planner", "b");
  core.wake(T, "planner", "impl", "c"); core.wake(T, "impl", "planner", "d");
  assert.equal(core.wake(T, "planner", "impl", "e").method, "ping_pong");
  assert.ok(core.unread(T, "human").some((m) => /keep waking|woken each other/.test(m.body)));
  assert.equal(core.wake(T, "planner", "rev", "f").method, "pending", "held wakes don't count; this is planner's 3rd");
  assert.equal(core.wake(T, "planner", "rev", "g").method, "rate_limited", "planner already sent 3 this hour");
  assert.throws(() => { for (let i = 0; i < 10; i++) core.send(T, "rev", "planner", `spam ${i}`); }, /Message limit/);
});

test("approvals: PermissionRequest shows what's pending, nudges the user, clears on next action", async () => {
  const { core, T, notes } = setup();
  core.updateSettings(T, { approval_nudge_s: 0.05 as any });
  core.hookEvent("claude", "PermissionRequest", { session_id: "s-plan", cwd: "/repo", tool_name: "Bash", tool_input: { command: "rm -rf build && make" } });
  const a = core.agent(T, "planner")!;
  assert.equal(a.status, "waiting_permission");
  assert.match(JSON.parse(a.approval!).detail, /run `rm -rf build && make`/);
  await sleep(120);
  assert.ok(core.unread(T, "human").some((m) => m.kind === "approval" && /rm -rf build/.test(m.body)));
  assert.ok(notes.some((n) => /needs your approval/.test(n)));
  core.hookEvent("claude", "PostToolUse", { session_id: "s-plan", cwd: "/repo", tool_name: "Bash" });
  assert.equal(core.agent(T, "planner")!.approval, null);
  assert.equal(core.agent(T, "planner")!.status, "working");
  assert.match(describeTool("apply_patch", { command: "*** Update File: a.py\n*** Add File: b.py" }), /patch to a.py, b.py/);
  assert.match(describeTool("mcp__github__create_pr", { title: "x" }), /github: create_pr/);
});

test("guardrails: max running jobs", () => {
  const { core, T } = setup();
  core.updateSettings(T, { max_running_jobs: 1 });
  const jobs = new Jobs(core);
  const j = jobs.start({ team: T, owner: "impl", cmd: "sleep 5", cwd: process.cwd(), env: { PATH: process.env.PATH! } });
  assert.throws(() => jobs.start({ team: T, owner: "impl", cmd: "true", cwd: process.cwd() }), /limit 1/);
  jobs.kill(j.id);
});

const { leadAction } = await import("../src/lead.ts");
function leadSetup() {
  const ctx = setup();
  const jobs = new Jobs(ctx.core);
  const l = ctx.core.registerLead({ name: "lead", runtime: "claude", cwd: "/", session_id: "s-lead" });
  const deps = { inspectAgent: () => ({ events: [] }), joinPrompt: (p: any) => `join ${p.team} as ${p.name}` };
  const run = (action: string, a: any = {}) => leadAction(ctx.core, jobs, deps, ctx.core.lead(l.id)!, action, a);
  return { ...ctx, l, run };
}

test("lead: pending until approved; one approved lead at a time; re-register keeps approval", () => {
  const { core, l } = leadSetup();
  assert.equal(l.status, "pending");
  core.approveLead(l.id);
  assert.equal(core.activeLead()!.id, l.id);
  const l2 = core.registerLead({ name: "lead2", runtime: "codex", cwd: "/", session_id: "s-lead2" });
  core.approveLead(l2.id);
  assert.equal(core.lead(l.id)!.status, "revoked");
  // same session registers again without a session id (Claude), then the hook binds it → approval carries over
  const again = core.registerLead({ name: "lead2", runtime: "codex", cwd: "/" });
  core.bindLeadSession(again.id, "s-lead2", null);
  assert.equal(core.lead(again.id)!.status, "approved");
  assert.equal(core.lead(l2.id)!.status, "revoked");
});

test("lead: acts as the user, labeled via lead; agents see the label; budget not reset by lead", async () => {
  const { core, T, l, run } = leadSetup();
  core.approveLead(l.id);
  run("send", { to: "impl", body: "please prioritise the 8k sweep" });
  const m = core.inbox(T, "impl").at(-1)!;
  assert.equal(m.from_agent, "human");
  assert.equal((m as any).via, "lead");
  assert.match(core.senderLabel(m as any), /the user \(via their lead lead\)/);
  const act = core.db.prepare("SELECT * FROM activity WHERE team=? AND kind='message' ORDER BY id DESC LIMIT 1").get(T) as any;
  assert.equal(act.via, "lead");
  // lead wakes increment the autonomy budget and are held when it's spent
  core.updateSettings(T, { autonomy_budget: 1 });
  const p = core.stopWait("s-impl", 5000, never);
  run("wake", { to: "impl", reason: "go" });
  assert.match((await p)!, /the user \(via their lead lead\)/);
  assert.equal(core.agent(T, "impl")!.auto_turns, 1);
  assert.equal(run("wake", { to: "impl", reason: "again" }).method, "budget");
  assert.equal(core.via, null, "via label is cleared after acting");
});

test("lead: brief shows what needs the user and only deltas", () => {
  const { core, T, l, run } = leadSetup();
  core.approveLead(l.id);
  core.send(T, "impl", "human", "should I use 8192 for all seeds?", "question");
  core.send(T, "impl", "*", "loader leak inflates acc by 0.8pt", "finding");
  core.hookEvent("claude", "PermissionRequest", { session_id: "s-plan", cwd: "/repo", tool_name: "Bash", tool_input: { command: "make clean" } });
  const b = run("brief");
  assert.match(b.needs_user.messages[0], /impl → user \[question\].*8192/);
  assert.match(b.needs_user.approvals[0], /planner .*run `make clean`/);
  assert.match(b.teams[0].new_since_last_brief.findings[0], /leak/);
  const b2 = run("brief");
  assert.equal(b2.teams[0].new_since_last_brief, undefined, "nothing new the second time");
  assert.equal(b2.needs_user.messages.length, 1, "still unread → still needs the user");
  run("reply", { id: core.unread(T, "human")[0].id, body: "yes, 8192" });
  assert.equal(core.needsYou().unread.length, 0);
  assert.match(core.inbox(T, "impl").at(-1)!.body, /yes, 8192/);
});

test("lead: notice on the user's turn; optional wake when something needs the user", async () => {
  const { core, T, l } = leadSetup();
  core.approveLead(l.id);
  core.send(T, "impl", "human", "done with the loader fix");
  const r = core.hookEvent("claude", "UserPromptSubmit", { session_id: "s-lead", prompt: "what's up?" });
  assert.match(r.context!, /1 new for the user \(impl\)/);
  assert.equal(core.hookEvent("claude", "UserPromptSubmit", { session_id: "s-lead", prompt: "and now?" }).context ?? null, null);
  assert.equal(await core.leadStopWait("s-lead", 1000, never), null, "wake is off by default");
  core.setLeadWake(l.id, true);
  const w = core.leadStopWait("s-lead", 5000, never);
  core.send(T, "planner", "human", "need a decision on seeds", "question");
  assert.match((await w)!, /planner sent the user a question/);
});

test("lead: unapproved or non-lead callers are refused by the server rpc", async () => {
  const { createHub } = await import("../src/server.ts");
  const hub = createHub({ dbPath: join(process.env.GANG_HOME!, `rpc${Math.random()}.db`), notify: () => {}, metaReader: noMeta });
  const reg = hub.rpc("lead", { action: "register", name: "lead" }, { runtime: "codex", cwd: "/", session_id: "L1" });
  assert.equal(reg.status, "pending");
  assert.throws(() => hub.rpc("lead", { action: "brief" }, { session_id: "L1" }), /Waiting for the user to approve/);
  assert.throws(() => hub.rpc("lead", { action: "brief" }, { session_id: "someone-else" }), /isn't the user's lead/);
  hub.core.approveLead(reg.lead_id);
  assert.ok(hub.rpc("lead", { action: "brief" }, { session_id: "L1" }).needs_user);
  assert.match(hub.rpc("lead", { action: "help" }, {}), /gang lead tool/);
});
