#!/usr/bin/env python3
"""Auto-drives the desktop spike: watches hook events and queues test messages.

Per runtime:
  - first PostToolUse  -> queue INJECT-TEST (should be delivered at the next tool call)
  - first Stop (after inject delivered or 60s) -> wait 20s, queue WAKE-TEST
Runs for up to 45 minutes. Writes progress to ~/.gang-spike/log/driver.log
"""
import json
import os
import time

STATE = os.path.expanduser("~/.gang-spike")
EVENTS = os.path.join(STATE, "log", "events.jsonl")
OUT = os.path.join(STATE, "log", "driver.log")


def say(msg):
    line = f"{time.strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    with open(OUT, "a") as f:
        f.write(line + "\n")


def queue(runtime, text):
    os.makedirs(os.path.join(STATE, "inbox"), exist_ok=True)
    with open(os.path.join(STATE, "inbox", f"{runtime}.txt"), "w") as f:
        f.write(text)
    say(f"queued for {runtime}: {text}")


st = {r: {"inject_q": False, "wake_q": False, "stop_at": None} for r in ("claude", "codex")}
pos = os.path.getsize(EVENTS) if os.path.exists(EVENTS) else 0
say(f"driver started at offset {pos}")
end = time.time() + 45 * 60
while time.time() < end:
    if os.path.exists(EVENTS):
        with open(EVENTS) as f:
            f.seek(pos)
            for line in f:
                try:
                    e = json.loads(line)
                except json.JSONDecodeError:
                    continue
                r, ev = e.get("runtime"), e.get("event")
                if r not in st:
                    continue
                s = st[r]
                if "delivered" in e:
                    say(f"{r}: DELIVERED via {ev}: {e['delivered']}")
                    continue
                say(f"{r}: {ev} {e.get('mode', '')}")
                if ev == "PostToolUse" and not s["inject_q"]:
                    s["inject_q"] = True
                    queue(r, "INJECT-TEST from teammate: include the word 'pineapple' in your final answer.")
                if ev == "Stop" and not s["wake_q"] and s["stop_at"] is None:
                    s["stop_at"] = time.time()
            pos = f.tell()
    for r, s in st.items():
        if s["stop_at"] and not s["wake_q"] and time.time() - s["stop_at"] > 20:
            s["wake_q"] = True
            queue(r, f"WAKE-TEST from teammate at {time.strftime('%H:%M:%S')}: reply with the word 'awake' and nothing else.")
    time.sleep(1)
say("driver finished")
