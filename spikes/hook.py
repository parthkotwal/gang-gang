#!/usr/bin/env python3
"""Phase 0 spike hook for Claude Code and Codex.

Usage (from hook config):  hook.py <runtime> <event> [mode] [wait_seconds]
  runtime: claude | codex
  event:   SessionStart | UserPromptSubmit | PostToolUse | Stop
  mode:    for Stop only:
             oncall  -> block (sync) until a message arrives or wait expires,
                        then return {"decision":"block","reason":msg}
             rewake  -> (Claude asyncRewake) wait in background; on message
                        print it to stderr and exit 2 to wake the session

Only acts when the session cwd is inside ~/gang-spike; otherwise exits 0
immediately so other sessions are unaffected.

Messages: write text to ~/.gang-spike/inbox/<runtime>.txt (see send.py).
Logs:     ~/.gang-spike/log/events.jsonl and heartbeat.jsonl
"""
import json
import os
import signal
import sys
import time

HOME = os.path.expanduser("~")
SPIKE_CWD = os.path.realpath(os.path.join(HOME, "gang-spike"))
STATE = os.path.join(HOME, ".gang-spike")
LOG_DIR = os.path.join(STATE, "log")
INBOX_DIR = os.path.join(STATE, "inbox")


def log(name, rec):
    os.makedirs(LOG_DIR, exist_ok=True)
    rec = {"ts": time.time(), "iso": time.strftime("%H:%M:%S"), **rec}
    with open(os.path.join(LOG_DIR, name), "a") as f:
        f.write(json.dumps(rec) + "\n")


def take_message(runtime):
    path = os.path.join(INBOX_DIR, f"{runtime}.txt")
    try:
        with open(path) as f:
            msg = f.read().strip()
    except FileNotFoundError:
        return None
    os.remove(path)
    return msg or None


def main():
    runtime, event = sys.argv[1], sys.argv[2]
    mode = sys.argv[3] if len(sys.argv) > 3 else ""
    wait = int(sys.argv[4]) if len(sys.argv) > 4 else 600
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        payload = {"_unparsed": raw[:2000]}

    cwd = os.path.realpath(payload.get("cwd") or os.getcwd())
    if not (cwd == SPIKE_CWD or cwd.startswith(SPIKE_CWD + os.sep)):
        return 0

    slim = {k: (v if len(json.dumps(v)) < 400 else f"<{len(json.dumps(v))} chars>")
            for k, v in payload.items()}
    log("events.jsonl", {"runtime": runtime, "event": event, "mode": mode,
                         "pid": os.getpid(), "ppid": os.getppid(), "payload": slim})

    if event in ("UserPromptSubmit", "PostToolUse", "SessionStart"):
        msg = take_message(runtime)
        if msg:
            log("events.jsonl", {"runtime": runtime, "event": event, "delivered": msg})
            print(json.dumps({"hookSpecificOutput": {
                "hookEventName": event,
                "additionalContext": f"[gang] New message for you: {msg}"}}))
        return 0

    if event == "Stop":
        start = time.time()
        sid = payload.get("session_id")

        def on_term(signum, _frame):
            log("heartbeat.jsonl", {"runtime": runtime, "mode": mode, "sid": sid,
                                    "killed_by_signal": signum,
                                    "elapsed": round(time.time() - start, 1)})
            sys.exit(0)

        signal.signal(signal.SIGTERM, on_term)
        signal.signal(signal.SIGHUP, on_term)
        last_beat = 0.0
        while time.time() - start < wait:
            msg = take_message(runtime)
            if msg:
                elapsed = round(time.time() - start, 1)
                log("heartbeat.jsonl", {"runtime": runtime, "mode": mode, "sid": sid,
                                        "woke_with": msg, "elapsed": elapsed})
                text = f"[gang] Woken by a teammate message: {msg}"
                if mode == "rewake":
                    sys.stderr.write(text + "\n")
                    return 2
                print(json.dumps({"decision": "block", "reason": text}))
                return 0
            if time.time() - last_beat >= 10:
                last_beat = time.time()
                log("heartbeat.jsonl", {"runtime": runtime, "mode": mode, "sid": sid,
                                        "waiting": round(last_beat - start, 1)})
            time.sleep(1)
        log("heartbeat.jsonl", {"runtime": runtime, "mode": mode, "sid": sid,
                                "expired_after": wait})
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
