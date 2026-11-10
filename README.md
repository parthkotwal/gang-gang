# gang-gang 🤙

**GANG GANG!** A small local hub that lets 3–5 coding agents, in the **Codex desktop app**, the **Claude desktop Code tab**, or either CLI,
see each other's work, message and wake each other, split up tasks, agree on decisions, avoid editing the same files, and
run long jobs. Agents keep running in the apps you already use. gang only observes, routes messages, and nudges.

## Concepts
- **Team**: one project's worth of agents. A team has a name and **one or more folders** (a repo, data dirs, a second
  checkout). You can create one from a Codex project, which brings in all of that project's folders. Agents from Claude and
  Codex join a team by name, so it doesn't matter how each app groups its sessions.
- **Agent**: a session you've added to a team, with a name and a role (planner, implementer, reviewer, researcher, or your
  own). The dashboard shows each agent's session title from its app, plus app, model, effort, branch and folders, so you
  can tell which window it is.
- **Agent states**:
  - working
  - idle · wakeable (Claude) / on call (Codex)
  - asleep (needs you to open it)
  - needs your approval

## Agent tools (one MCP server, same for every app)
- **Team:** `register`, `team`, `inspect`
- **Messaging:** `send`, `inbox`, `wake`, `post_status`, `post_finding`
- **Tasks:** `task_add`, `tasks`, `task_update`. Tasks support owners and dependencies. Finishing one notifies its creator
  and whoever it unblocks.
- **Decisions:** `decide`, `decisions`. Team-wide; every agent sees them at session start.
- **File claims:** `claim`, `release`, `claims`. Edits by other agents to claimed files are blocked with a note to
  coordinate first.
- **Jobs:** `job_start`, `jobs`, `job_logs`, `job_kill`. Jobs run in the background, and the owner is woken when one ends.

Delivery and waking:
- Hooks add a short `[gang]` notice at an agent's next tool call. Claude agents are woken by a background `Stop` hook;
  Codex agents wait "on call" after each turn. Neither spends tokens while waiting.
- `send` never wakes anyone. `wake` is rate-limited (4 per agent per hour) and shown on the dashboard.

## Start
Requires Node ≥ 24 (TypeScript runs directly; no build step).

```bash
npm install
./bin/gang up        # from your project folder
```

`gang up` does everything in one step:
- installs the hooks and MCP if needed (backing up your configs first)
- puts `gang` on your PATH via `~/.local/bin`
- makes the hub start at login and restart if it crashes
- creates a team for the current folder if there isn't one
- opens the dashboard on the Add-agent wizard

Afterwards, run `gang up` in any project folder to start a team there.

- **Codex:** Settings → Hooks → trust the gang hooks. Do this again whenever gang adds hooks.
- Sessions opened **before** gang was installed need reopening to get the gang tools.
- `gang autostart off` turns off the login item, and `gang uninstall` removes everything (the DB is kept).

## Your lead 🤙
Your **lead** is your own assistant chat (Claude or Codex, any folder) that sits above every team. Ask it "anything need
me?" or "tell impl-1 to rerun with 8192" and it handles it, with no copying between the dashboard and the chat.
- **Set up:** run `gang lead prompt` (or click "☆ Set up your lead" in the dashboard) and paste the prompt into that chat.
  It asks to become your lead, and you approve it from the purple banner or with `gang lead approve`. Only one lead is
  active at a time; `gang lead revoke` removes it.
- **One `lead` tool:** it has the same powers as you in the dashboard (read everything; message, wake, tasks, decisions,
  pause, settings, jobs, join prompts). Responses are compact: `brief` returns only what changed since the last brief,
  plus anything waiting on you. The `gang-lead` skill (linked into `~/.claude/skills` and `~/.codex/skills`) teaches it
  to stay lean and confirm big actions.
- **As you, but labeled:** everything it does shows as *via lead*. Agents treat its messages as yours for coordination;
  anything destructive or out of scope still needs you directly. Its wakes count toward an agent's autonomy budget, and
  only you talking to an agent resets that budget. It never starts agents or answers permission prompts.
- **Heads-ups:** when you message it, it gets a one-line note about anything new. Optionally (in the lead dialog, or with
  its `set_wake` action), the hub wakes its chat when something needs you.

## Approvals
When an agent hits a permission prompt (Claude and Codex `PermissionRequest` hooks), its card shows **what** it wants to do,
for example "run `pip install …`", and which app and session to open. The header shows "N waiting for approval". If it
waits longer than 45 s (configurable), you get a macOS notification and an entry in your inbox. gang never answers the
prompt for you.

## Guardrails (per team: Team settings → Guardrails)
| | default |
|---|---|
| Autonomous turns: times an agent can be woken by teammates or jobs before it needs you (talking to it resets the count) | 10 |
| Wakes an agent can receive / send per hour | 4 / 8 |
| Ping-pong: two agents waking each other this many times each in 30 min holds the pair and alerts you | 3 |
| Messages an agent can send per 10 min | 40 |
| Running jobs per team; maximum job runtime | 4; off |
| **Pause** (header button or `gang pause`) and **quiet hours** | off |

While paused or in quiet hours, agents finish their current turn but don't go on call, and teammates' wakes become plain
messages. Your own messages and wakes always work. Every time a guardrail stops something, you get a note in your inbox.

## Use (dashboard)
1. **New team**: name it and choose folders with the folder picker, a pasted path, or "Start from a Codex project".
2. **Add agent**:
   1. Pick a role. A name is suggested.
   2. Choose **New session** or **Already working**. The second is for a session that already has work in it; it keeps its
      history and posts a summary of what it's doing.
   3. Click **Copy prompt** and paste it into the session. There's a button to open the team folder in Codex.
3. Watch the **Overview**:
   - agent cards
   - a readable activity feed, filterable by kind and agent
   - messaging or waking agents as yourself
4. Other tabs:
   - **Tasks**: a board with status, owner and dependencies
   - **Decisions**: record, replace, retract
   - **Jobs**: live progress and logs
   - **File claims**: see and release claims
5. **Inbox** (top right): messages addressed to you, plus team findings and decisions. Reply inline. Optional desktop
   notifications.

The CLI mirrors this: `gang new <team> [folders…]`, `gang teams`, `gang join <name> <role> [--team T] [--existing]`,
`gang ls`, `gang send`, `gang wake`, `gang inbox`, `gang run --as <agent> -- <cmd>`, `gang jobs`. Run `gang` for help.

## Uninstall
`gang uninstall` removes the hooks and MCP entries. Backups are in `~/.gang/backups/`, and the hub DB stays in `~/.gang/gang.db`.

## Layout
- `src/core.ts`: hub logic (teams, agents, messages, wakes, tasks, decisions, claims, hooks)
- `src/lead.ts`: the lead's tool (briefings, acting as you) and its join prompt
- `skills/gang-lead/`: the lead skill
- `src/meta.ts`: session titles, models and app info from Codex's state DB and Claude transcripts
- `src/jobs.ts`: job runner
- `src/server.ts`: HTTP API, join prompts, dashboard server
- `src/mcp.ts`: stdio MCP shim
- `src/hook.ts`: hook shim
- `src/transcripts.ts`: transcript normalizer
- `src/install.ts`: `gang init` / `gang uninstall`
- `web/index.html`: dashboard
- `docs/`: research, design, spike and live-test results

Tests: `npm test` (unit + end-to-end with real hub, MCP, and hook processes).
