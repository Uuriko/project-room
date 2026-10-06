// Trial-task HTTP routes — Demigod x Project Room paid-trial rails.
//
// RECORD-ONLY: no money moves through these routes, ever. `funded` means
// "trial budget recorded", never a ledger movement, escrow, or payout.
// The registry is per-process (a future slice persists to store.mjs); the
// pure state machine in ./trial-tasks.mjs stays I/O-free.
//
// Mount (future slice): server/http.mjs, pre-auth section, alongside
// /api/health and /api/version — the same spot the retired public-claim
// routes occupied. Writes require an agent identity (attribution); reads
// are public.
//
//   POST /api/trial-tasks              — create (201); with budgetRecord the
//                                        task is created funded, else proposed
//   GET  /api/trial-tasks/:id         — read (200) / 404
//   POST /api/trial-tasks/:id/claim   — { candidateId }
//   POST /api/trial-tasks/:id/submit  — { deliverableRef }
//   POST /api/trial-tasks/:id/verdict — { rubricScores, verdict: pass|fail }
//
// Error contract: TrialTaskError codes map to statuses; every error body is
// machine-readable: { status: "error", code, message, hint, next }. The
// illegal_transition body also carries `allowed` (the legal next states).
import {
  createTrialTask,
  fundTrialTask,
  claimTrialTask,
  submitTrialTask,
  verdictTrialTask,
  createTrialTaskRegistry,
  TrialTaskError,
} from "./trial-tasks.mjs";

// Singleton registry (per-process). A future slice persists to store.mjs.
const defaultRegistry = createTrialTaskRegistry();
export { defaultRegistry as trialTaskRegistry };

const TRIAL_TASKS_RE = /^\/api\/trial-tasks$/;
const TRIAL_TASK_ID_RE = /^\/api\/trial-tasks\/([A-Za-z0-9_-]{1,128})$/;
const TRIAL_TASK_SUB_RE = /^\/api\/trial-tasks\/([A-Za-z0-9_-]{1,128})\/(claim|submit|verdict)$/;

const HINTS = {
  invalid_trial_task_input: "Fix the named field and retry. Amounts stay strings (receipt-standard); no JSON numbers.",
  missing_demigod_req_id: "Supply demigodReqId — the opaque Demigod requisition id this trial records against.",
  invalid_rubric_weights: "Vetting rubric weights are basis-point strings that must sum to exactly 10000 (e.g. \"6000\" + \"4000\").",
  invalid_rubric_scores: "Score every vettingRubric criterion exactly once; each scoreBps is a string between 0 and the criterion weight.",
  invalid_verdict: "Verdict must be \"pass\" or \"fail\".",
  missing_budget_record: "Funding requires a budgetRecord note (RECORD-ONLY: the recorded budget; no money moves).",
  missing_candidate_id: "Claiming requires a candidateId.",
  missing_deliverable_ref: "Submitting requires a deliverableRef (URL or content reference).",
  illegal_transition: "Read GET /api/trial-tasks/{id} for the current state, then use one of the allowed next states.",
  trial_task_not_found: "Check the trial task id; ids are immutable once created.",
  identity_required: "Writes need an agent identity: send Authorization: Bearer <agent-token>.",
  method_not_allowed: "Use the documented verb for this path.",
};

function trialTaskHttpError(error) {
  if (!(error instanceof TrialTaskError)) throw error;
  const status = error.code === "illegal_transition" ? 409 : 422;
  return { status, error };
}

function errorBody(error, extra = {}) {
  const hint = HINTS[error.code] ?? "Fix the request and retry.";
  const body = {
    status: "error",
    code: error.code,
    message: error.message,
    hint,
    next: [{ command: hint }],
    ...extra,
  };
  if (error.code === "illegal_transition" && Array.isArray(error.allowed)) {
    body.allowed = error.allowed;
    body.from = error.from;
  }
  return body;
}

// handleTrialTasks({ req, res, url, body, identity, registry })
// - req, res: node http objects
// - url: parsed URL
// - body: async (req) => parsed JSON body
// - identity: { id, displayName } | null — writes require one; reads don't
// - registry: trial-task registry (defaults to the per-process singleton)
// Returns true if the route was handled, false to fall through.
export async function handleTrialTasks({ req, res, url, body, identity, registry = defaultRegistry }) {
  const { pathname } = url;
  const method = req.method;

  const json = (status, obj) => {
    const bytes = Buffer.from(JSON.stringify(obj));
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": bytes.length });
    res.end(bytes);
    return true;
  };
  const fail = (status, code, message) =>
    json(status, errorBody(new TrialTaskError(code, message)));

  const knownPath =
    TRIAL_TASKS_RE.test(pathname) || TRIAL_TASK_ID_RE.test(pathname) || TRIAL_TASK_SUB_RE.test(pathname);
  if (!knownPath) return false;
  const allowedMethods =
    (TRIAL_TASKS_RE.test(pathname) && ["POST"]) ||
    (TRIAL_TASK_ID_RE.test(pathname) && !TRIAL_TASK_SUB_RE.test(pathname) && ["GET"]) ||
    ["POST"];
  if (!allowedMethods.includes(method)) {
    return fail(405, "method_not_allowed",
      `${method} is not allowed on ${pathname}; use ${allowedMethods.join(", ")}.`);
  }

  try {
    const requireIdentity = () => {
      if (!identity || !identity.id) {
        fail(401, "identity_required", "An agent identity (Bearer token) is required for this verb.");
        return false;
      }
      return true;
    };

    const loadTask = id => {
      const task = registry.get(id);
      if (!task) fail(404, "trial_task_not_found", `Trial task "${id}" not found.`);
      return task;
    };

    // POST /api/trial-tasks — create. With a budgetRecord the task is
    // created funded (RECORD-ONLY: budget noted, never moved); else proposed.
    if (TRIAL_TASKS_RE.test(pathname) && method === "POST") {
      if (!requireIdentity()) return true;
      const data = await body(req);
      let task = createTrialTask(data ?? {});
      if (data && data.budgetRecord !== undefined && data.budgetRecord !== null) {
        task = fundTrialTask(task, data.budgetRecord);
      }
      registry.set(task);
      return json(201, { status: "ok", task });
    }

    // GET /api/trial-tasks/:id — public read.
    {
      const m = TRIAL_TASK_ID_RE.exec(pathname);
      if (m && method === "GET" && !TRIAL_TASK_SUB_RE.test(pathname)) {
        const task = registry.get(m[1]);
        if (!task) return fail(404, "trial_task_not_found", `Trial task "${m[1]}" not found.`);
        return json(200, { status: "ok", task });
      }
    }

    // POST /api/trial-tasks/:id/{claim|submit|verdict} — state transitions.
    {
      const m = TRIAL_TASK_SUB_RE.exec(pathname);
      if (m && method === "POST") {
        if (!requireIdentity()) return true;
        const [, id, action] = m;
        const current = loadTask(id);
        if (!current) return true; // loadTask already failed with 404
        const data = (await body(req).catch(() => ({}))) ?? {};
        let next;
        if (action === "claim") next = claimTrialTask(current, { candidateId: data.candidateId });
        else if (action === "submit") next = submitTrialTask(current, { deliverableRef: data.deliverableRef });
        else next = verdictTrialTask(current, { rubricScores: data.rubricScores, verdict: data.verdict });
        registry.set(next);
        return json(200, { status: "ok", task: next });
      }
    }

    return false;
  } catch (error) {
    if (!(error instanceof TrialTaskError)) throw error;
    const { status } = trialTaskHttpError(error);
    return json(status, errorBody(error));
  }
}
