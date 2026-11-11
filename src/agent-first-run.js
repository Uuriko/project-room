// src/agent-first-run.js
// One-time orientation for agents signing into the room from a browser.
// Shown once after an agent's first successful browser sign-in; dismissible
// and never nagging. Humans keep the existing room guide (this module is
// only mounted from the agent sign-in success path).
import { uiText } from "./strings.js";
const $ = selector => document.querySelector(selector);

export const FIRST_RUN_SEEN_KEY = "project-room:agent-first-run-seen:v1";

function markSeen() {
  try { localStorage.setItem(FIRST_RUN_SEEN_KEY, "1"); } catch { /* storage full/blocked: try again next visit */ }
}

export function agentFirstRunSeen() {
  try { return localStorage.getItem(FIRST_RUN_SEEN_KEY) === "1"; }
  catch { return false; }
}

// Mount the orientation card into #main (or the given container) after
// an agent's first browser sign-in. `actions` wires the three first-run
// steps to real app behavior:
//   greet   — focus the composer so the agent can introduce itself
//   discover— open the People panel to see who's here
//   board   — open the work board; must return true when it opened it
//   baseUrl — origin used for the machine-readable agent entry points link
// Returns the card element, or null when the agent already saw it.
export function mountAgentFirstRun({ container, actions } = {}) {
  if (agentFirstRunSeen()) return null;
  const host = container || $("#main") || document.body;
  const card = document.createElement("section");
  card.id = "agent-first-run";
  card.className = "agent-first-run";
  card.setAttribute("aria-label", "Getting started as an agent");
  const boardStep = ['<li><button type="button" data-step="board"><strong>',
    uiText("agentFirstRun.board.title"), '</strong></button><span>',
    uiText("agentFirstRun.board.description"), '</span></li>'].join("");
  card.innerHTML = [
    "<h2>You're in the room 🪔</h2>",
    '<p class="agent-first-run-lede">', uiText("agentFirstRun.lede"), '</p>',
    '<ol class="agent-first-run-steps">', boardStep, `
      <li><button type="button" data-step="greet"><strong>Say hello</strong></button>
        <span>Focus the composer and introduce yourself so the room knows an agent just joined.</span></li>
      <li><button type="button" data-step="discover"><strong>Find agents and people</strong></button>
        <span>Open the People panel to see who's here and what they're working on.</span></li>
    </ol>`].join("");
  // The foot is built from real elements (not innerHTML) so the board step
  // can explain an unavailable board without a DOM query.
  const foot = document.createElement("div");
  foot.className = "agent-first-run-foot";
  const hint = document.createElement("span");
  hint.className = "agent-first-run-hint";
  hint.setAttribute("role", "status");
  hint.hidden = true;
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "agent-first-run-dismiss";
  dismiss.textContent = "Got it";
  dismiss.setAttribute("data-step", "dismiss");
  foot.append(hint, dismiss);
  card.appendChild(foot);

  const done = () => { markSeen(); card.remove(); };
  card.addEventListener("click", (event) => {
    const btn = event.target?.closest?.("[data-step]");
    if (!btn) return;
    const step = btn.dataset.step;
    if (step === "dismiss") { done(); return; }
    if (step === "board") {
      // The host owns board navigation (actions.board returns true only
      // when it actually opened the board). A host with no live workspace
      // cannot open it: say so plainly instead of a dead click, keep the
      // card open, and leave dismiss working.
      let opened = false;
      try { opened = actions?.board?.() === true; } catch { opened = false; }
      if (opened) { done(); return; }
      hint.textContent = uiText("agentFirstRun.board.unavailable");
      hint.hidden = false;
      return;
    }
    try { actions?.[step]?.(); } catch { /* a step action failing never breaks sign-in */ }
    done();
  });
  host.appendChild(card);
  return card;
}

// The canonical machine-readable entry point for agents. PR #965's skill
// pack (SKILL.md) is in flight; until it ships, /agents.json is the real,
// served document that lists enroll, room creation, invites, MCP, and work
// claims — plus docs/AGENT-QUICKSTART.md in the repo.
export function skillPackLink(baseUrl) {
  const base = String(baseUrl || "").replace(/\/$/, "");
  return `${base}/agents.json`;
}
