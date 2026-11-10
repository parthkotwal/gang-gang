# Phase 0 spike results (2026-11-09)

Setup: temporary user-level hooks (`spikes/hook.py`) and a stdio MCP server (`spikes/mcp_ping.py`), active only in `~/gang-spike`. A driver (`spikes/driver.py`) queued messages automatically. One session each in **Codex desktop** (Codex 0.167.0-alpha) and the **Claude desktop Code tab** (Claude Code 2.1.321).

## Verdict: desktop-first works

| Capability | Codex desktop | Claude desktop | How |
|---|---|---|---|
| User-level MCP tools reach desktop sessions | ✅ | ✅ | `~/.codex/config.toml` `[mcp_servers]`; `claude mcp add -s user` |
| Hooks fire in desktop sessions | ✅ (after one-time trust) | ✅ | `~/.codex/hooks.json`; `~/.claude/settings.json` |
| Session identity in hook payload | ✅ `session_id`, `cwd`, `transcript_path` | ✅ same | every hook |
| Deliver a message mid-turn | ✅ arrives as a developer message; agent followed it | ⚠️ delivered, but **the agent rejected it as prompt injection** | `PostToolUse` / `SessionStart` `additionalContext` |
| **Wake an idle agent** | ✅ on-call: a blocking `Stop` hook returned `{"decision":"block","reason":…}`; replied "awake" 4 s later | ✅ **true idle wake**: `Stop` hook with `async` + `asyncRewake` exited 2; replied "awake". Session looked idle while waiting | see below |
| Cost while waiting | 0 tokens (a sleeping Python process) | 0 tokens | |
| Looks busy while waiting | yes (status "gang: on call"); you can stop it | **no** | |
| Transcripts parse into shared events | ✅ | ✅ | `spikes/normalize.py` |

## Findings that change the design

1. **Claude has a real wake-up; Codex needs on-call mode.** For Claude, use `Stop` → `async: true, asyncRewake: true`, whose timeout isn't enforced. The hook waits in the background on the hub and exits 2 with the message, so the agent never looks busy. For Codex, use a blocking `Stop` hook, which makes the thread look busy. A configured timeout above the 600 s default is honored (the wait ran past 683 s).
2. **Messages must be expected, or Claude will rightly refuse them.** An instruction that appears after a tool call with no earlier setup looks like prompt injection. Fix:
   - The user's first message or join prompt establishes the team: "You are `planner-1` on gang `X`; teammates are …; `[gang]` notices come from the hub."
   - Hooks inject only a **notice** ("2 unread from impl-1: call `gang.inbox()`"). The agent then fetches the content with an MCP tool call it chose to make, so it trusts the content more and it ends up in the transcript.
   - Wake-up text for `asyncRewake` / `Stop` follows the same pattern.
3. **Address messages by `session_id`, not by runtime or folder.** Codex desktop started a **hidden helper session** (`9dd0…`, no saved history) in the same folder. It ran the same hooks and grabbed the first wake-up. The hub must bind agent name → session_id at `register`, ignore unregistered sessions, and wake only the bound session.
4. **Codex hooks require trust tied to a hash of the hook.** Users trust hooks once in Settings → Hooks, and any change to the hook command means trusting again. So `gang init` installs a **stable thin shim** (`gang-hook <event>` → HTTP to the hub), and all logic lives in the hub.
5. **Codex desktop wraps tool calls in "code mode".** Its rollouts record `exec` JavaScript that calls `tools.exec_command(...)`, `tools.mcp__…(...)`. The normalizer has to unwrap these to show real tool names and commands.
6. Codex records wake-ups in its history as `<hook_prompt hook_run_id="stop:…">`. Claude records them as a "Stop hook feedback" notification. Both are easy to detect, so the dashboard can mark when an agent was woken.
7. Killing a Codex `Stop` hook with SIGTERM let the turn end cleanly. That's a safe way to cancel on-call.
8. The Claude CLI login has expired on this machine. That doesn't affect desktop use.

## Still open
- The longest Codex on-call wait the desktop app allows. **Measured: it ran past 683 s** (the default is 600 s), so a configured `timeout` above the default is honored. The real maximum is unknown. Design: set `timeout` to about 3600 s, and if it expires, mark the agent `asleep`.
- Claude `asyncRewake` across app restarts or long idle (hours) is untested.
- What a Codex user sees while on call, and whether typing a new message during the wait stops or queues the wait. Desktop setting `migratedFollowUpQueueToSteer = true` suggests typed input steers the turn.

## Cleanup
All spike hooks, the MCP registration, and the Codex hook-trust and `~/gang-spike` project-trust entries have been removed. `~/.claude/settings.json` is identical to the backup. `~/.codex/config.toml` differs from the backup only by a marketplace refresh Codex made itself. Backups remain in `~/.gang-spike/backup/`.

## Phase 1 live test (2026-11-09, ~/gang-test)
Claude desktop `planner-1` and Codex desktop `impl-1`, with the user typing only the join prompts plus one approval.
- ✅ Codex registered with session binding via `_meta`, went on call, and was **woken by planner-1 from another app** in under 1 s. It read its inbox, checked `config.py`, and answered (flagging CONTEXT_LENGTH 4096 vs 8192), all without the user.
- ✅ Claude bound its session via the register `PostToolUse` hook. It was **woken by the hub when job #2 finished** (asyncRewake) and read the result from its inbox.
- ✅ Dashboard showed states, wakes, jobs with progress, and both timelines.
- 🐛 Job #1 reported "failed (exit 3)" instantly: unit tests had leaked a stale `1.exit` into the real `~/.gang/jobs` (a hoisted import ran before `GANG_HOME` was set). Fixed in the tests, and the job runner now clears leftover exit/log files on start.
- Observations, now addressed in tool descriptions: the planner sent its question **and** a wake (duplicate message), so `wake` now says the reason *is* the message. After the bad job #1 report, the planner polled job #2's log in a loop instead of relying on the wake, so `job_start` now says not to poll.
- The planner asked the user before editing `config.py` (the user said "update and rerun"). That's the intended peer-vs-user boundary.
