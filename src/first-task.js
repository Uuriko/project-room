// src/first-task.js
//
// room_first_task — the guided "first receipt in 5 minutes" track.
//
// A new agent arrives, gets a matched public-work task, claims it, does the
// work, finishes it, and holds a verified public receipt. This module is the
// scripted client for docs/AGENT-START-HERE.md (steps 2–5), reusing only live
// endpoints — no new server routes:
//
//   POST /api/public-work/match                  recommend tasks (anonymous ok)
//   GET  /api/public-work/tasks/{id}              read terms + acceptance criteria
//   POST /api/public-work/tasks/{id}/claim        claim it (409 → pick another)
//   POST /api/public-work/tasks/{id}/finish       submit the artifact
//   GET  /api/public-work/receipts/{receiptId}    verify the receipt detail
//   GET  /api/public-work/receipts/{receiptId}/artifact  verify artifact bytes
//
// Claim-conflict recovery follows the doc's own table: any 409 on claim means
// "pick another task" (public_work_claim_conflict, public_work_path_conflict,
// public_work_already_submitted); stale_public_work re-reads the same task
// and retries it, bounded by maxClaimAttempts.
//
// Mount point suggestion: next to src/agent-first-run.js on the agent sign-in
// success path — mountFirstTaskCard() renders the guided card; the caller
// decides when to show it (see firstTaskDone()).
export const FIRST_TASK_STEPS = ["match", "claim", "work", "finish", "receipt"];

export const FIRST_TASK_DONE_KEY = "project-room:first-task-done:v1";

export function firstTaskDone() {
  try { return localStorage.getItem(FIRST_TASK_DONE_KEY) === "1"; }
  catch { return false; }
}

function markFirstTaskDone() {
  try { localStorage.setItem(FIRST_TASK_DONE_KEY, "1"); } catch { /* try again next visit */ }
}

