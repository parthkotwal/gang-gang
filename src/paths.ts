import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const GANG_HOME = process.env.GANG_HOME ?? join(homedir(), ".gang");
export const DB_PATH = join(GANG_HOME, "gang.db");
export const JOBS_DIR = join(GANG_HOME, "jobs");
export const BACKUP_DIR = join(GANG_HOME, "backups");
export const DAEMON_LOG = join(GANG_HOME, "daemon.log");
export const PID_FILE = join(GANG_HOME, "daemon.pid");
export const PORT = Number(process.env.GANG_PORT ?? 7787);
export const HUB_URL = `http://127.0.0.1:${PORT}`;

export const SRC_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_DIR = resolve(SRC_DIR, "..");
export const CLI_PATH = join(SRC_DIR, "cli.ts");
export const WEB_DIR = join(REPO_DIR, "web");

/** Group a cwd (including git worktrees) under one project key: the main repo root. */
export function projectFor(cwd: string): string {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 2000,
    }).toString().trim();
    if (common.endsWith("/.git")) return dirname(common);
    return common;
  } catch {
    return cwd;
  }
}
