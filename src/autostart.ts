import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLI_PATH, DAEMON_LOG, GANG_HOME, REPO_DIR } from "./paths.ts";

const LABEL = "com.gang-gang.hub";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const uid = () => process.getuid?.() ?? Number(execFileSync("id", ["-u"]).toString().trim());
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

export function autostartEnabled() { return existsSync(PLIST); }

/** Run the hub at login (and restart it if it crashes) via a user LaunchAgent. */
export function enableAutostart(node: string) {
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(GANG_HOME, { recursive: true });
  const path = [join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>--no-warnings</string><string>${xml(CLI_PATH)}</string><string>daemon</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string></dict>
  <key>StandardOutPath</key><string>${xml(DAEMON_LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(DAEMON_LOG)}</string>
</dict></plist>
`);
  try { execFileSync("launchctl", ["bootout", `gui/${uid()}/${LABEL}`], { stdio: "ignore" }); } catch {}
  execFileSync("launchctl", ["bootstrap", `gui/${uid()}`, PLIST], { stdio: "ignore" });
}

export function disableAutostart() {
  try { execFileSync("launchctl", ["bootout", `gui/${uid()}/${LABEL}`], { stdio: "ignore" }); } catch {}
  if (existsSync(PLIST)) unlinkSync(PLIST);
}

/** Put `gang` on PATH via ~/.local/bin (only if that dir exists and nothing else owns the name). */
export function linkCli(): string | null {
  const dir = join(homedir(), ".local", "bin");
  const target = join(REPO_DIR, "bin", "gang");
  const link = join(dir, "gang");
  if (!existsSync(dir)) return null;
  try {
    if (lstatSync(link).isSymbolicLink()) { if (readlinkSync(link) === target) return link; unlinkSync(link); }
    else return null; // a real file named gang — leave it alone
  } catch {}
  symlinkSync(target, link);
  return link;
}
export function unlinkCli() {
  const link = join(homedir(), ".local", "bin", "gang");
  try { if (lstatSync(link).isSymbolicLink() && readlinkSync(link) === join(REPO_DIR, "bin", "gang")) unlinkSync(link); } catch {}
}
