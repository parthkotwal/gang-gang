import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";

export type Status = "working" | "on_call" | "asleep" | "waiting_permission" | "offline";

export interface Team { id: string; name: string; folders: string; source: string | null; created: number; settings: string }
export interface Agent {
  team: string; name: string; role: string; runtime: string;
  session_id: string | null; transcript_path: string | null; cwd: string | null;
  status: Status; status_text: string | null; last_seen: number; created: number;
  title: string | null; model: string | null; effort: string | null; app: string | null;
  branch: string | null; folders: string | null; meta_at: number | null;
  approval: string | null; auto_turns: number;
}
export interface Message {
  id: number; team: string; from_agent: string; to_agent: string; kind: string;
  body: string; thread_id: number | null; created: number;
}
export interface Wake {
  id: number; team: string; from_agent: string; to_agent: string; reason: string;
  created: number; delivered_at: number | null; method: string | null; exempt: number;
}
export interface Job {
  id: number; team: string; owner: string; name: string; cmd: string; cwd: string;
  pid: number | null; status: string; exit_code: number | null; log_path: string;
  progress: string | null; notify: string; started: number; ended: number | null;
}
export interface Task {
  id: number; team: string; title: string; body: string | null; status: string; owner: string | null;
  created_by: string; depends_on: string; notes: string; created: number; updated: number;
}
export interface Decision {
  id: number; team: string; title: string; body: string; decided_by: string; status: string;
  supersedes: number | null; created: number;
}
export interface Claim {
  id: number; team: string; agent: string; pattern: string; exclusive: number; note: string | null;
  created: number; expires: number; released: number | null;
}
export interface Session {
  session_id: string; runtime: string; cwd: string | null; transcript_path: string | null;
  last_event: string | null; last_seen: number;
}

export const now = () => Date.now();
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "team";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, folders TEXT NOT NULL DEFAULT '[]', source TEXT, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS agents (
    team TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '',
    runtime TEXT NOT NULL DEFAULT '', session_id TEXT, transcript_path TEXT, cwd TEXT,
    status TEXT NOT NULL DEFAULT 'working', status_text TEXT,
    last_seen INTEGER NOT NULL, created INTEGER NOT NULL,
    title TEXT, model TEXT, effort TEXT, app TEXT, branch TEXT, folders TEXT, meta_at INTEGER,
    PRIMARY KEY (team, name));
  CREATE UNIQUE INDEX IF NOT EXISTS agents_session ON agents(session_id) WHERE session_id IS NOT NULL;
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY, runtime TEXT NOT NULL, cwd TEXT, transcript_path TEXT,
    last_event TEXT, last_seen INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, team TEXT NOT NULL, from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'msg', body TEXT NOT NULL,
    thread_id INTEGER, created INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS messages_to ON messages(team, to_agent);
  CREATE TABLE IF NOT EXISTS receipts (
    message_id INTEGER NOT NULL, agent TEXT NOT NULL, notified_at INTEGER, read_at INTEGER,
    PRIMARY KEY (message_id, agent));
  CREATE TABLE IF NOT EXISTS wakes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, team TEXT NOT NULL, from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL, reason TEXT NOT NULL, created INTEGER NOT NULL,
    delivered_at INTEGER, method TEXT, exempt INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, team TEXT NOT NULL, owner TEXT NOT NULL,
    name TEXT NOT NULL, cmd TEXT NOT NULL, cwd TEXT NOT NULL, pid INTEGER,
    status TEXT NOT NULL, exit_code INTEGER, log_path TEXT NOT NULL, progress TEXT,
    notify TEXT NOT NULL DEFAULT 'wake', started INTEGER NOT NULL, ended INTEGER);
  CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT, team TEXT NOT NULL, ts INTEGER NOT NULL,
    kind TEXT NOT NULL, actor TEXT, target TEXT, text TEXT NOT NULL, ref INTEGER);
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, team TEXT NOT NULL, title TEXT NOT NULL, body TEXT,
    status TEXT NOT NULL DEFAULT 'open', owner TEXT, created_by TEXT NOT NULL,
    depends_on TEXT NOT NULL DEFAULT '[]', notes TEXT NOT NULL DEFAULT '[]',
    created INTEGER NOT NULL, updated INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, team TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
    decided_by TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', supersedes INTEGER, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT, team TEXT NOT NULL, agent TEXT NOT NULL, pattern TEXT NOT NULL,
    exclusive INTEGER NOT NULL DEFAULT 1, note TEXT, created INTEGER NOT NULL, expires INTEGER NOT NULL, released INTEGER);
`;

export function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
  migrateV1(db);
  db.exec(SCHEMA);
  // additive columns (v3): guardrail settings, approval tracking, autonomy budget
  ensureColumn(db, "teams", "settings", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "agents", "approval", "TEXT");
  ensureColumn(db, "agents", "auto_turns", "INTEGER NOT NULL DEFAULT 0");
  return db;
}

/** v1 keyed everything by repo path in a `project` column; v2 uses explicit teams. */
function migrateV1(db: DatabaseSync) {
  const cols = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "project")) return;
  const projects = new Set<string>();
  for (const t of ["agents", "messages", "wakes", "jobs", "activity"]) {
    for (const r of db.prepare(`SELECT DISTINCT project FROM ${t}`).all() as { project: string }[]) projects.add(r.project);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, folders TEXT NOT NULL DEFAULT '[]', source TEXT, created INTEGER NOT NULL);`);
  const ids = new Map<string, string>();
  for (const p of projects) {
    let id = slug(basename(p)); let n = 2;
    while ([...ids.values()].includes(id)) id = `${slug(basename(p))}-${n++}`;
    ids.set(p, id);
    db.prepare("INSERT OR IGNORE INTO teams (id, name, folders, source, created) VALUES (?,?,?,?,?)").run(id, basename(p), JSON.stringify([p]), "migrated", now());
  }
  for (const t of ["agents", "messages", "wakes", "jobs", "activity"]) {
    db.exec(`ALTER TABLE ${t} RENAME COLUMN project TO team`);
    for (const [p, id] of ids) db.prepare(`UPDATE ${t} SET team=? WHERE team=?`).run(id, p);
  }
  for (const c of ["title", "model", "effort", "app", "branch", "folders"]) db.exec(`ALTER TABLE agents ADD COLUMN ${c} TEXT`);
  db.exec("ALTER TABLE agents ADD COLUMN meta_at INTEGER; ALTER TABLE activity ADD COLUMN ref INTEGER;");
}

function ensureColumn(db: DatabaseSync, table: string, col: string, decl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}
