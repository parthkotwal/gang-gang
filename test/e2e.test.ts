// End-to-end: real hub process, real MCP shims (posing as Claude and Codex clients), real hook shims.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CLI = resolve(import.meta.dirname, "../src/cli.ts");
const HOME = mkdtempSync(join(tmpdir(), "gang-e2e-"));
const WORK = realpathSync(mkdtempSync(join(tmpdir(), "gang-e2e-repo-")));
const PORT = "7799";
const env = { ...process.env, GANG_HOME: HOME, GANG_PORT: PORT, GANG_NO_NOTIFY: "1" } as Record<string, string>;
const URL = `http://127.0.0.1:${PORT}`;
let daemon: ChildProcess;
let claude: Client, codex: Client;

async function mcp(name: string) {
  const c = new Client({ name, version: "1.0" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: ["--no-warnings", CLI, "mcp"], cwd: WORK, env }));
  return c;
}
async function callTool(c: Client, name: string, args: object, sid?: string) {
  const r: any = await c.callTool({ name, arguments: args as any, ...(sid ? { _meta: { "x-codex-turn-metadata": { session_id: sid } } } : {}) });
  const text = r.content[0].text;
  if (r.isError) throw new Error(text);
  try { return JSON.parse(text); } catch { return text; }
}
function hook(runtime: string, event: string, payload: object): Promise<{ code: number; out: string; err: string }> {
  return new Promise((res) => {
    const p = spawn(process.execPath, ["--no-warnings", CLI, "hook", runtime, event], { env });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", (code) => res({ code: code ?? -1, out, err }));
    p.stdin.end(JSON.stringify({ cwd: WORK, ...payload }));
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let TEAM = "";
const state = async () => (await fetch(`${URL}/api/state?team=${encodeURIComponent(TEAM)}`)).json();

before(async () => {
  daemon = spawn(process.execPath, ["--no-warnings", CLI, "daemon"], { env, stdio: "ignore" });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${URL}/health`)).ok) break; } catch {} await sleep(100); }
  const t = await (await fetch(`${URL}/api/teams/create`, { method: "POST", body: JSON.stringify({ name: "E2E Bench", folders: [WORK] }) })).json();
  TEAM = t.id;
  claude = await mcp("claude-code");
  codex = await mcp("codex-mcp-client");
});
after(async () => { await claude?.close(); await codex?.close(); daemon?.kill(); });

test("register both runtimes and bind sessions", async () => {
  const r1 = await callTool(claude, "register", { team: "E2E Bench", name: "planner", role: "planner" });
  assert.equal(r1.registered, "planner");
  assert.equal(r1.team_id, TEAM);
  // Claude binds through the PostToolUse hook for the register tool
  await hook("claude", "PostToolUse", { session_id: "claude-sess", tool_name: "mcp__gang__register", tool_input: { name: "planner", team: "E2E Bench" },
    tool_response: [{ type: "text", text: JSON.stringify(r1) }], transcript_path: "/x.jsonl" });
  // Codex binds immediately via _meta session id; no team given → the team covering its folder
  const r2 = await callTool(codex, "register", { name: "impl", role: "implementer" }, "codex-sess");
  assert.equal(r2.team_id, TEAM);
  assert.equal(r2.registered, "impl");
  const team = await callTool(claude, "team", {});
  assert.deepEqual(team.agents.map((a: any) => a.name).sort(), ["impl", "planner"]);
  const s = await state();
  assert.ok(s.agents.every((a: any) => a.session_id), "both sessions bound");
});

test("codex on-call Stop hook is released by a wake with a block decision", async () => {
  const pending = hook("codex", "Stop", { session_id: "codex-sess" });
  await sleep(400);
  assert.equal((await state()).agents.find((a: any) => a.name === "impl").status, "on_call");
  const w = await callTool(claude, "wake", { to: "impl", reason: "eval harness fixed — rerun seeds 1-3" });
  assert.equal(w.method, "on_call");
  const r = await pending;
  assert.equal(r.code, 0);
  const out = JSON.parse(r.out);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /woken by planner/);
  const inbox = await callTool(codex, "inbox", {}, "codex-sess");
  assert.match(inbox[0].body, /rerun seeds/);
});

test("claude asyncRewake Stop hook exits 2 with the wake text", async () => {
  const pending = hook("claude", "Stop", { session_id: "claude-sess" });
  await sleep(400);
  await callTool(codex, "send", { to: "planner", body: "seeds 1-3 done: 71.9 / 72.4 / 71.5", kind: "answer" }, "codex-sess");
  await callTool(codex, "wake", { to: "planner", reason: "results ready" }, "codex-sess");
  const r = await pending;
  assert.equal(r.code, 2);
  assert.match(r.err, /woken by impl/);
  assert.match(r.err, /2 unread/);
});

test("PostToolUse injects a notice once; unregistered sessions get nothing", async () => {
  await callTool(codex, "send", { to: "planner", body: "also: found a leak in the dataloader" }, "codex-sess");
  const r = await hook("claude", "PostToolUse", { session_id: "claude-sess", tool_name: "Bash" });
  const ctx = JSON.parse(r.out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /\[gang\].*leak/s);
  assert.equal((await hook("claude", "PostToolUse", { session_id: "claude-sess", tool_name: "Bash" })).out, "");
  const stranger = await hook("codex", "Stop", { session_id: "hidden-helper" });
  assert.equal(stranger.code, 0);
  assert.equal(stranger.out, "");
});

test("job_start runs detached and messages the owner on finish", async () => {
  const j = await callTool(claude, "job_start", { cmd: "echo epoch 1/2; sleep 0.5; echo epoch 2/2", name: "tiny-train", notify: "message" });
  assert.ok(j.job);
  for (let i = 0; i < 50; i++) { const s = await state(); if (s.jobs.find((x: any) => x.id === j.job).status !== "running") break; await sleep(200); }
  const s = await state();
  assert.equal(s.jobs.find((x: any) => x.id === j.job).status, "succeeded");
  const inbox = await callTool(claude, "inbox", {});
  assert.ok(inbox.some((m: any) => /tiny-train" succeeded[\s\S]*epoch 2\/2/.test(m.body)));
});

test("inspect, findings, status, dashboard", async () => {
  await callTool(codex, "post_status", { text: "rerunning seeds with fixed loader" }, "codex-sess");
  await callTool(codex, "post_finding", { text: "dataloader leak inflates acc by ~0.8pt" }, "codex-sess");
  const d = await callTool(claude, "inspect", { agent: "impl" });
  assert.equal(d.status_text, "rerunning seeds with fixed loader");
  assert.match(d.findings[0].body, /leak/);
  const html = await (await fetch(`${URL}/`)).text();
  assert.match(html, /<title>GANG GANG<\/title>/);
  const unregistered = await mcp("claude-code");
  await assert.rejects(callTool(unregistered, "team", {}), /not registered/);
  await unregistered.close();
});

test("phase 2: tasks, decisions in the SessionStart briefing, and claim enforcement via the real hook", async () => {
  const t1 = await callTool(claude, "task_add", { title: "fix truncation", owner: "impl" });
  await callTool(claude, "task_add", { title: "run sweep", depends_on: [t1.id] });
  await callTool(claude, "decide", { title: "Use seeds 1-3", body: "report mean ± std" });
  const brief = await hook("codex", "SessionStart", { session_id: "codex-sess", source: "resume" });
  const ctx = JSON.parse(brief.out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /Use seeds 1-3/);
  assert.match(ctx, /fix truncation/);

  const c = await callTool(codex, "claim", { paths: ["eval/**"], note: "fixing truncation" }, "codex-sess");
  assert.equal(c.claimed.length, 1);
  const denied = await hook("claude", "PreToolUse", { session_id: "claude-sess", tool_name: "Edit", tool_input: { file_path: `${WORK}/eval/harness.py` } });
  const out = JSON.parse(denied.out).hookSpecificOutput;
  assert.equal(out.permissionDecision, "deny");
  assert.match(out.permissionDecisionReason, /claimed by teammate impl/);
  const codexDenied = await hook("codex", "PreToolUse", { session_id: "codex-sess", tool_name: "apply_patch", tool_input: { command: "*** Update File: eval/x.py" } });
  assert.equal(codexDenied.code, 0, "own claim allowed");

  await callTool(codex, "task_update", { id: t1.id, status: "done", note: "fixed" }, "codex-sess");
  const inbox = await callTool(claude, "inbox", {});
  assert.ok(inbox.some((m: any) => /run sweep" is unblocked/.test(m.body)));
  const s = await state();
  assert.equal(s.tasks.length, 2);
  assert.equal(s.decisions.length, 1);
  assert.equal(s.claims.length, 1);
  assert.ok(s.human.messages.some((m: any) => m.kind === "decision"));
});

test("approvals + pause through the real hook script", async () => {
  const r = await hook("codex", "PermissionRequest", { session_id: "codex-sess", tool_name: "Bash", tool_input: { command: "rm -rf data/cache" } });
  assert.equal(r.code, 0);
  assert.equal(r.out, "", "must not answer the permission prompt on the user's behalf");
  let s = await state();
  const impl = s.agents.find((a: any) => a.name === "impl");
  assert.equal(impl.status, "waiting_permission");
  assert.match(impl.approval.detail, /rm -rf data\/cache/);
  await hook("codex", "PostToolUse", { session_id: "codex-sess", tool_name: "Bash" });
  await fetch(`${URL}/api/teams/pause`, { method: "POST", body: JSON.stringify({ team: TEAM, paused: true }) });
  const stop = await hook("codex", "Stop", { session_id: "codex-sess" });
  assert.equal(stop.out, "", "paused: no on-call");
  const w = await callTool(claude, "wake", { to: "impl", reason: "go" });
  assert.equal(w.method, "held");
  s = await state();
  assert.match(s.hold, /paused/);
  await fetch(`${URL}/api/teams/pause`, { method: "POST", body: JSON.stringify({ team: TEAM, paused: false }) });
});

test("lead: register → approve → brief → act as the user, through real MCP + hook processes", async () => {
  const leadClient = await mcp("claude-code");
  try {
  const reg = await callTool(leadClient, "lead", { action: "register", name: "lead" });
  assert.equal(reg.status, "pending");
  await assert.rejects(callTool(leadClient, "lead", { action: "brief" }), /approve/);
  // Claude binds the lead session via the PostToolUse hook carrying lead_id
  await hook("claude", "PostToolUse", { session_id: "lead-sess", tool_name: "mcp__gang__lead", tool_input: { action: "register", name: "lead" },
    tool_response: [{ type: "text", text: JSON.stringify(reg) }] });
  let s = await state();
  assert.equal(s.leads.find((l: any) => l.id === reg.lead_id).session_id, "lead-sess");
  await fetch(`${URL}/api/lead/approve`, { method: "POST", body: JSON.stringify({ id: reg.lead_id }) });

  await callTool(codex, "send", { to: "human", body: "which seed range for the sweep?", kind: "question" }, "codex-sess");
  const notice = await hook("claude", "UserPromptSubmit", { session_id: "lead-sess", prompt: "anything need me?" });
  assert.match(JSON.parse(notice.out).hookSpecificOutput.additionalContext, /new for the user \(impl question\)/);
  const brief = await callTool(leadClient, "lead", { action: "brief" });
  assert.ok(brief.needs_user.messages.some((m: string) => /seed range/.test(m)));
  const qid = Number(brief.needs_user.messages.find((m: string) => /seed range/.test(m)).match(/^#(\d+)/)[1]);
  await callTool(leadClient, "lead", { action: "reply", id: qid, body: "seeds 1-3" });
  const inbox = await callTool(codex, "inbox", {}, "codex-sess");
  const reply = inbox.find((m: any) => m.body === "seeds 1-3");
  assert.match(reply.from, /the user \(via their lead lead\)/);
  s = await state();
  assert.ok(s.activity.some((a: any) => a.via === "lead" && a.kind === "message"));
  } finally { await leadClient.close(); }
});
