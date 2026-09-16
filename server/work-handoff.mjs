// Structured agent-to-agent work handoff (B014). A frozen contract so any
// agent can hand work to any other agent — or to John — with everything the
// receiver needs: objective → status → next → blockers → files → validation.
// Pure validator: no store, no network. A later slice persists handoffs.
class HandoffError extends Error { constructor(code, message) { super(message); this.name = "HandoffError"; this.code = code; } }
const fail = (code, message) => { throw new HandoffError(code, message); };
const requireHandoff = (condition, code = "invalid_work_handoff", message = "invalid work handoff") => { if (!condition) fail(code, message); };

const text = (value, max, field) => {
  requireHandoff(typeof value === "string" && value.isWellFormed() && value.length > 0 && value.length <= max, "invalid_work_handoff", `${field} must be 1..${max} well-formed characters`);
  return value;
};
const optionalText = (value, max, field) => value == null ? null : text(value, max, field);
const idText = value => { requireHandoff(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value), "invalid_work_handoff", "handoff ids must be simple identifiers"); return value; };
const isoDate = value => {
  requireHandoff(typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/.test(value) && Number.isFinite(Date.parse(value)), "invalid_work_handoff", "handoff timestamps must be ISO UTC");
  return value;
};
export const handoffStatuses = Object.freeze(["not_started", "in_progress", "blocked", "ready_for_review", "done"]);
// files: [{ path, kind, sha }] — kind in {code, doc, data, other}; sha is a
// 40-char git blob id or 64-char sha256 when the file is not in git.
const handoffFile = value => {
  requireHandoff(value !== null && typeof value === "object" && !Array.isArray(value), "invalid_work_handoff", "handoff files must be objects");
  requireHandoff(Object.keys(value).every(k => ["path", "kind", "sha"].includes(k)), "invalid_work_handoff", "handoff files carry only path/kind/sha");
  const kinds = ["code", "doc", "data", "other"];
  requireHandoff(kinds.includes(value.kind), "invalid_work_handoff", `file kind must be one of ${kinds.join(",")}`);
  if (value.sha !== undefined && value.sha !== null) requireHandoff(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(value.sha), "invalid_work_handoff", "file sha must be a 40 or 64 char hex digest");
  return Object.freeze({ path: text(value.path, 1024, "file path"), kind: value.kind, sha: value.sha ?? null });
};
// Validate and freeze one handoff record.
export function workHandoff(value) {
  requireHandoff(value !== null && typeof value === "object" && !Array.isArray(value), "invalid_work_handoff", "handoff must be an object");
  const allowed = ["id", "from", "to", "at", "objective", "status", "summary", "next", "blockers", "files", "validation"];
  requireHandoff(Object.keys(value).every(k => allowed.includes(k)), "invalid_work_handoff", `handoff carries only ${allowed.join(",")}`);
  requireHandoff(handoffStatuses.includes(value.status), "invalid_work_handoff", `status must be one of ${handoffStatuses.join(",")}`);
  const list = (values, max, field) => {
    requireHandoff(Array.isArray(values) && values.length <= 64, "invalid_work_handoff", `${field} must be a list of at most 64`);
    return Object.freeze(values.map(v => text(v, max, field)));
  };
  const record = {
    id: idText(value.id),
    from: text(value.from, 128, "from"),
    to: text(value.to, 128, "to"),
    at: isoDate(value.at),
    objective: text(value.objective, 4096, "objective"),
    status: value.status,
    summary: text(value.summary, 8192, "summary"),
    next: list(value.next ?? [], 2048, "next step"),
    blockers: list(value.blockers ?? [], 2048, "blocker"),
    files: Object.freeze((value.files ?? []).map(handoffFile).slice(0, 64)),
    validation: optionalText(value.validation, 8192, "validation"),
  };
  requireHandoff(record.status !== "blocked" || record.blockers.length > 0, "invalid_work_handoff", "a blocked handoff must name its blockers");
  requireHandoff(record.status !== "ready_for_review" || record.validation !== null, "invalid_work_handoff", "a review-ready handoff must say how it was validated");
  return Object.freeze(record);
}
// Convenience: start a handoff skeleton the handing agent fills in.
export function startHandoff({ id, from, to, objective }) {
  return { id: idText(id), from: text(from, 128, "from"), to: text(to, 128, "to"),
    at: new Date().toISOString(), objective: text(objective, 4096, "objective"),
    status: "in_progress", summary: "", next: [], blockers: [], files: [], validation: null };
}
export { HandoffError };
