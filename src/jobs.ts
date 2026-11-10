import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Core } from "./core.ts";
import { HUB, oneLine } from "./core.ts";
import type { Job } from "./db.ts";
import { now } from "./db.ts";
import { JOBS_DIR } from "./paths.ts";

/** Detached local jobs. Exit codes go to <id>.exit so jobs survive hub restarts. */
export class Jobs {
  core: Core;
  timer: NodeJS.Timeout | null = null;
  killed = new Set<number>();

  constructor(core: Core) { this.core = core; mkdirSync(JOBS_DIR, { recursive: true }); }

  start(p: { team: string; owner: string; name?: string; cmd: string; cwd: string; notify?: string; env?: Record<string, string> }): Job {
    const db = this.core.db;
    if (!p.cmd?.trim()) throw new Error("cmd is required");
    if (!existsSync(p.cwd)) throw new Error(`working directory does not exist: ${p.cwd}`);
    const max = this.core.settings(p.team).max_running_jobs;
    const running = (db.prepare("SELECT COUNT(*) n FROM jobs WHERE team=? AND status='running'").get(p.team) as { n: number }).n;
    if (running >= max) throw new Error(`The team already has ${running} running jobs (limit ${max}). Wait for one to finish, or ask the user to raise the limit.`);
    const name = p.name?.trim() || oneLine(p.cmd, 40);
    const r = db.prepare(`INSERT INTO jobs (team, owner, name, cmd, cwd, status, log_path, notify, started)
      VALUES (?,?,?,?,?,'running','',?,?)`).run(p.team, p.owner, name, p.cmd, p.cwd, p.notify ?? "wake", now());
    const id = Number(r.lastInsertRowid);
    const log = join(JOBS_DIR, `${id}.log`);
    const exitFile = join(JOBS_DIR, `${id}.exit`);
    // Never trust leftovers from an earlier DB that reused this id.
    if (existsSync(exitFile)) unlinkSync(exitFile);
    const fd = openSync(log, "w");
    const script = `(\n${p.cmd}\n)\nprintf %s "$?" > '${exitFile}'`;
    const shell = process.env.SHELL || "/bin/zsh";
    const child = spawn(shell, p.env ? ["-c", script] : ["-lc", script], {
      cwd: p.cwd, detached: true, stdio: ["ignore", fd, fd],
      env: { ...process.env, ...(p.env ?? {}), GANG_JOB_ID: String(id), PYTHONUNBUFFERED: "1" },
    });
    child.on("error", (e) => {
      writeFileSync(exitFile, "127");
      appendFileSync(log, `\n[gang] failed to start job: ${e.message}\n`);
    });
    child.unref();
    closeSync(fd);
    db.prepare("UPDATE jobs SET pid=?, log_path=? WHERE id=?").run(child.pid ?? null, log, id);
    this.core.activity(p.team, "job", p.owner, null, `started job #${id}: ${name}`, id);
    return this.get(id)!;
  }

  get(id: number): Job | undefined {
    return this.core.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as Job | undefined;
  }
  list(team?: string): Job[] {
    const db = this.core.db;
    return (team ? db.prepare("SELECT * FROM jobs WHERE team=? ORDER BY id DESC LIMIT 100").all(team)
      : db.prepare("SELECT * FROM jobs ORDER BY id DESC LIMIT 100").all()) as unknown as Job[];
  }

  kill(id: number) {
    const j = this.get(id);
    if (!j || j.status !== "running" || !j.pid) return false;
    this.killed.add(id);
    try { process.kill(-j.pid, "SIGTERM"); } catch { try { process.kill(j.pid, "SIGTERM"); } catch {} }
    return true;
  }

  tail(id: number, lines = 40): string {
    const j = this.get(id);
    if (!j?.log_path || !existsSync(j.log_path)) return "";
    return tailFile(j.log_path, 64 * 1024).split(/\r?\n|\r/).filter(Boolean).slice(-lines).join("\n");
  }

  poll() {
    for (const j of this.core.db.prepare("SELECT * FROM jobs WHERE status='running'").all() as unknown as Job[]) {
      const exitFile = join(JOBS_DIR, `${j.id}.exit`);
      let code: number | null = null;
      if (existsSync(exitFile)) code = Number(readFileSync(exitFile, "utf8").trim() || "1");
      else if (j.pid && !alive(j.pid)) code = this.killed.has(j.id) ? 143 : -1;
      if (code === null) {
        const maxH = this.core.settings(j.team).max_job_hours;
        if (maxH > 0 && Date.now() - j.started > maxH * 3600_000 && !this.killed.has(j.id)) {
          this.kill(j.id);
          this.core.trip(j.team, "job_runtime", `Job #${j.id} "${j.name}" (${j.owner}) ran longer than ${maxH} h and was stopped.`);
        }
        this.progress(j); continue;
      }
      this.finish(j, code);
    }
  }

  private progress(j: Job) {
    const t = tailFile(j.log_path, 8192);
    const explicit = [...t.matchAll(/GANG_PROGRESS[: ]+(.+)/g)].pop()?.[1];
    const frac = [...t.matchAll(/(\d+)\s*\/\s*(\d+)/g)].pop();
    const pct = [...t.matchAll(/(\d{1,3}(?:\.\d+)?)%/g)].pop();
    const p = explicit?.trim() ?? (pct ? `${pct[1]}%` : frac && Number(frac[2]) > 0 ? `${frac[1]}/${frac[2]}` : null);
    if (p && p !== j.progress) this.core.db.prepare("UPDATE jobs SET progress=? WHERE id=?").run(p.slice(0, 60), j.id);
  }

  private finish(j: Job, code: number) {
    const status = this.killed.has(j.id) || code === 143 ? "killed" : code === 0 ? "succeeded" : "failed";
    this.core.db.prepare("UPDATE jobs SET status=?, exit_code=?, ended=? WHERE id=?").run(status, code, now(), j.id);
    const mins = ((now() - j.started) / 60000).toFixed(1);
    const tail = this.tail(j.id, 15);
    const body = `Job #${j.id} "${j.name}" ${status} (exit ${code}) after ${mins} min.\nLast log lines:\n${tail || "(no output)"}\n` +
      `Full log: ${j.log_path}`;
    this.core.activity(j.team, "job", j.owner, null, `job #${j.id} ${status} (exit ${code}) after ${mins} min: ${j.name}`, j.id);
    if (j.owner === "human" || !this.core.agent(j.team, j.owner)) { this.core.notify(`gang: job #${j.id} ${status}`, j.name); return; }
    if (j.notify === "none") return;
    if (j.notify === "wake") this.core.wake(j.team, HUB, j.owner, body, { exempt: true });
    else this.core.send(j.team, HUB, j.owner, body, "job");
  }

  startPolling(ms = 2000) { this.timer = setInterval(() => { try { this.poll(); } catch (e) { console.error(e); } }, ms); }
  stop() { if (this.timer) clearInterval(this.timer); }
}

function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }

export function tailFile(path: string, bytes: number): string {
  try {
    const size = statSync(path).size;
    const fd = openSync(path, "r");
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    closeSync(fd);
    return buf.toString("utf8");
  } catch { return ""; }
}
