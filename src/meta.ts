import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tailFile } from "./jobs.ts";

export interface SessionMeta {
  title?: string | null; model?: string | null; effort?: string | null; app?: string | null;
  branch?: string | null; folders?: string[]; cwd?: string | null;
}

const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const CODEX_DB = join(CODEX_HOME, "state_5.sqlite");

function codexDb(): DatabaseSync | null {
  if (!existsSync(CODEX_DB)) return null;
  try { return new DatabaseSync(CODEX_DB, { readOnly: true }); } catch { return null; }
}

/** Codex threads: the desktop app keeps title, model, branch, app in its own state DB. */
export function codexThreadMeta(threadId: string): SessionMeta | null {
  const db = codexDb();
  if (!db) return null;
  try {
    const r = db.prepare("SELECT name, title, model, reasoning_effort, git_branch, originator, cwd FROM threads WHERE id=?").get(threadId) as any;
    if (!r) return null;
    const folders = r.cwd ? [r.cwd] : [];
    const proj = r.cwd ? codexProjects().find((p) => p.roots.some((root) => r.cwd === root || r.cwd.startsWith(root + "/"))) : undefined;
    if (proj) for (const root of proj.roots) if (!folders.includes(root)) folders.push(root);
    return {
      title: r.name || (r.title && r.title.length < 80 ? r.title : null),
      model: r.model, effort: r.reasoning_effort, branch: r.git_branch,
      app: r.originator === "Codex Desktop" ? "Codex desktop" : r.originator || "Codex",
      folders, cwd: r.cwd,
    };
  } catch { return null; } finally { db.close(); }
}

export function codexProjects(): { id: string; name: string; roots: string[] }[] {
  const db = codexDb();
  if (!db) return [];
  try {
    const rows = db.prepare(`SELECT p.id, p.name, r.path FROM projects p JOIN project_roots r ON r.project_id = p.id
      ORDER BY p.position, r.position`).all() as any[];
    const map = new Map<string, { id: string; name: string; roots: string[] }>();
    for (const r of rows) {
      if (!map.has(r.id)) map.set(r.id, { id: r.id, name: r.name, roots: [] });
      map.get(r.id)!.roots.push(r.path);
    }
    return [...map.values()];
  } catch { return []; } finally { db.close(); }
}

/** Claude Code transcripts carry the session's custom title, entrypoint (app), model, branch, dirs. */
export function claudeTranscriptMeta(path: string): SessionMeta | null {
  const raw = tailFile(path, 3_000_000);
  if (!raw) return null;
  const m: SessionMeta = {};
  for (const line of raw.split("\n")) {
    if (!line.includes("{")) continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type === "custom-title" && d.customTitle) m.title = d.customTitle;
    if (d.type === "summary" && d.summary && !m.title) m.title = d.summary;
    if (d.entrypoint) m.app = d.entrypoint === "claude-desktop" ? "Claude desktop" : d.entrypoint === "cli" ? "Claude Code CLI" : d.entrypoint;
    if (d.gitBranch) m.branch = d.gitBranch;
    if (d.cwd) m.cwd = d.cwd;
    if (d.type === "assistant" && d.message?.model && !String(d.message.model).startsWith("<")) m.model = d.message.model;
    if (d.effort) m.effort = typeof d.effort === "string" ? d.effort : d.effort?.level ?? m.effort;
    const env = d.attachment?.type === "environment" ? d.attachment.snapshot : null;
    if (env) m.folders = [env.workingDirectory, ...(env.additionalWorkingDirectories ?? [])].filter(Boolean);
  }
  if (!m.folders && m.cwd) m.folders = [m.cwd];
  return m;
}

/** Codex CLI rollouts (no desktop DB row): read session_meta / turn_context. */
export function codexRolloutMeta(path: string): SessionMeta | null {
  const raw = tailFile(path, 1_000_000);
  const m: SessionMeta = {};
  for (const line of raw.split("\n")) {
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type === "session_meta") { m.app = d.payload?.originator; m.cwd = d.payload?.cwd; m.branch = d.payload?.git?.branch ?? m.branch; }
    if (d.type === "turn_context") { m.model = d.payload?.model ?? m.model; m.effort = d.payload?.effort ?? m.effort; m.cwd = d.payload?.cwd ?? m.cwd; }
  }
  if (m.cwd) m.folders = [m.cwd];
  return m;
}

export function sessionMeta(runtime: string, sessionId: string | null, transcript: string | null): SessionMeta | null {
  if (runtime === "codex") return (sessionId && codexThreadMeta(sessionId)) || (transcript ? codexRolloutMeta(transcript) : null);
  if (runtime === "claude" && transcript) return claudeTranscriptMeta(transcript);
  return null;
}
