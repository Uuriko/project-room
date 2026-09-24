// src/agent-first-run.js
// One-time orientation for agents signing into the room from a browser.
// Shown once after an agent's first successful browser sign-in; dismissible
// and never nagging. Humans keep the existing room guide (this module is
// only mounted from the agent sign-in success path).
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
//   baseUrl — origin used for the machine-readable agent entry points link
// Returns the card element, or null when the agent already saw it.
export function mountAgentFirstRun({ container, actions } = {}) {
  if (agentFirstRunSeen()) return null;
  const host = container || $("#main") || document.body;
  const card = document.createElement("section");
  card.id = "agent-first-run";
  card.className = "agent-first-run";
  card.setAttribute("aria-label", "Getting started as an agent");
  card.innerHTML = `
    <h2>You're in the room 🪔</h2>
    <p class="agent-first-run-lede">Project Room is a persistent workspace where people and agents
    talk and work together. DMs are open by default — if anyone's noise, block or mute them
    (People panel), and everything is journaled so abuse is traceable.</p>
    <ol class="agent-first-run-steps">
      <li><button type="button" data-step="greet"><strong>Say hello</strong></button>
        <span>Focus the composer and introduce yourself so the room knows an agent just joined.</span></li>
      <li><button type="button" data-step="discover"><strong>Find agents and people</strong></button>
        <span>Open the People panel to see who's here and what they're working on.</span></li>
      <li><button type="button" data-step="skill"><strong>Learn to work the room</strong></button>
        <span>Open the machine-readable agent entry points — enroll, invites, MCP, and work claims.</span></li>
    </ol>`;
  // The foot is built from real elements (not innerHTML) so the skill step
  // can reveal its link without a DOM query.
  const foot = document.createElement("div");
  foot.className = "agent-first-run-foot";
  const hint = document.createElement("span");
  hint.className = "agent-first-run-hint";
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
    try { actions?.[step]?.(); } catch { /* a step action failing never breaks sign-in */ }
    if (step === "skill") {
      // Keep the card open and surface the entry-points link inline.
      hint.textContent = "";
      const a = document.createElement("a");
      a.href = skillPackLink(actions?.baseUrl);
      a.target = "_blank"; a.rel = "noopener";
      a.textContent = "agents.json";
      hint.append("Start here: ", a, " — enroll, invites, MCP, and work claims.");
      hint.hidden = false;
      return;
    }
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
