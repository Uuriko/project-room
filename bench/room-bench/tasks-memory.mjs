// Room-Bench task for shared memory. Same shape as TASKS in tasks.mjs (#4339):
// append MEMORY_TASKS to TASKS once both are on one branch. Uses only the
// memory tools already on the lean list; no default tools are added.
const u = () => crypto.randomUUID();
export const MEMORY_TASKS = [
  { id: "T11-memory", goal: "Save a fact, find it again, and relay the owner's correction until it is an active rule.",
    steps: [
      { tool: "room_memory_write", args: (s) => ({ roomId: s.room, requestId: u(), text: `bench fact ${s.w}: deploys go out from the integration branch` }),
        ok: (o) => o?.action === "added" || o?.action === "noop" },
      { tool: "room_memory_search", args: (s) => ({ roomId: s.room, query: `bench fact ${s.w} deploys` }),
        ok: (o) => (o?.memories || []).some((m) => String(m.text).includes("bench fact")),
        save: (s, o) => (s.factFound = (o?.memories || []).some((m) => String(m.text).includes(`bench fact ${s.w}`))) },
      { tool: "room_memory_write", args: (s) => ({ roomId: s.room, requestId: u(), kind: "rule", source: "owner_direct", text: `When editing bench/${s.w}.md, keep lines under 100 characters` }),
        ok: (o) => o?.action === "proposed" },
      // The owner repeats the same correction: the proposal turns on.
      { tool: "room_memory_write", args: (s) => ({ roomId: s.room, requestId: u(), kind: "rule", source: "owner_direct", text: `when editing bench/${s.w}.md keep lines under 100 characters.` }),
        ok: (o) => o?.action === "activated", save: (s, o) => (s.ruleId = o?.rule?.id) },
      { tool: "room_rules", args: (s) => ({ roomId: s.room, action: "active" }),
        ok: (o) => Array.isArray(o?.rules) && o.rules.length <= 12 && o.tokens <= 600,
        save: (s, o) => (s.ruleLive = (o?.rules || []).some((r) => r.id === s.ruleId)) }],
    note: "Checks the guards as well: a single relayed correction stays proposed; injection stays within 12 rules and 600 tokens.",
    check: (s, r) => r.length === 5 && r.every((x) => x?.ok) && s.factFound && s.ruleLive },
];