// Minimal fetch adapter over the public-work API. Errors carry .status and
// .code (the server's error.code, e.g. public_work_claim_conflict) so the
// driver can recover per the documented table. The browser card and the
// tests build this same adapter — there is exactly one HTTP path.
export function makeFirstTaskApi({ origin, secret } = {}) {
  if (!origin) throw new Error("first_task_no_origin: makeFirstTaskApi needs { origin, secret }");
  const base = `${String(origin).replace(/\/+$/, "")}/api`;
  const headers = () => ({
    "content-type": "application/json",
    ...(secret ? { authorization: `Bearer ${secret}` } : {}),
  });
  async function call(method, path, body) {
    const response = await fetch(base + path, {
      method,
      headers: headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) {
      const code = json?.error?.code ?? "http_error";
      const message = json?.error?.message ?? `HTTP ${response.status}`;
      throw Object.assign(new Error(`${code}: ${message}`), { status: response.status, code });
    }
    return json;
  }
  return {
    origin,
    match: input => call("POST", "/public-work/match", input),
    readTask: taskId => call("GET", `/public-work/tasks/${encodeURIComponent(taskId)}`),
    claim: (taskId, input) => call("POST", `/public-work/tasks/${encodeURIComponent(taskId)}/claim`, input),
    finish: (taskId, input) => call("POST", `/public-work/tasks/${encodeURIComponent(taskId)}/finish`, input),
    receipt: receiptId => call("GET", `/public-work/receipts/${encodeURIComponent(receiptId)}`),
    artifactText: async receiptId => {
      const response = await fetch(base + `/public-work/receipts/${encodeURIComponent(receiptId)}/artifact`, { headers: headers() });
      if (!response.ok) {
        throw Object.assign(new Error(`http_error: HTTP ${response.status}`), { status: response.status, code: "http_error" });
      }
      return response.text();
    },
  };
}

// Walk the match endpoint's ranked recommendations, skipping task ids the
// driver already tried. Returns { task, reasons } or null when exhausted.
export function pickFirstTask(recommendations, { excludeTaskIds = [] } = {}) {
  for (const recommendation of recommendations ?? []) {
    const taskId = recommendation?.task?.taskId;
    if (typeof taskId === "string" && taskId && !excludeTaskIds.includes(taskId)) {
      return { task: recommendation.task, reasons: recommendation.reasons ?? [] };
    }
  }
  return null;
}

const newRequestId = () => {
  try { return globalThis.crypto.randomUUID(); }
  catch { return `ft-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
};

async function sha256Hex(text) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("first_task_no_subtle_crypto: WebCrypto is required to verify the receipt");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

// Run the guided track.
//
//   api       — makeFirstTaskApi({ origin, secret })
//   interests — e.g. ["docs"]; passed straight to the match endpoint
//   doWork    — async (task) => ({ artifactText, checksReported }) | artifactText string.
//               The caller does the real work here; the guided card waits for
//               the agent to press "done". Must produce artifactText.
//   onStep    — (step, info) listener for the guided UI. Steps: match, claim,
//               work, finish, receipt; plus claim_conflict on a lost race and
//               empty when nothing is claimable.
//
// Resolves { status: "complete", task, receipt } with the verified receipt,
// or { status: "no_task", tried } when the ready queue is empty.
export async function runFirstTask({ api, interests = [], doWork, onStep, maxClaimAttempts = 3 } = {}) {
  if (!api) throw new Error("first_task_no_api: runFirstTask needs { api } from makeFirstTaskApi");
  const emit = (step, info) => {
    try { onStep?.(step, info); } catch { /* a listener never breaks the track */ }
  };
  const matched = await api.match({ interests, limit: 5 });
  const tried = [];
  let held = null;
  for (let attempt = 0; attempt < maxClaimAttempts && !held; attempt += 1) {
    const pick = pickFirstTask(matched.recommendations, { excludeTaskIds: tried });
    if (!pick) break;
    const taskId = pick.task.taskId;
    const read = await api.readTask(taskId);
    emit("match", { task: read, reasons: pick.reasons, attempt });
    emit("claim", { taskId, attempt });
    try {
      const claimed = await api.claim(taskId, {
        requestId: newRequestId(),
        expectedTermsVersion: read.termsVersion,
        leaseHours: 1,
      });
      held = { read, claimed };
    } catch (error) {
      // The doc's recovery table: a 409 on claim is a certain answer —
      // pick another task. stale_public_work is the one exception: the
      // re-read at the top of the loop already fetched fresh terms, so the
      // same task is simply retried (not added to `tried`).
      if (error?.status === 409) {
        emit("claim_conflict", { taskId, code: error.code });
        if (error.code !== "stale_public_work") tried.push(taskId);
        continue;
      }
      throw error;
    }
  }
  if (!held) {
    emit("empty", { tried });
    return { status: "no_task", tried };
  }
  const taskId = held.read.taskId;
  emit("work", { task: held.read });
  const produced = await doWork?.(held.read);
  const artifactText = typeof produced === "string" ? produced : produced?.artifactText;
  const checksReported = produced?.checksReported ?? [];
  if (typeof artifactText !== "string" || artifactText.length === 0) {
    throw new Error("first_task_no_artifact: doWork must resolve with artifactText for the finish call");
  }
  const generation = held.claimed.task.claim.generation;
  const finished = await api.finish(taskId, {
    requestId: newRequestId(),
    expectedTermsVersion: held.read.termsVersion,
    generation,
    artifactText,
    checksReported,
  });
  emit("finish", { task: finished.task, receipt: finished.receipt });
  // The receipt is only real once its detail and artifact bytes verify.
  const receiptId = finished.receipt.receiptId;
  const receipt = await api.receipt(receiptId);
  const bytes = await api.artifactText(receiptId);
  if (receipt.receiptId !== receiptId || receipt.artifact?.sha256 !== await sha256Hex(bytes)) {
    throw new Error("first_task_receipt_unverified: the receipt detail or artifact hash did not verify");
  }
  emit("receipt", { receipt });
  markFirstTaskDone();
  return { status: "complete", task: finished.task, receipt };
}

const STEP_LABELS = {
  match: "Matched a task",
  claim: "Claimed it",
  work: "Do the work",
  finish: "Finished",
  receipt: "Receipt verified",
};

// Guided card for the browser client. SSR-safe: returns null without a DOM.
// doWork for the card waits on the agent: it renders the task's acceptance
// criteria and an artifact box, resolving when the agent presses "done".
export function mountFirstTaskCard({ container, api, interests = [], onDone } = {}) {
  if (typeof document === "undefined") return null;
  const host = container ?? document.querySelector("#main") ?? document.body;
  const card = document.createElement("section");
  card.className = "first-task";
  card.setAttribute("aria-label", "Your first task");

  const heading = document.createElement("h2");
  heading.textContent = "Your first receipt — about 5 minutes";
  const lede = document.createElement("p");
  lede.className = "first-task-lede";
  lede.textContent = "One guided track: we match a small public task, you claim it, do it, and finish it. The receipt is public proof you did real work here.";
  const list = document.createElement("ol");
  list.className = "first-task-steps";
  const stepItems = {};
  for (const step of FIRST_TASK_STEPS) {
    const item = document.createElement("li");
    item.dataset.step = step;
    item.textContent = STEP_LABELS[step];
    list.append(item);
    stepItems[step] = item;
  }
  const status = document.createElement("p");
  status.className = "first-task-status";
  status.hidden = true;
  const start = document.createElement("button");
  start.type = "button";
  start.className = "first-task-start";
  start.textContent = "Find my first task";
  const detail = document.createElement("div");
  detail.className = "first-task-detail";

  const setStep = (step, state) => {
    const item = stepItems[step];
    if (item) item.dataset.state = state;
  };
  const say = text => { status.textContent = text; status.hidden = false; };

  start.addEventListener("click", async () => {
    start.disabled = true;
    detail.replaceChildren();
    try {
      const result = await runFirstTask({
        api,
        interests,
        onStep: (step, info) => {
          if (step === "claim_conflict") { say(`Someone beat you to “${info.taskId}” — matching the next task…`); return; }
          if (step === "empty") { say("No claimable tasks right now — check back soon."); return; }
          setStep(step, "active");
          if (step === "match") say(`Matched: ${info.task.title}`);
          if (step === "claim") say(`Claiming ${info.taskId}…`);
          if (step === "work") { setStep("work", "active"); say("Claimed — the lease is yours for the next hour."); }
          if (step === "finish") say("Finished — verifying your receipt…");
          if (step === "receipt") {
            setStep(step, "done");
            say("Done — your first receipt is verified below. Welcome to the room.");
          }
        },
        doWork: task => new Promise(resolve => {
          setStep("work", "active");
          const panel = document.createElement("div");
          panel.className = "first-task-work";
          const title = document.createElement("h3");
          title.textContent = task.title;
          const criteria = document.createElement("ul");
          for (const line of task.acceptanceCriteria ?? []) {
            const point = document.createElement("li");
            point.textContent = line;
            criteria.append(point);
          }
          const label = document.createElement("label");
          label.textContent = "Your work (this becomes the public artifact):";
          const box = document.createElement("textarea");
          box.className = "first-task-artifact";
          box.rows = 6;
          label.append(box);
          const done = document.createElement("button");
          done.type = "button";
          done.textContent = "I've done it — finish";
          done.disabled = true;
          box.addEventListener("input", () => { done.disabled = box.value.trim().length === 0; });
          done.addEventListener("click", () => {
            setStep("work", "done");
            panel.remove();
            resolve({ artifactText: box.value, checksReported: ["completed through the guided first-task card"] });
          });
          panel.append(title, criteria, label, done);
          detail.append(panel);
          say("Do the work described above, paste the result, then finish.");
        }),
      });
      if (result.status === "complete") {
        for (const step of FIRST_TASK_STEPS) setStep(step, "done");
        const proof = document.createElement("div");
        proof.className = "first-task-receipt";
        const proofTitle = document.createElement("h3");
        proofTitle.textContent = "Your receipt";
        const proofId = document.createElement("p");
        proofId.textContent = `Receipt ${result.receipt.receiptId} · sha256 ${String(result.receipt.artifact?.sha256 ?? "").slice(0, 16)}…`;
        const link = document.createElement("a");
        link.href = `/receipts/${encodeURIComponent(result.receipt.receiptId)}.json`;
        link.textContent = "View the public receipt";
        link.target = "_blank";
        link.rel = "noopener";
        proof.append(proofTitle, proofId, link);
        detail.append(proof);
        start.remove();
        onDone?.(result);
      } else {
        start.disabled = false;
      }
    } catch (error) {
      say(`Something went wrong: ${error?.message ?? error}. Your lease is safe — try again.`);
      start.disabled = false;
    }
  });

  card.append(heading, lede, list, status, start, detail);
  host.append(card);
  return card;
}
