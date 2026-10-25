// Front door: one question, then GitHub sign-in. The answer is stashed for
// the OAuth round-trip and the first room is created from it. /about still
// freshens its live facts from /api/public/front-door when that page is up.
const WORK_KEY = "pr-front-door-work";
const START_KEY = "pr-start-room";

function readWork() {
  try { return sessionStorage.getItem(WORK_KEY) || ""; } catch { return ""; }
}

function writeWork(value) {
  try { sessionStorage.setItem(WORK_KEY, value); } catch { /* storage may be blocked */ }
}

function clearWork() {
  try { sessionStorage.removeItem(WORK_KEY); } catch { /* storage may be blocked */ }
}

function markStart() {
  try { sessionStorage.setItem(START_KEY, "1"); } catch { /* storage may be blocked */ }
}

function currentWork() {
  const input = document.getElementById("front-door-work");
  const typed = input ? input.value.trim().slice(0, 80) : "";
  return typed || readWork();
}

function stashWork() {
  const work = currentWork();
  if (!work) return "";
  writeWork(work);
  markStart();
  return work;
}

function installFrontDoor() {
  const input = document.getElementById("front-door-work");
  if (!input) return;
  const github = document.getElementById("github-signin");
  const google = document.getElementById("google-signin");
  const form = document.getElementById("front-door");
  if (github) {
    github.addEventListener("click", event => {
      if (!input.value.trim()) {
        event.preventDefault();
        input.focus();
        return;
      }
      stashWork();
    }, true);
  }
  if (google) google.addEventListener("click", () => { if (input.value.trim()) stashWork(); }, true);
  if (form) {
    form.addEventListener("submit", event => {
      event.preventDefault();
      if (!stashWork()) { input.focus(); return; }
      if (github && !github.hidden) github.click();
    });
  }
}

function installRoomCreate() {
  if (!document.getElementById("front-door-work") && !readWork()) return;
  const original = globalThis.fetch.bind(globalThis);
  let flight = null;
  globalThis.fetch = (input, init = {}) => {
    const url = typeof input === "string" ? input : input?.url || "";
    const method = String(init.method || (typeof input !== "string" && input?.method) || "GET").toUpperCase();
    if (method === "POST" && url.includes("/api/account/ensure-default-room") && readWork()) {
      if (!flight) {
        const work = readWork();
        const headers = new Headers(init.headers || (typeof input !== "string" && input?.headers) || undefined);
        const roomId = `room-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
        flight = original("/api/account-rooms", {
          method: "POST",
          credentials: init.credentials || "same-origin",
          headers,
          body: JSON.stringify({
            roomId,
            title: work,
            purpose: work,
            kind: "personal",
            displayName: "Owner",
            intent: work,
            start: 1
          }),
          signal: init.signal
        }).then(response => {
          if (response.ok) clearWork();
          else flight = null;
          return response;
        }, error => {
          flight = null;
          throw error;
        });
      }
      return flight.then(response => response.clone());
    }
    return original(input, init);
  };
}

installFrontDoor();
installRoomCreate();

if (document.getElementById("fd-verified")) {
(async () => {
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el && value != null && value !== "") el.textContent = String(value);
  };
  const hide = (id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  };
  const showEmptyState = () => {
    // No published receipts on this deployment: the sample must never be
    // presented as this deployment's record. Show the empty state instead.
    hide("fd-sample-badge");
    hide("fd-receipt-row");
    hide("fd-receipt-facts");
    hide("fd-card-note");
    hide("fd-receipt-cta");
    set("fd-card-title", "No receipts yet");
    const empty = document.getElementById("fd-empty");
    if (empty) empty.hidden = false;
  };
  try {
    const response = await fetch("/api/public/front-door", { headers: { accept: "application/json" } });
    if (!response.ok) return;
    const facts = await response.json();
    set("fd-verified", facts.counters?.resultsVerified);
    set("fd-receipts", facts.counters?.receiptsIssued);
    set("fd-work", facts.counters?.workAvailableNow);
    const receipt = facts.latestReceipt;
    if (!receipt?.id) { showEmptyState(); return; }
    const link = document.getElementById("fd-receipt-link");
    if (link) {
      link.href = `/receipts/${receipt.id}`;
      link.textContent = receipt.title ?? receipt.id;
    }
    const primary = document.getElementById("fd-receipt-cta");
    if (primary) {
      primary.href = `/receipts/${receipt.id}`;
      primary.textContent = "See a real receipt";
    }
    hide("fd-sample-badge");
    set("fd-who", [...(receipt.agents ?? []), ...(receipt.humans ?? [])].join(", "));
    const when = document.getElementById("fd-when");
    if (when && receipt.at) {
      when.textContent = String(receipt.at).slice(0, 10);
      when.dateTime = receipt.at;
    }
    // Same honesty ladder as the receipt page itself: only a receipt with a
    // server-verified merge may say so; anything else claims recording only.
    set("fd-proves", receipt.mergedAt && receipt.pullRequest
      ? "The server verified the merge against the linked pull request. Open the receipt for the checks, the evidence, and the full record."
      : "The room recorded this work and made it public. Open the receipt for the checks, the evidence, and the full record.");
    set("fd-card-note", "This card shows the newest published receipt, counted live.");
  } catch {
    // Static card stays — it is labelled a sample, so it stays honest.
  }
})();
}
