// Auto presence (reason-take-1): derive one short, agent-first presence line from the
// session title and todo list an agent already keeps, so nobody has to type a status.
// Pure and offline: no network, no storage. Hosts feed it the hook payloads they already
// emit (Claude Code TodoWrite, Codex update_plan, Gemini/opencode/generic todo arrays).
// The output is a self-reported activity hint, not evidence that the agent is running now:
// liveness is always "unknown" here and any TTL stays owned by the host/runtime.
// clean() is a best-effort scrub (secrets, invite codes, key=value credentials, emails,
// paths), not a privacy boundary: nothing here forwards titles or todos anywhere, and any
// later broadcast must be an explicit, room-scoped opt-in.

const MAX = 120;
const SCRUB = [
  [/pri_[A-Za-z0-9_-]{8,}|rak_[A-Za-z0-9_-]{8,}|RM-[A-Z0-9]{6,}/g, "[redacted]"],
  [/(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/\b(?:token|secret|password|passwd|api[_-]?key|auth|credential|bearer)\s*[=:]\s*\S+/gi, "[redacted]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  [/(?:~|(?<![\w.:/])\/[^\s/,;)]+)\/[^\s,;)]*/g, "[path]"],
  [/[A-Za-z]:\\[^\s,;)]*/g, "[path]"],
];

export function clean(text, max = MAX) {
  let s = String(text ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  for (const [re, to] of SCRUB) s = s.replace(re, to);
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

const DONE = new Set(["completed", "complete", "done", "finished"]);
const ACTIVE = new Set(["in_progress", "in-progress", "active", "doing", "running"]);

// Accepts any host's todo shape and returns [{ text, state }] with state done|active|pending.
export function normalizeTodos(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (item == null) continue;
    const text = typeof item === "string" ? item : item.activeForm && ACTIVE.has(String(item.status).toLowerCase())
      ? item.activeForm : item.content ?? item.step ?? item.title ?? item.text ?? item.description ?? "";
    const raw = typeof item === "string" ? "pending" : String(item.status ?? item.state ?? (item.done || item.completed ? "completed" : "pending")).toLowerCase();
    const state = DONE.has(raw) ? "done" : ACTIVE.has(raw) ? "active" : "pending";
    if (String(text).trim()) out.push({ text: String(text), state });
  }
  return out;
}

// Pulls { title, todos } out of the hook payloads hosts already send.
export function fromHookPayload(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const input = p.tool_input ?? p.toolInput ?? p.input ?? p.arguments ?? {};
  const todos = input.todos ?? input.plan ?? p.todos ?? p.plan ?? [];
  const title = p.session_title ?? p.sessionTitle ?? p.title ?? input.explanation ?? p.session?.title ?? "";
  return { title, todos };
}

// { kind: "activity_hint", status, liveness: "unknown", line, counts }
// status: "active" (a todo is marked in progress), "planned" (title or pending todos only),
// "done" (every todo completed) or "none". line is null when there is nothing worth showing.
export function derivePresence({ title, todos } = {}) {
  const items = normalizeTodos(todos);
  const done = items.filter(i => i.state === "done").length;
  const active = items.find(i => i.state === "active") ?? items.find(i => i.state === "pending");
  const counts = { done, total: items.length };
  const head = clean(title, 60);
  const allDone = items.length > 0 && done === items.length;
  const inProgress = items.some(i => i.state === "active");
  const status = allDone ? "done" : inProgress ? "active" : head || active ? "planned" : "none";
  const hint = line => ({ kind: "activity_hint", status, liveness: "unknown", line, counts });
  if (!head && !active) return hint(allDone ? `Done ${done}/${items.length}` : null);
  const parts = [];
  if (head) parts.push(head);
  if (active && !allDone) parts.push(clean(active.text, 60));
  if (items.length) parts.push(`${done}/${items.length}`);
  return hint(clean(parts.join(" · ")));
}

// Only report when the line actually changed: hosts call this on every hook, the room hears
// at most one update per real change (no broadcast loops).
export function presenceChanged(previous, next) {
  return (previous?.line ?? null) !== (next?.line ?? null) || (previous?.status ?? null) !== (next?.status ?? null);
}
