import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { BACKUP_DIR, CLI_PATH } from "./paths.ts";

const CLAUDE_SETTINGS = join(homedir(), ".claude", "settings.json");
const CODEX_HOOKS = join(homedir(), ".codex", "hooks.json");
const CODEX_CONFIG = join(homedir(), ".codex", "config.toml");
const MARK = "gang-gang"; // every installed command contains the repo path, which contains this

// Prefer a stable symlink (e.g. Homebrew's) over the versioned Cellar path, so upgrades don't break hooks
// or invalidate Codex's hook trust (which is pinned to the command string).
export const node = ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
  .find((p) => { try { return realpathSync(p) === realpathSync(process.execPath); } catch { return false; } }) ?? process.execPath;
const hookCmd = (runtime: string, event: string) => `"${node}" --no-warnings "${CLI_PATH}" hook ${runtime} ${event}`;
const isOurs = (h: any) => typeof h?.command === "string" && h.command.includes(CLI_PATH);

function backup() {
  const dir = join(BACKUP_DIR, new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(dir, { recursive: true });
  for (const f of [CLAUDE_SETTINGS, CODEX_HOOKS, CODEX_CONFIG]) if (existsSync(f)) copyFileSync(f, join(dir, f.replace(homedir(), "").replace(/\//g, "_")));
  return dir;
}

function mergeHooks(existing: any, ours: Record<string, any[]>) {
  const hooks = { ...(existing ?? {}) };
  for (const [event, groups] of Object.entries(hooks)) {
    hooks[event] = (groups as any[]).map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h: any) => !isOurs(h)) }))
      .filter((g) => g.hooks.length);
    if (!hooks[event].length) delete hooks[event];
  }
  for (const [event, groups] of Object.entries(ours)) hooks[event] = [...(hooks[event] ?? []), ...groups];
  return hooks;
}

const readJson = (p: string) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {});
const writeJson = (p: string, d: unknown) => writeFileSync(p, JSON.stringify(d, null, 2) + "\n");

export function isInstalled() {
  try { return readFileSync(CLAUDE_SETTINGS, "utf8").includes(CLI_PATH) && readFileSync(CODEX_CONFIG, "utf8").includes(CLI_PATH); } catch { return false; }
}

export function install() {
  const dir = backup();
  // Claude Code (CLI + desktop share ~/.claude/settings.json)
  const cs = readJson(CLAUDE_SETTINGS);
  const c = (event: string, extra: object = {}) => [{ hooks: [{ type: "command", command: hookCmd("claude", event), ...extra }] }];
  cs.hooks = mergeHooks(cs.hooks, {
    SessionStart: c("SessionStart", { timeout: 10 }),
    UserPromptSubmit: c("UserPromptSubmit", { timeout: 10 }),
    PostToolUse: c("PostToolUse", { timeout: 10 }),
    Notification: c("Notification", { timeout: 10 }),
    PreToolUse: [{ matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: hookCmd("claude", "PreToolUse"), timeout: 10 }] }],
    PermissionRequest: c("PermissionRequest", { timeout: 10 }),
    Stop: c("Stop", { async: true, asyncRewake: true }),
  });
  writeJson(CLAUDE_SETTINGS, cs);
  try {
    execFileSync("claude", ["mcp", "remove", "-s", "user", "gang"], { stdio: "ignore" });
  } catch {}
  execFileSync("claude", ["mcp", "add", "-s", "user", "gang", "--", node, "--no-warnings", CLI_PATH, "mcp"], { stdio: "ignore" });

  // Codex (CLI + desktop share ~/.codex)
  const ch = readJson(CODEX_HOOKS);
  const x = (event: string, timeout: number, extra: object = {}) => [{ hooks: [{ type: "command", command: hookCmd("codex", event), timeout, ...extra }] }];
  ch.hooks = mergeHooks(ch.hooks, {
    SessionStart: x("SessionStart", 10),
    UserPromptSubmit: x("UserPromptSubmit", 10),
    PostToolUse: x("PostToolUse", 10),
    PreToolUse: [{ matcher: "apply_patch|Edit|Write", hooks: [{ type: "command", command: hookCmd("codex", "PreToolUse"), timeout: 10 }] }],
    PermissionRequest: x("PermissionRequest", 10),
    Stop: x("Stop", 3600, { statusMessage: "gang: on call (waiting for teammates)" }),
  });
  writeJson(CODEX_HOOKS, ch);
  let toml = existsSync(CODEX_CONFIG) ? readFileSync(CODEX_CONFIG, "utf8") : "";
  toml = stripCodexMcp(toml);
  toml = toml.replace(/\s*$/, "\n") + `\n# ${MARK} hub (managed by \`gang init\`)\n[mcp_servers.gang]\ncommand = ${JSON.stringify(node)}\n` +
    `args = ${JSON.stringify(["--no-warnings", CLI_PATH, "mcp"])}\n`;
  writeFileSync(CODEX_CONFIG, toml);
  return dir;
}

function stripCodexMcp(toml: string) {
  return toml.replace(/\n*# gang-gang hub \(managed by `gang init`\)\n\[mcp_servers\.gang\]\n(?:[^\[\n][^\n]*\n?)*/g, "\n");
}

export function uninstall() {
  const dir = backup();
  const cs = readJson(CLAUDE_SETTINGS);
  if (cs.hooks) { cs.hooks = mergeHooks(cs.hooks, {}); if (!Object.keys(cs.hooks).length) delete cs.hooks; writeJson(CLAUDE_SETTINGS, cs); }
  try { execFileSync("claude", ["mcp", "remove", "-s", "user", "gang"], { stdio: "ignore" }); } catch {}
  if (existsSync(CODEX_HOOKS)) {
    const ch = readJson(CODEX_HOOKS);
    ch.hooks = mergeHooks(ch.hooks, {});
    const onlyOurs = !Object.keys(ch.hooks).length && Object.keys(ch).every((k) => k === "hooks" || k === "description");
    if (onlyOurs) unlinkSync(CODEX_HOOKS); else writeJson(CODEX_HOOKS, ch);
  }
  if (existsSync(CODEX_CONFIG)) writeFileSync(CODEX_CONFIG, stripCodexMcp(readFileSync(CODEX_CONFIG, "utf8")).replace(/\s*$/, "\n"));
  return dir;
}
