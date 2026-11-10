#!/usr/bin/env python3
"""Spike: normalize a Claude Code transcript or Codex rollout into gang `event`s.
usage: normalize.py <path.jsonl>   (format auto-detected)"""
import json
import sys


def short(x, n=120):
    s = x if isinstance(x, str) else json.dumps(x)
    s = " ".join(s.split())
    return s[:n] + ("…" if len(s) > n else "")


def claude(lines):
    for d in lines:
        t, ts = d.get("type"), d.get("timestamp")
        if t not in ("user", "assistant"):
            continue
        c = d["message"]["content"]
        if isinstance(c, str):
            kind = "hook_prompt" if "Stop hook" in c else t
            yield ts, kind, short(c)
            continue
        for b in c:
            bt = b.get("type")
            if bt == "text":
                yield ts, t, short(b["text"])
            elif bt == "tool_use":
                yield ts, "tool_call", f"{b['name']} {short(b.get('input'), 80)}"
            elif bt == "tool_result":
                yield ts, "tool_result", short(b.get("content"), 80)


def codex(lines):
    for d in lines:
        p, ts = d.get("payload", {}), d.get("timestamp")
        if d.get("type") != "response_item":
            continue
        pt = p.get("type")
        if pt == "message" and p.get("role") in ("user", "assistant"):
            text = " ".join(x.get("text", "") for x in p.get("content", []))
            if text.startswith("<") and "hook_prompt" not in text:
                continue  # injected environment/context blocks
            kind = "hook_prompt" if "<hook_prompt" in text else p["role"]
            yield ts, kind, short(text)
        elif pt in ("function_call", "custom_tool_call"):
            yield ts, "tool_call", f"{p.get('name')} {short(p.get('arguments') or p.get('input'), 80)}"
        elif pt in ("function_call_output", "custom_tool_call_output"):
            yield ts, "tool_result", short(p.get("output"), 80)


lines = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
fmt = codex if any(d.get("type") == "session_meta" for d in lines[:3]) else claude
for ts, kind, summary in fmt(lines):
    print(f"{(ts or '')[11:19]}  {kind:12} {summary}")
