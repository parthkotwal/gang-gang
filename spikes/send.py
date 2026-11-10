#!/usr/bin/env python3
"""Drop a message for the spike hook:  send.py <claude|codex> "message text" """
import os
import sys

inbox = os.path.expanduser("~/.gang-spike/inbox")
os.makedirs(inbox, exist_ok=True)
with open(os.path.join(inbox, f"{sys.argv[1]}.txt"), "w") as f:
    f.write(" ".join(sys.argv[2:]))
print(f"queued for {sys.argv[1]}")
