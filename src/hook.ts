// Hook shim installed into Claude Code and Codex. Keep this tiny and stable: Codex trust is pinned
// to the hook command, so all logic lives in the hub. Fails open (exit 0) if the hub is down.
import { request } from "node:http";

const PORT = Number(process.env.GANG_PORT ?? 7787);

function post(path: string, data: unknown, timeoutMs: number): Promise<any> {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(data));
    const req = request({ host: "127.0.0.1", port: PORT, path, method: "POST",
      headers: { "content-type": "application/json", "content-length": body.length } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { resolve(null); } });
    });
    req.setTimeout(timeoutMs, () => req.destroy());
    req.on("error", () => resolve(null));
    req.end(body);
  });
}

export async function runHook(runtime: string, event: string) {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  let payload: any = {};
  try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return 0; }

  if (event === "Stop") {
    // Claude: async+asyncRewake hook — exit 2 wakes an idle session. Codex: blocking "on call" hook.
    const timeout_ms = runtime === "claude" ? 8 * 3600_000 : 3_500_000;
    const r = await post("/stop-wait", { runtime, payload, timeout_ms }, timeout_ms + 60_000);
    if (!r?.text) return 0;
    if (runtime === "claude") { process.stderr.write(r.text + "\n"); return 2; }
    process.stdout.write(JSON.stringify({ decision: "block", reason: r.text }));
    return 0;
  }

  const r = await post("/hook", { runtime, event, payload }, 3000);
  if (r?.deny && event === "PreToolUse") {
    if (runtime === "claude") {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: r.deny } }));
      return 0;
    }
    process.stderr.write(r.deny + "\n");
    return 2;
  }
  if (r?.context && event !== "Notification" && event !== "PermissionRequest") {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: r.context } }));
  }
  return 0;
}
