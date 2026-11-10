import { tailFile } from "./jobs.ts";

export interface Event {
  ts: string | null;
  kind: "user" | "assistant" | "tool_call" | "tool_result" | "wake";
  text: string;
  tool?: string;
  files?: string[];
}

const clip = (s: unknown, n: number) => {
  const t = (typeof s === "string" ? s : JSON.stringify(s) ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/** Like clip, but keeps line breaks (for human-readable message text). */
const clipText = (s: string, n: number) => {
  const t = s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

const PATCH_FILES = /\*\*\* (?:Add|Update|Delete) File: ([^\n"\\]+)/g;

/** Read the tail of a Claude Code transcript or Codex rollout and normalize it. */
export function readTranscript(path: string, maxBytes = 2_000_000): Event[] {
  const raw = tailFile(path, maxBytes);
  const lines: any[] = [];
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    try { lines.push(JSON.parse(l)); } catch { /* partial first line */ }
  }
  const isCodex = lines.some((d) => d.type === "session_meta" || d.type === "response_item" || d.type === "event_msg");
  return isCodex ? codex(lines) : claude(lines);
}

function claude(lines: any[]): Event[] {
  const out: Event[] = [];
  for (const d of lines) {
    if (d.type !== "user" && d.type !== "assistant") continue;
    if (d.isMeta) continue;
    const ts = d.timestamp ?? null;
    const c = d.message?.content;
    if (typeof c === "string") {
      if (c.includes("<command-name>") || c.includes("<local-command")) continue;
      out.push({ ts, kind: c.includes("Stop hook") ? "wake" : d.type, text: clipText(c.replace(/<\/?(task-notification|summary|system-reminder)>/g, ""), 1200) });
      continue;
    }
    for (const b of c ?? []) {
      if (b.type === "text" && b.text?.trim()) out.push({ ts, kind: d.type, text: clipText(b.text, 2000) });
      else if (b.type === "tool_use") {
        const fp = b.input?.file_path ?? b.input?.notebook_path;
        const files = fp ? [fp] : [];
        const desc = b.name === "Bash" ? b.input?.command : fp ?? b.input;
        out.push({ ts, kind: "tool_call", tool: b.name, text: clip(desc, 200), files: /Edit|Write/.test(b.name) ? files : [] });
      } else if (b.type === "tool_result") {
        const content = Array.isArray(b.content) ? b.content.map((x: any) => x.text ?? "").join(" ") : b.content;
        out.push({ ts, kind: "tool_result", text: clip(content, 200) });
      }
    }
  }
  return out;
}

function codex(lines: any[]): Event[] {
  const out: Event[] = [];
  for (const d of lines) {
    if (d.type !== "response_item") continue;
    const p = d.payload ?? {};
    const ts = d.timestamp ?? null;
    if (p.type === "message" && (p.role === "user" || p.role === "assistant")) {
      const text = (p.content ?? []).map((x: any) => x.text ?? "").join(" ");
      if (text.includes("<hook_prompt")) { out.push({ ts, kind: "wake", text: clipText(text.replace(/<\/?hook_prompt[^>]*>/g, ""), 1200) }); continue; }
      if (text.trimStart().startsWith("<")) continue; // environment / app context blocks
      out.push({ ts, kind: p.role, text: clipText(text, 2000) });
    } else if (p.type === "function_call" || p.type === "custom_tool_call") {
      const args = p.arguments ?? p.input ?? "";
      const argStr = typeof args === "string" ? args : JSON.stringify(args);
      const files = [...argStr.matchAll(PATCH_FILES)].map((m) => m[1].trim());
      if (p.name === "exec") {
        // Codex desktop "code mode": JS that calls tools.<name>(...)
        for (const call of unwrapCodeMode(argStr)) out.push({ ts, kind: "tool_call", ...call, files: call.tool === "apply_patch" ? files : [] });
        if (!/tools\.\w+\(/.test(argStr)) out.push({ ts, kind: "tool_call", tool: "exec", text: clip(argStr, 200) });
      } else {
        let desc: unknown = argStr;
        try { const j = JSON.parse(argStr); desc = j.cmd ?? j.command ?? j; } catch {}
        out.push({ ts, kind: "tool_call", tool: p.name, text: clip(desc, 200), files });
      }
    } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      const o = p.output;
      const text = typeof o === "string" ? o : Array.isArray(o) ? o.map((x: any) => x.text ?? "").join(" ") : JSON.stringify(o);
      out.push({ ts, kind: "tool_result", text: clip(text, 200) });
    }
  }
  return out;
}

function unwrapCodeMode(js: string): { tool: string; text: string }[] {
  const calls: { tool: string; text: string }[] = [];
  for (const m of js.matchAll(/tools\.([A-Za-z0-9_]+)\(\s*(\{[\s\S]*?\}|"[^"]*"|`[^`]*`)?/g)) {
    const tool = m[1].replace(/^mcp__/, "mcp:");
    const arg = m[2] ?? "";
    const cmd = arg.match(/cmd\s*:\s*("(?:[^"\\]|\\.)*"|`[^`]*`|'[^']*')/)?.[1];
    calls.push({ tool, text: clip(cmd ? cmd.slice(1, -1) : arg, 200) });
  }
  return calls;
}

/** Compact view another agent (or the dashboard) can read cheaply. */
export function digest(events: Event[], limit = 12) {
  const files = new Set<string>();
  for (const e of events) for (const f of e.files ?? []) files.add(f);
  const lastAssistant = [...events].reverse().find((e) => e.kind === "assistant")?.text ?? null;
  const lastUser = [...events].reverse().find((e) => e.kind === "user")?.text ?? null;
  return {
    last_user_request: lastUser,
    last_assistant_message: lastAssistant,
    files_touched: [...files].slice(-20),
    recent: events.filter((e) => e.kind !== "tool_result").slice(-limit),
  };
}
