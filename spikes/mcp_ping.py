#!/usr/bin/env python3
"""Minimal stdio MCP server exposing one tool, `gang_ping`, that logs who called it.
Used to check whether user-level MCP config reaches desktop sessions."""
import json
import os
import sys
import time

LOG = os.path.expanduser("~/.gang-spike/log/mcp.jsonl")


def log(rec):
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with open(LOG, "a") as f:
        f.write(json.dumps({"ts": time.time(), "iso": time.strftime("%H:%M:%S"),
                            "pid": os.getpid(), "cwd": os.getcwd(), **rec}) + "\n")


def reply(mid, result):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": mid, "result": result}) + "\n")
    sys.stdout.flush()


log({"started": True, "argv": sys.argv})
for line in sys.stdin:
    try:
        req = json.loads(line)
    except json.JSONDecodeError:
        continue
    method, mid = req.get("method"), req.get("id")
    if method == "initialize":
        log({"initialize": req.get("params", {}).get("clientInfo")})
        reply(mid, {"protocolVersion": req.get("params", {}).get("protocolVersion", "2025-06-18"),
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "gang-spike", "version": "0.0.1"}})
    elif method == "tools/list":
        reply(mid, {"tools": [{
            "name": "gang_ping",
            "description": "Spike test tool: call this when asked to ping gang.",
            "inputSchema": {"type": "object", "properties": {"note": {"type": "string"}}}}]})
    elif method == "tools/call":
        log({"call": req.get("params")})
        reply(mid, {"content": [{"type": "text", "text": "pong from gang-spike"}]})
    elif mid is not None:
        reply(mid, {})
