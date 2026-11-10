# gang-gang: research notes, architecture, MVP

_Researched 2026-11-09. Local versions: Claude Code 2.1.235, codex-cli 0.146.0, Codex desktop (bundled in ChatGPT.app 157.x)._

## 0. Decisions so far (2026-11-09)

- Local and single-user on macOS. Agents last minutes to hours, never more than a day. 3–5 agents.
- **Desktop-first.** Agents mostly run in the Codex desktop app and the Claude desktop Code tab. The CLI is optional. That makes desktop wake-up a core problem rather than an edge case, and moves the dashboard into Phase 1.
- The user is the lead. Agents message, ask, delegate and record decisions. They never merge, push, or start agents (or subagents) unless told to.
- The user starts each agent and introduces the agents to each other. Peers talk directly. Transcripts are readable on request; the default view is a summary.
- **Nothing is written into the repo.** State goes in `~/.gang/projects/<repo-id>/` and worktrees in `~/.gang/worktrees/<repo>/<agent>`. Hooks and MCP servers are installed at the user level, and do nothing in sessions that haven't joined the team. The tool must work on other people's repos without touching `.gitignore`.
- **Wake-ups:** any agent may wake another. Waking is a separate, deliberate `wake(agent, reason)` call, not a side effect of `send`. It is rate-limited and needs a reason. Every wake-up shows on the dashboard and as a macOS notification.
- The first use case is research: planning and designing experiments, running jobs, and reviewing. The user works on their own branch, so worktree policy is set per project rather than fixed.
- Codex can be upgraded to ≥0.149.
- **On-call mode is approved.** When an agent finishes a turn, a `Stop` hook blocks and waits on the hub for a wake-up. The waiting is a sleeping hook process, so the model isn't called and no tokens are spent until a message arrives. The dashboard shows these states separately: `working` · `on-call (waiting)` · `asleep (needs you to wake)` · `waiting for permission` · `offline`. The on-call window is limited by the hook's maximum timeout (spike will measure). Once it runs out, the agent goes `asleep`.
- **No automatic screen takeover.** Typing into the desktop app happens only after the user approves it each time in the dashboard. The default fallback for an `asleep` agent is a notification, and the user wakes it by hand.
- **Jobs are in the MVP.** Agents launch long-running jobs through the hub and keep working. The hub tracks status, exit code, logs, and progress where it can parse it. When a job finishes or fails, the hub messages the agent that started it and wakes it. Those wake-ups still show on the dashboard but don't count toward the rate limit. Local jobs come first; remote/SLURM/SSH later.
- **Goal:** agents coordinate on their own as much as possible. The user never relays messages or checks for finished work; the dashboard gives full visibility and control; the desktop apps stay the main interface.

## 1. TL;DR

- **Parallel sessions, worktrees, and dashboards are already solved** (Conductor, Claude Squad, Codex desktop, Claude Code desktop). Don't rebuild them.
- **Cross-agent messaging is partly solved, but only inside one vendor.** Claude Code *agent teams* gives you a mailbox and a shared task list for Claude only. `mcp_agent_mail` is a vendor-neutral MCP mailbox. Nothing combines vendor-neutral messaging, **transcript inspection**, and **waking an idle agent**.
- **The hard part is delivery, not storage.** Any agent can call an MCP tool to read its inbox. The hard part is getting a message *into* an agent that is idle or busy without you relaying it. Every runtime does this differently, and Codex desktop has the fewest options.
- **Proposal: a small local "bus" daemon** with three pieces: (1) one MCP server every agent mounts; (2) per-runtime **hooks** that register sessions, inject unread messages, and enforce file reservations; (3) **transcript observers** that tail the JSONL logs both CLIs already write. The agents keep running in their normal CLI or desktop apps. The harness only observes, routes, and nudges. It does not own the agent loop.

## 2. Landscape: what already exists

