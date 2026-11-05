// Board claim tools over MCP (flag ROOM_BOARD_CLAIM_TOOLS, off by default).
//
// A Board task posted from the web or REST (/work-claims) could be retired
// over MCP (room_close_work_claim) but never taken or delivered: room_claim and
// room_record_completion act on proposed work items, so they answered
// work_not_found. The 2026-11-03 workflow harness measured 0/10 scripted
// agents finishing a Board task on main (core and full profiles).
//
// Both tools call the same handleWorkClaims routes as REST (claim, update), so
// caps, leases, review policy, autonomy tiers, events and wakes are unchanged.
// One tool, two ops (take | finish): a second tool would push the full
// catalog past its 116-tool budget and the core list past 17 KiB.
export const BOARD_WORK_CLAIM_TOOL = "room_work_claim";
export const BOARD_CLAIM_TOOLS = Object.freeze([BOARD_WORK_CLAIM_TOOL]);
const CLAIM_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function boardClaimToolsEnabled(env = globalThis.process?.env ?? {}) {
  return /^(1|true|on)$/i.test(String(env?.ROOM_BOARD_CLAIM_TOOLS ?? "").trim());
}

const text = (max) => ({ type: "string", minLength: 1, maxLength: max });
export const boardClaimToolDefinitions = () => [
  { name: BOARD_WORK_CLAIM_TOOL,
    description: "Board task. take: claim. finish: deliver+note. plan: set plan {priority,estimate,dueAt,cycleId,milestone,...}, null clears. list: query = GET work-claims params.",
    inputSchema: { type: "object", additionalProperties: false, required: ["roomId", "op"], properties: {
      roomId: { type: "string", maxLength: 128 },
      claimId: { type: "string", pattern: CLAIM_ID.source },
      op: { type: "string", enum: ["take", "finish", "plan", "list"] },
      plan: { type: "object" },
      query: { type: "object" },
      note: { ...text(4000) },
      files: { type: "array", maxItems: 64, items: text(512) },
      state: { type: "string", enum: ["delivered", "done"] } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }
];

export function validBoardClaimArgs(name, args) {
  if (name !== BOARD_WORK_CLAIM_TOOL || !args || typeof args !== "object") return false;
  if (args.op === "list") {
    // Same params as GET /work-claims (state, queue, view, limit, cursor and,
    // with their flags, planning filters, sort, savedView, groupBy). The REST
    // list route validates them; here only flat scalar values are accepted.
    const q = args.query;
    return Object.keys(args).every(k => k === "op" || k === "query")
      && (q === undefined || q !== null && typeof q === "object" && !Array.isArray(q)
        && Object.values(q).every(v => ["string", "number"].includes(typeof v)));
  }
  if (!CLAIM_ID.test(String(args.claimId ?? ""))) return false;
  const str = (v, max) => v === undefined || typeof v === "string" && v.trim().length > 0 && v.length <= max;
  if (args.op === "take") {
    const allowed = new Set(["claimId", "op", "note", "files"]);
    return Object.keys(args).every(k => allowed.has(k)) && str(args.note, 2000)
      && (args.files === undefined || Array.isArray(args.files) && args.files.length <= 64 && args.files.every(f => str(f, 512)));
  }
  if (args.op === "finish") {
    const allowed = new Set(["claimId", "op", "note", "state"]);
    return Object.keys(args).every(k => allowed.has(k)) && typeof args.note === "string" && str(args.note, 4000)
      && (args.state === undefined || args.state === "delivered" || args.state === "done");
  }
  if (args.op === "plan") {
    // Planning fields (#5889, ROOM_BOARD_PLANNING_FIELDS): the REST update
    // route type-checks them and 422s when the flag is off.
    const allowed = new Set(["claimId", "op", "plan"]);
    return Object.keys(args).every(k => allowed.has(k)) && args.plan !== null && typeof args.plan === "object"
      && !Array.isArray(args.plan) && Object.keys(args.plan).length > 0;
  }
  return false;
}

// Plan of REST route calls for one tool call. `current` is the claim's state.
export function boardClaimSteps(_name, args, current) {
  if (args.op === "take") {
    return [["claim", { ...(args.note ? { note: args.note } : {}), ...(args.files ? { files: args.files } : {}) }]];
  }
  if (args.op === "plan") return [["update", { ...args.plan }]];
  const steps = [];
  if (current === "claimed") steps.push(["update", { state: "in_progress" }]);
  steps.push(["update", { state: args.state ?? "delivered", note: args.note }]);
  return steps;
}

// Run the steps in-process through handleWorkClaims (the REST handler). Stops
// at the first refusal and returns it with the step that refused.
export async function runBoardClaimTool({ handleWorkClaims, store, roomId, auth, reauthorize, name, args }) {
  const registry = store.workClaims;
  if (args.op === "list") {
    const url = new URL(`http://room.invalid/api/rooms/${encodeURIComponent(roomId)}/work-claims`);
    for (const [k, v] of Object.entries(args.query ?? {})) url.searchParams.set(k, String(v));
    let out = null;
    const reject = (status, code, message) => { const e = new Error(message); e.status = status; e.code = code; e.body = { code, message }; throw e; };
    try {
      await handleWorkClaims({ req: { method: "GET", headers: {} }, res: {}, url, store, roomId, auth, workClaimRoute: "list",
        workClaimId: null, registry, reauthorize, helpers: { json: (_res, status, value) => { out = { status, value }; }, reject, body: async () => ({}) } });
    } catch (error) {
      if (!Number.isInteger(error?.status)) throw error;
      out = { status: error.status, value: error.body ?? { code: error.code, message: error.message } };
    }
    return out && out.status < 400 ? { isError: false, value: out.value } : { isError: true, value: { status: out?.status ?? 500, ...(out?.value ?? {}), step: "list" } };
  }
  const item = registry.get(roomId, args.claimId);
  if (!item) return { isError: true, value: { status: 404, code: "work_claim_not_found",
    message: `No Board work claim "${args.claimId}" in this room`, next: [{ tool: "room_read_board", arguments: { roomId } }] } };
  let last = null;
  for (const [route, data] of boardClaimSteps(name, args, item.state)) {
    let out = null;
    const reject = (status, code, message) => { const e = new Error(message); e.status = status; e.code = code; e.body = { code, message }; throw e; };
    try {
      await handleWorkClaims({ req: { method: "POST", headers: {} }, res: {},
        url: new URL(`http://room.invalid/api/rooms/${encodeURIComponent(roomId)}/work-claims/${encodeURIComponent(args.claimId)}/${route}`),
        store, roomId, auth, workClaimRoute: route, workClaimId: args.claimId, registry, reauthorize,
        helpers: { json: (_res, status, value) => { out = { status, value }; }, reject, body: async () => data } });
    } catch (error) {
      if (!Number.isInteger(error?.status)) throw error;
      out = { status: error.status, value: error.body ?? { code: error.code, message: error.message } };
    }
    if (!out || out.status >= 400) {
      return { isError: true, value: { status: out?.status ?? 500, ...(out?.value ?? {}), step: route,
        ...(route === "update" && /review/.test(String(out?.value?.message)) ? { hint: "This room reviews work: finish with state delivered; a reviewer verifies it to done." } : {}) } };
    }
    last = out.value;
  }
  return { isError: false, value: last };
}
