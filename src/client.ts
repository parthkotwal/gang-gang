import { request } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { CLI_PATH, DAEMON_LOG, GANG_HOME, HUB_URL } from "./paths.ts";

/** Minimal JSON POST with no client-side timeout (Stop hooks long-poll for up to hours). */
export function postJson(url: string, data: unknown, timeoutMs = 0): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(data));
    const req = request(url, { method: "POST", headers: { "content-type": "application/json", "content-length": body.length } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const s = Buffer.concat(chunks).toString("utf8");
        try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error(`bad response: ${s.slice(0, 200)}`)); }
      });
    });
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

export async function getJson(url: string): Promise<any> {
  const r = await fetch(url);
  return r.json();
}

export async function healthy(): Promise<boolean> {
  try { const r = await fetch(`${HUB_URL}/health`, { signal: AbortSignal.timeout(800) }); return r.ok; } catch { return false; }
}

/** Start the hub in the background if it isn't running. */
export async function ensureDaemon(): Promise<void> {
  if (await healthy()) return;
  mkdirSync(GANG_HOME, { recursive: true });
  const fd = openSync(DAEMON_LOG, "a");
  const child = spawn(process.execPath, ["--no-warnings", CLI_PATH, "daemon"], { detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await healthy()) return;
  }
  throw new Error(`gang hub failed to start; see ${DAEMON_LOG}`);
}
