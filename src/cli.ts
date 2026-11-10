#!/usr/bin/env node
// gang CLI entry point. Imports are lazy so the hook path stays fast.
const [cmd, ...rest] = process.argv.slice(2);

const HELP = `GANG GANG! — a cross-agent hub for your Claude Code and Codex sessions

  gang up [team name]        one-step start: install if needed, start the hub, make a team for this
                             folder if there isn't one, and open the dashboard to add agents
  gang init [--no-autostart] install hooks + MCP into ~/.claude and ~/.codex (backs up first),
                             start the hub at login, and put \`gang\` on your PATH
  gang uninstall             remove them again
  gang open                  open the dashboard (create teams, onboard agents, watch everything)
  gang new <team> [folder…]  create a team for one or more folders (default: this folder)
  gang teams                 list teams and their folders
  gang join <name> [role] [--team T] [--existing]
                             print + copy the prompt that makes a session join a team
                             (--existing: for a session that already has work in it)
  gang ls                    list agents in this folder's team
  gang send <to> <msg…> [--wake]   message an agent as you ('*' = everyone)
  gang wake <to> [reason…]   wake an agent
  gang inbox                 messages agents sent you
  gang run [--as <agent>] [--name <n>] [--notify wake|message|none] -- <cmd…>
                             run a long job tracked by the hub (owner gets woken on finish)
  gang jobs | logs <id> | kill <id>
  gang lead                  show your lead agent (and any pending request to become it)
  gang lead prompt           print + copy the prompt that makes a chat session your lead
  gang lead approve [id]     approve a pending lead (id needed if several are waiting)
  gang lead revoke           remove your lead (and reject pending requests)
  gang pause | resume        stop/allow agent-initiated wakes for this folder's team
  gang autostart on|off      start the hub at login (on by default after init)
  gang start | stop | status manage the background hub (auto-starts when agents use gang)

  Most commands take --team <name>; otherwise the team covering the current folder is used.
  internal: gang daemon | gang hook <runtime> <event> | gang mcp`;