| Tool / API | What it solves | Gap for us |
|---|---|---|
| **Claude Code agent teams** (experimental, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`) | Lead spawns teammates; per-agent mailbox, shared task list with owners and deps, direct messaging. State in `~/.claude/teams/`, `~/.claude/tasks/`. | Claude only. Teammates are spawned by a lead, not existing sessions you started yourself. Experimental. **Worth copying its data model.** |
| **mcp_agent_mail** (Python, with a Rust rewrite) | Vendor-neutral MCP mailbox: agent identities, inbox/outbox, threads, advisory file reservations (path globs plus TTL), stored in Git and SQLite. Works with Claude Code, Codex, and Gemini. | No transcript inspection, no wake-up (agents must poll), no awareness of runtime state. Heavier than we need. **Closest prior art for the bus. Borrow its tool design, or adopt it in Phase 1.** |
| **Conductor, Claude Squad, Emdash, Superset, Nimbalyst** | Run N agents in worktrees with a dashboard or tmux UI. | Agents can't see or talk to each other; you relay everything. (Reported: Vibe Kanban sunset, Crystal deprecated → Nimbalyst.) |
| **Codex app-server** (JSON-RPC 2.0; stdio, unix socket, ws marked experimental) | Full programmatic control: `thread/list`, `thread/read`, `thread/items/list`, `thread/resume`, `turn/start`, **`turn/steer`** (inject into a running turn), `turn/interrupt`. TS bindings via `codex app-server generate-ts`. | Each client normally spawns its **own private** app-server. See §3. |
| **Codex app-server daemon + `codex --remote`** | `codex app-server daemon start` runs a shared local daemon, and a TUI can attach with `--remote unix://…`. Newer versions (0.149+, blog-sourced) add `codex agents` (session dashboard) and `codex queue --session X "msg"` (inject a message into an idle or busy session). | You're on 0.146; `queue` needs an upgrade. Multi-client semantics on one thread aren't documented. |
| **Codex hooks** (`hooks` feature **stable and enabled** on your install) | `SessionStart`, `UserPromptSubmit`, `Stop`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, compaction and subagent events. `~/.codex/hooks.json` or `<repo>/.codex/hooks.json`. Config is shared across CLI, IDE, and desktop. | Hooks only fire while a thread is active, so they can't wake an idle thread. |
| **Claude Code hooks** | Same lifecycle set, plus `additionalContext` injection; `Stop` can return `decision: block` to keep the agent working. Input includes `session_id`, `transcript_path`, `cwd`. | Same idle-wake limitation. |
| **Claude Code channels** (research preview, ≥2.1.80) | An MCP server **pushes events into a running session**: real wake-up for idle agents. Two-way via a reply tool. | Needs claude.ai login and the `--channels` flag, and is preview-only. Works for CLI sessions; don't assume it works in the desktop Code tab. |
| **Claude Agent SDK** (TS/Py) | Headless sessions you own: streaming input, `resume`, `forkSession`, programmatic hooks. Transcripts in `~/.claude/projects/<encoded-cwd>/<id>.jsonl`. | SDK-owned sessions aren't your interactive CLI. Fine as an optional "managed" mode later. |
| **ACP (Agent Client Protocol, Zed)** | One JSON-RPC protocol to drive many agents via adapters (Claude via the Agent SDK, `codex-acp`, and others). | The ACP client owns the session, so this replaces the CLI/desktop rather than integrating with it. Good later as a uniform "managed runtime" driver, not needed for the MVP. |
| **A2A, big frameworks** (claude-flow, etc.) | Agent-to-agent RPC, swarms. | Too heavy, and they own the loop. Skip. |

## 3. Integration constraints

### Codex desktop (the tightest constraint)
Observed on this machine: the Codex desktop app runs inside `ChatGPT.app`, and every client (desktop, VS Code extension) spawns its **own private stdio `codex app-server`**. There is no external endpoint to attach to. Community reports agree that the desktop app doesn't accept an external app-server.

What still works for desktop threads:
- **Observe:** rollouts persist to `~/.codex/sessions/**/rollout-*.jsonl` and are indexed in `~/.codex/state_5.sqlite` / `session_index.jsonl`. Tail them read-only. ✅
- **Tools:** desktop reads `~/.codex/config.toml`, so an MCP server registered there gives desktop threads the bus tools. ✅
- **Hooks:** global hooks are shared, so desktop threads can register, receive inbox injections on `UserPromptSubmit` and `PostToolUse`, and enforce reservations on `PreToolUse`. ✅ (verify in spike)
- **Wake an idle desktop thread from outside:** ❌ no supported path. Fallbacks: the dashboard flags "unread for N min" and you click into the thread, or you accept that desktop agents check the inbox at turn boundaries. Possible later hack: the `Stop` hook blocks while unread messages exist, so the agent keeps working instead of going idle (verify that Codex honors a block on `Stop`).
- **Recommendation:** use **Codex CLI attached to the shared daemon** (`codex --remote`) for agents that must be wakeable. Use desktop for agents you drive personally.

### Codex CLI
Best-integrated path: run `codex app-server daemon`, and launch TUIs with `codex --remote unix://…`. The bus connects to the same daemon and calls `turn/start` (idle) or `turn/steer` (busy) to deliver messages. You still see everything in the real TUI. **Spike #1:** confirm that a second client can `thread/resume` and `turn/start` on a thread the TUI is showing, and that the TUI renders it. If that fails, upgrade to ≥0.149 and use `codex queue`, or fall back to `tmux send-keys`.

### Claude Code CLI
- Delivery while busy: `PostToolUse` / `UserPromptSubmit` hooks return `additionalContext` with unread messages.
- Delivery while idle: a **channel** (the bus is itself a channel MCP server), or `tmux send-keys` as the fallback.
- Identity: the `SessionStart` hook POSTs `session_id`, `transcript_path`, `cwd`, and `$GANG_AGENT` to the bus.

### Claude Code desktop (this app)
Hooks and MCP from `~/.claude/settings.json` / `.mcp.json` apply, so desktop sessions can join the bus. Treat idle wake-up as unsupported, same as Codex desktop. The desktop app's own inter-session messaging is internal; don't build on it.

### Universal
- Agents only "know" what's in their context. **Push summaries, not transcripts.** Inspecting another agent should return a compact digest (status, plan, findings, files touched, last N tool calls), with raw transcript paging available on request.
- Transcript formats are undocumented and change between versions. Isolate parsing in one adapter per runtime, and keep those adapters lenient.
- Hooks run on every tool call. Keep them under ~50 ms: one localhost HTTP call, and fail open if the bus is down.

## 4. Proposed architecture

```
                 ┌──────────────── you ────────────────┐
                 │  dashboard (web)   ·   `gang` CLI    │
                 └───────────────┬──────────────────────┘
                                 │ HTTP/SSE
┌────────────────────────────────▼─────────────────────────────────┐
│ gangd (one local daemon, SQLite WAL)                             │
│  store: agents · sessions · messages · tasks · decisions ·       │
│         findings · reservations · events(normalized transcript)  │
│  ├─ MCP server (streamable HTTP, localhost) ← every agent        │
│  ├─ hook endpoint  /hook/{runtime}/{event}  ← every agent's hooks │
│  ├─ observers: tail ~/.claude/projects/**.jsonl,                 │
│  │             ~/.codex/sessions/**/rollout-*.jsonl → events     │
│  └─ deliverers: codex-daemon(turn/start|steer) · claude-channel ·│
│                 tmux send-keys · hook-injection (always)         │
└──────────────────────────────────────────────────────────────────┘
      ▲            ▲              ▲                 ▲
  claude CLI   claude desktop  codex CLI(--remote)  codex desktop
  (tmux pane)                  (tmux pane)
  each in its own git worktree when it writes code
```

### Data model (deliberately small)
- `agent(name, role, runtime, surface: desktop|cli, worktree, branch, status, session_id, transcript_path, last_seen)`. Status comes from hooks: `working | on_call | asleep | waiting_permission | offline`.
- `message(id, from, to|"*", thread_id, kind: msg|question|answer|finding|handoff, body, refs[], created, read_at)`.
- `wake(id, from, to, reason, at, method: on_call|codex_daemon|channel|notify|ui_approved, outcome)`: every wake-up is logged and shown.
- `job(id, owner_agent, cmd, cwd, pid, status: running|succeeded|failed|killed, exit_code, log_path, progress, started, ended, notify: wake|message|none)`.
- `task(id, title, owner, status, depends_on[], worktree, notes)`, modeled on agent teams' task list.
- `decision(id, title, body, decided_by, supersedes)`: an append-only ADR log, injected at `SessionStart`.
- `reservation(agent, glob, exclusive, expires)`: advisory, enforced softly by `PreToolUse` (deny the edit with an explanation).
- `event(agent, ts, kind: user|assistant|tool_call|tool_result|file_edit, summary, raw_ref)`, derived by the observers.

### MCP tools (same for every runtime)
`register(name, role)` · `agents()` · `inspect(agent, view=digest|events|transcript, since)` · `send(to, body, kind, thread?)` (never wakes) · `wake(agent, reason)` (deliberate, rate-limited, always visible) · `inbox(unread_only)` · `ask(to, question)` → returns a thread id; the answer arrives via the inbox or an injection. Never block. · `post_status(text)` · `post_finding(text, refs)` · `job_start(cmd, cwd, notify)` / `job_status(id)` / `job_logs(id, tail)` / `job_kill(id)` · `tasks.list/create/claim/update` · `decide(title, body)` · `reserve(globs, ttl)` / `release`.

### Delivery and wake-up (desktop-first)
1. **Always persist first.** Delivery is best-effort, with `read_at` tracking.
2. **Recipient `working`:** hook injection on its next tool call (all surfaces). Delivery only, no wake-up needed.
3. **Recipient `on_call`:** its `Stop` hook is long-polling the hub. A `wake` (or a job finishing) returns `decision: block` with the message, and the agent continues. Zero tokens while it waits.
4. **Recipient `asleep`** (on-call window ran out, or the user stopped it): a macOS notification and a dashboard badge. You open the thread and type anything (or "check gang inbox"); the `UserPromptSubmit` hook injects the pending messages. Optional: typing into the app after you click Approve on the dashboard. Never automatic.
5. **CLI sessions** additionally get real wake-ups: the Codex daemon's `turn/start` / `codex queue`, and Claude channels.
6. **Plain `send` never wakes anyone.** Only `wake()` and job completion do. Rate limit: N wake-ups per agent per hour (default 4); job wake-ups are exempt but still shown.

### Jobs
- An agent calls `job_start` (or runs `gang run --agent X -- python train.py` in its shell). The hub starts the job detached, with its own process group, outside the agent's turn. Output goes to `~/.gang/projects/<repo>/jobs/<id>.log`.
- Progress: tail the log; optional per-project regexes (e.g. `epoch (\d+)/(\d+)`, tqdm bars, a `GANG_PROGRESS` line protocol).
- On exit: record the exit code and the last N log lines, message the owner, and wake it (on-call → continues immediately; asleep → notification).
- Dashboard: a job list with status, elapsed time, progress, a live log, kill, and "wake owner".
- Later: remote jobs over SSH or SLURM (`sbatch` plus `squeue`/`sacct` polling) behind the same `job` interface.

### Roles and worktrees
- **Nothing is written into the repo.** State lives in `~/.gang/projects/<repo-id>/` (DB, role prompts, job logs). Hooks and MCP are installed at the user level (`~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.codex/config.toml`) and do nothing in sessions that haven't joined.
- **Joining:** you tell a desktop session "you are `planner-1` on gang `<project>`" (or paste a one-line join prompt from the dashboard). It calls `register`, and the hub binds its `session_id`.
- **Worktrees per project:** for research on your own branch, agents share your checkout and use reservations. Implementers you set loose get `~/.gang/worktrees/<repo>/<agent>` on branch `gang/<agent>`, or use Codex desktop's built-in worktrees, which the hub detects from `cwd`.
- **Integration:** you merge. The hub never merges or pushes.
- Role prompts in `~/.gang/projects/<repo>/roles/*.md` are injected by the `SessionStart` / `register` response, so the repo's `CLAUDE.md`/`AGENTS.md` are never edited.

## 5. MVP

### Phase 0: spikes (about 1 day; desktop-first order)
1. **On-call in Codex desktop:** do global hooks fire in desktop threads? Does a long-blocking `Stop` hook work, and what's the max timeout? Does returning `block` plus a reason continue the turn? How does the desktop UI look while the hook waits?
2. **On-call in the Claude desktop Code tab:** same questions.
3. **MCP in desktop:** do the user-level MCP configs reach desktop sessions in both apps? Do hook payloads include `session_id`, `transcript_path`, `cwd`?
4. **Transcript parsers:** map one real Claude JSONL and one Codex rollout (from desktop sessions) into the `event` schema.
5. *(CLI, lower priority)* Codex daemon multi-client `turn/start`, `codex queue` after upgrading; Claude channels.

### Phase 1: MVP (about 1–1.5 weeks, TypeScript)
- `gangd`: SQLite store, MCP server, hook endpoint, observers, deliverers (hook injection, on-call long-poll, notifications), and the job runner.
- `gang init` installs the user-level hooks and MCP (with a backup, and `gang uninstall` to remove them). Hooks are fail-open and no-ops for unregistered sessions.
- **Web dashboard** (localhost): agent cards with clear states (working / on-call / asleep / permission), a per-agent timeline, message threads, a wake-up log, the job list with live logs, "send as human", "wake", and the approve-UI-typing button.
- Messaging, `wake`, inspection, findings, status, jobs.
- Success test: planner A (Claude desktop) launches a 10-minute job and asks implementer B (Codex desktop) a question. B, on call, answers without you. When the job finishes, A wakes up and reads the result. The whole sequence shows on the dashboard, and you type nothing in between.

### Phase 2: coordination
Tasks with deps, the decision log with `SessionStart` injection, reservations enforced by `PreToolUse`, auto-digests (a cheap model summarizes each agent's recent events into its status).

### Phase 3: optional
Remote jobs (SSH/SLURM); managed headless runtimes via the Agent SDK, Codex app-server, or ACP; more runtimes (Gemini, opencode).

### Build vs adopt
- Adopt `mcp_agent_mail` as the message store if you want to skip writing the MCP mailbox. You'd still write the observers, hooks, delivery, and UI, which is most of the value. My lean: **write the bus yourself** (a few hundred lines on SQLite) because inspection, delivery, and status all share one schema, and borrow agent_mail's tool naming and reservation semantics.
- Don't adopt Conductor or Squad as the base. They own session launching in ways that conflict with "use the real CLI/desktop", and they add no communication layer.

## 6. Risks
- **Undocumented formats** (transcripts, Codex daemon multi-client) can break on upgrades. Mitigate with version checks in `gang doctor` and lenient parsers.
- **Context pollution:** chatty agents flood each other. Mitigate with digest views, per-agent unread caps, and `kind`-based filtering (findings vs chatter).
- **Desktop apps can't be woken** externally. Accept this and surface it in the UI.
- **Preview features** (Claude channels, Codex `--remote` ws) may change. Always keep tmux and hook injection as the floor.

## Sources
- Codex app-server: https://developers.openai.com/codex/app-server · Codex hooks: https://developers.openai.com/codex/hooks · Codex app: https://developers.openai.com/codex/app
- Codex surfaces and sessions (community): https://codex.danielvaughan.com/2026/04/08/four-surface-architecture/ · https://codex.danielvaughan.com/2026/08/29/codex-cli-v0149-multi-session-agents-dashboard-codex-queue-working-directory/ · https://codex.danielvaughan.com/2026/08/18/codex-cli-desktop-integration-patterns-handoff-worktrees-parallel-agents-linux-preview/
- Claude Agent SDK sessions: https://code.claude.com/docs/en/agent-sdk/sessions
- Agent teams (community write-ups): https://dev.to/nwyin/reverse-engineering-claude-code-agent-teams-architecture-and-protocol-o49 · https://www.morphllm.com/claude-code-agent-teams
- Channels: https://www.atcyrus.com/stories/what-are-claude-code-channels · https://claude-almanac.pages.dev/docs/channels
- mcp_agent_mail: https://github.com/Dicklesworthstone/mcp_agent_mail
- ACP: https://www.morphllm.com/agent-client-protocol · https://ai-sdk.dev/providers/community-providers/acp
- Tool landscape: https://nimbalyst-website.pages.dev/blog/best-multi-agent-coding-tools-2026/ · https://agentsroom.dev/blog/best-multi-agent-coding-tools