async function main(): Promise<number> {
  if (cmd === "hook") { const { runHook } = await import("./hook.ts"); return runHook(rest[0], rest[1]); }
  if (cmd === "mcp") { const { runMcp } = await import("./mcp.ts"); await runMcp(); return -1; }
  if (cmd === "daemon") { const { runDaemon } = await import("./server.ts"); runDaemon(); return -1; }

  const paths = await import("./paths.ts");
  const client = await import("./client.ts");
  const { HUB_URL } = paths;
  const { resolve } = await import("node:path");
  const flag = (name: string) => { const i = rest.indexOf(name); if (i < 0) return undefined; const v = rest[i + 1]; rest.splice(i, 2); return v; };
  const bool = (name: string) => { const i = rest.indexOf(name); if (i < 0) return false; rest.splice(i, 1); return true; };
  const teamFlag = flag("--team");
  const cwd = process.cwd();

  async function findTeam(required = true): Promise<any> {
    await client.ensureDaemon();
    const s = await client.getJson(`${HUB_URL}/api/state`);
    const teams = s.teams as any[];
    if (teamFlag) {
      const t = teams.find((x) => x.id === teamFlag || x.name.toLowerCase() === teamFlag.toLowerCase());
      if (!t && required) throw new Error(`no team "${teamFlag}". Teams: ${teams.map((x) => x.name).join(", ") || "(none)"}`);
      return t;
    }
    const covering = teams.filter((t) => t.folderList.some((f: string) => cwd === f || cwd.startsWith(f + "/")));
    if (covering.length === 1) return covering[0];
    if (!required) return undefined;
    if (covering.length > 1) throw new Error(`several teams cover this folder (${covering.map((t) => t.name).join(", ")}); pass --team`);
    throw new Error(`no team covers ${cwd}. Create one with: gang new <name>   (or pass --team)`);
  }
  const api = async (path: string, body: object) => {
    const t = await findTeam();
    const r = await client.postJson(`${HUB_URL}${path}`, { team: t.id, ...body });
    if (r?.error) throw new Error(r.error);
    return r;
  };
  async function stopHub(): Promise<boolean> {
    const { readFileSync } = await import("node:fs");
    try { process.kill(Number(readFileSync(paths.PID_FILE, "utf8")), "SIGTERM"); } catch { return false; }
    for (let i = 0; i < 20 && (await client.healthy()); i++) await new Promise((r) => setTimeout(r, 100));
    return true;
  }
  /** Give launchd's copy of the hub a moment to come up so we don't race it with a second one. */
  async function waitHealthy() { for (let i = 0; i < 50 && !(await client.healthy()); i++) await new Promise((r) => setTimeout(r, 100)); }
  async function doInit(autostart: boolean) {
    const { install, node } = await import("./install.ts");
    const a = await import("./autostart.ts");
    const dir = install();
    console.log(`Installed gang hooks + MCP for Claude Code and Codex (backup: ${dir}).`);
    const link = a.linkCli();
    if (link) console.log(`• \`gang\` is on your PATH (${link}).`);
    if (autostart) { await stopHub(); a.enableAutostart(node); await waitHealthy(); console.log(`• The hub starts at login and restarts if it crashes (\`gang autostart off\` to disable).`); }
    await client.ensureDaemon();
    console.log(`• Codex: Settings → Hooks → trust the gang hooks (once, and again after gang adds hooks).`);
    console.log(`• Sessions opened before now need reopening to get the gang tools.`);
  }
  const stateFor = async () => { const t = await findTeam(); return client.getJson(`${HUB_URL}/api/state?team=${encodeURIComponent(t.id)}`); };

  switch (cmd) {
    case "init": {
      await doInit(!bool("--no-autostart"));
      console.log(`Dashboard: ${HUB_URL}  (gang open)`);
      return 0;
    }
    case "up": {
      if (!(await import("./install.ts")).isInstalled()) await doInit(true);
      await client.ensureDaemon();
      let t = await findTeam(false).catch(() => undefined);
      if (!t) {
        const { basename } = await import("node:path");
        const root = paths.projectFor(cwd);
        const name = teamFlag ?? rest[0] ?? basename(root);
        const r = await client.postJson(`${HUB_URL}/api/teams/create`, { name, folders: [root], source: "cli" });
        if (r.error) { console.error(`error: ${r.error}`); return 1; }
        t = r; console.log(`GANG GANG! Team "${r.name}" is live for ${root}`);
      } else console.log(`Team "${t.name}" (${t.folderList.join(", ")})`);
      const url = `${HUB_URL}/?team=${encodeURIComponent(t.id)}&add=1`;
      (await import("node:child_process")).execFile("open", [url]);
      console.log(`Dashboard opened: ${url}\nPick a role, copy the prompt, paste it into a Codex or Claude session. Roll out 🤙`);
      return 0;
    }
    case "autostart": {
      const a = await import("./autostart.ts");
      const { node } = await import("./install.ts");
      if (rest[0] === "off") { a.disableAutostart(); console.log("The hub will no longer start at login."); }
      else if (rest[0] === "on") { await stopHub(); a.enableAutostart(node); await waitHealthy(); console.log("The hub now starts at login (and restarts if it crashes)."); }
      else console.log(a.autostartEnabled() ? "on" : "off");
      return 0;
    }
    case "lead": {
      await client.ensureDaemon();
      const s = await client.getJson(`${HUB_URL}/api/state`);
      const leads = s.leads as any[];
      const sub = rest[0] ?? "status";
      const describe = (l: any) => `${l.name} (${l.runtime}${l.cwd ? `, ${l.cwd}` : ""}) — ${l.status}${l.wake_on_needs ? ", wakes when something needs you" : ""}`;
      if (sub === "prompt") {
        const r = await client.getJson(`${HUB_URL}/api/lead-prompt?name=${encodeURIComponent(rest[1] ?? "lead")}`);
        console.log(r.prompt);
        try { (await import("node:child_process")).execFileSync("pbcopy", { input: r.prompt }); console.error("\n(copied — paste it into the chat you want as your lead, new or existing)"); } catch {}
        return 0;
      }
      if (sub === "approve") {
        const pending = leads.filter((l) => l.status === "pending");
        if (!pending.length) { console.log("No pending lead. Paste the prompt from `gang lead prompt` into a chat first."); return 1; }
        const l = rest[1] ? pending.find((x) => x.id === rest[1] || x.id.startsWith(rest[1])) : pending.length === 1 ? pending[0] : null;
        if (!l) {
          console.log(rest[1] ? `No pending lead matches "${rest[1]}".` : "Several sessions want to be your lead. Approve one by id:");
          for (const x of pending) console.log(`  gang lead approve ${x.id.slice(0, 8)}   ${describe(x)}`);
          return 1;
        }
        const cur = leads.find((x) => x.status === "approved");
        const r = await client.postJson(`${HUB_URL}/api/lead/approve`, { id: l.id });
        if (r?.error) { console.error(`gang: ${r.error}`); return 1; }
        if (cur) console.log(`Replaced your previous lead, ${describe(cur)}.`);
        console.log(`Approved ${describe({ ...l, status: "approved" })}. GANG GANG — your lead is in.`);
        return 0;
      }
      if (sub === "revoke") {
        for (const l of leads) await client.postJson(`${HUB_URL}/api/lead/revoke`, { id: l.id });
        console.log(leads.length ? "Lead revoked." : "No lead to revoke.");
        return 0;
      }
      if (!leads.length) console.log("No lead yet. Run `gang lead prompt` and paste it into the chat you want as your lead.");
      for (const l of leads) console.log(describe(l));
      return 0;
    }
    case "pause": case "resume": {
      await api("/api/teams/pause", { paused: cmd === "pause" });
      console.log(cmd === "pause" ? "Paused: agents finish their current turn; no agent-initiated wakes until you resume. Your own messages and wakes still work." : "Resumed.");
      return 0;
    }
    case "uninstall": {
      const { uninstall } = await import("./install.ts");
      const a = await import("./autostart.ts");
      a.disableAutostart(); a.unlinkCli(); await stopHub();
      console.log(`Removed gang hooks + MCP, login item and PATH link (backup: ${uninstall()}). The hub DB in ~/.gang is kept.`);
      return 0;
    }
    case "start": await client.ensureDaemon(); console.log(`gang hub running at ${HUB_URL}`); return 0;
    case "status": console.log((await client.healthy()) ? `running at ${HUB_URL}` : "not running"); return 0;
    case "stop": console.log((await stopHub()) ? "stopped" + ((await import("./autostart.ts")).autostartEnabled() ? " (it starts again at next login; `gang autostart off` to prevent that)" : "") : "not running"); return 0;
    case "open": {
      await client.ensureDaemon();
      const t = await findTeam(false).catch(() => undefined);
      const { execFile } = await import("node:child_process");
      const url = `${HUB_URL}/${t ? `?team=${encodeURIComponent(t.id)}` : ""}`;
      execFile("open", [url]);
      console.log(url);
      return 0;
    }
    case "new": {
      const [name, ...folders] = rest;
      if (!name) { console.error("usage: gang new <team name> [folder…]"); return 1; }
      await client.ensureDaemon();
      const r = await client.postJson(`${HUB_URL}/api/teams/create`, { name, folders: (folders.length ? folders : [cwd]).map((f) => resolve(f)), source: "cli" });
      if (r.error) { console.error(`error: ${r.error}`); return 1; }
      console.log(`GANG GANG! Team "${r.name}" is live for ${JSON.parse(r.folders).join(", ")}.\nNext: gang join <agent-name> <role> --team "${r.name}"`);
      return 0;
    }
    case "teams": {
      await client.ensureDaemon();
      const s = await client.getJson(`${HUB_URL}/api/state`);
      if (!s.teams.length) console.log("No teams yet. Create one with: gang new <name> [folder…]");
      for (const t of s.teams) console.log(`${t.name.padEnd(22)} ${String(t.agents).padStart(2)} agents  ${t.folderList.join(", ")}`);
      return 0;
    }
    case "join": {
      if (!rest[0]) { console.error("usage: gang join <name> [role] [--team T] [--existing]"); return 1; }
      const existing = bool("--existing");
      const t = await findTeam();
      const r = await client.getJson(`${HUB_URL}/api/join-prompt?team=${encodeURIComponent(t.name)}&name=${encodeURIComponent(rest[0])}&role=${encodeURIComponent(rest[1] ?? "agent")}${existing ? "&existing=1" : ""}`);
      console.log(r.prompt);
      try { const { execFileSync } = await import("node:child_process"); execFileSync("pbcopy", { input: r.prompt }); console.error("\n(copied — paste it into the agent's session, new or existing)"); } catch {}
      return 0;
    }
    case "ls": {
      const s = await stateFor();
      const t = s.teams.find((x: any) => x.id === s.team);
      console.log(`team ${t.name}  (${t.folderList.join(", ")})`);
      for (const a of s.agents) console.log(`  ${a.name.padEnd(14)} ${a.status.padEnd(18)} ${(a.app ?? a.runtime).padEnd(15)} ${a.title ? `"${a.title}" ` : ""}${a.unread ? `[${a.unread} unread] ` : ""}${a.status_text ?? ""}`);
      for (const j of s.jobs.filter((j: any) => j.status === "running")) console.log(`  job #${j.id} ${j.owner}: ${j.name} ${j.progress ?? ""}`);
      const open = s.tasks.filter((x: any) => !["done", "cancelled"].includes(x.status));
      if (open.length) console.log(`  ${open.length} open task(s)`);
      if (s.human.unread) console.log(`  ${s.human.unread} unread for you — gang inbox`);
      return 0;
    }
    case "send": {
      const wake = bool("--wake");
      const [to, ...msg] = rest;
      const r = await api("/api/send", { to, body: msg.join(" "), wake });
      console.log(`sent #${r.id}${r.wake ? ` (${r.wake.method})` : ""}`);
      return 0;
    }
    case "wake": {
      const [to, ...reason] = rest;
      console.log((await api("/api/wake", { to, reason: reason.join(" ") })).note);
      return 0;
    }
    case "inbox": {
      const s = await stateFor();
      for (const m of [...s.human.messages].reverse().slice(-20)) console.log(`${m.read_at ? " " : "•"} #${m.id} ${m.from_agent}${m.kind !== "msg" ? ` [${m.kind}]` : ""}: ${m.body}`);
      await api("/api/read", {});
      return 0;
    }
    case "run": {
      const owner = flag("--as") ?? process.env.GANG_AGENT ?? "human";
      const name = flag("--name");
      const notify = flag("--notify");
      const i = rest.indexOf("--");
      const argv = i >= 0 ? rest.slice(i + 1) : rest;
      if (!argv.length) { console.error("usage: gang run [--as agent] -- <cmd…>"); return 1; }
      const env: Record<string, string> = {};
      for (const k of ["PATH", "VIRTUAL_ENV", "CONDA_PREFIX", "CONDA_DEFAULT_ENV", "PYTHONPATH", "HOME", "LANG"]) if (process.env[k]) env[k] = process.env[k]!;
      const r = await api("/api/job/start", { owner, name, notify, cmd: argv.join(" "), cwd, env });
      console.log(`job #${r.id} started (owner ${owner}); log: ${r.log_path}${owner === "human" ? "" : `\n${owner} will be notified when it finishes.`}`);
      return 0;
    }
    case "jobs": {
      const s = await stateFor();
      for (const j of s.jobs) console.log(`#${j.id} ${j.status.padEnd(9)} ${j.owner.padEnd(12)} ${j.progress ?? ""} ${j.name}`);
      return 0;
    }
    case "logs": await client.ensureDaemon(); console.log((await client.getJson(`${HUB_URL}/api/job/log?id=${rest[0]}&lines=${rest[1] ?? 100}`)).log); return 0;
    case "kill": console.log((await api("/api/job/kill", { id: Number(rest[0]) })).ok ? "killing" : "not running"); return 0;
    default: console.log(HELP); return cmd ? 1 : 0;
  }
}

main().then((code) => { if (code >= 0) process.exit(code); }, (e) => { console.error(`gang: ${e.message}`); process.exit(1); });
