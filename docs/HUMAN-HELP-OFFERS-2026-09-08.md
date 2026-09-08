# Human and agent help, together

Local candidate following `41a4db3`. The broader product goal remains active;
this is one complete coordination flow, not publication or full-product readiness.

## Interaction

The existing **Help wanted** disclosure now contains **Offer help**, current
contribution plans and contextual choices. No dashboard, settings page or new
top-level navigation is added. A short plan is the only new field when offering.
Choosing a helper, declining or withdrawing asks for a short note. Release also
requires acknowledging that outside work may still be running.

Pending alternatives stay visible. Selected helpers sort first. Ended offers sit
under a closed **Past offers** disclosure. A selected helper remains visible as
**Review needed** when the invitation changes or expires, including without a new
room event. Ending an invitation does not release its helper or stop outside work.

Selection remains coordination only: it changes no accountable member, assignment,
task revision, execution permission or payment authority. The existing result,
review and human-decision workflow remains separate.

## Implementation and boundaries

- Reuses the existing action dialog, exact command retry, receipt validation,
  session ownership, disclosure preservation and service offer state machine.
- Browser full-room refresh requests `X-Project-Room-Offer-Context: 1`; the
  service advertises `offerContextVersion: 1` only when requested. Default API
  reads and compact invitation discovery remain unchanged.
- Missing/invalid offer context never advertises an empty or available queue.
  When retained offers are known but cannot be interpreted, the disclosure says
  **Offers unavailable** with no offer actions.
- Work, invitation, offer and relevant member revisions are pinned while editing.
  A background update never silently refreshes those references. Explicit review
  reloads current scope while retaining the user's note.
- A lost or mismatched receipt keeps the entire original command. Close/reopen
  resumes its exact retry even after consent changes. A known refusal needs review.
- Live updates preserve the composer and offer draft, focus and open disclosures.
  Clock-only expiry refreshes both the work card and the open action's availability.
- Scope, plans and notes are rendered as text. No external evidence or provider
  credentials are loaded by this UI.

## Verification and evidence

Working-tree core regression: **682/682 passed**.
Existing invitation browser checks: **9/9 passed**.
New human/agent offer browser checks: **11/11 passed**.
Local Workers HTTP check: **1/1 passed**, extended for browser negotiation.

The new browser suite covers desktop/mobile human offers alongside a separately
credentialed scripted MCP helper; selection, retained alternatives, changed
consent, explicit release, decline, withdrawal, a concurrent winner, draft
comparison, lost/mismatched receipts, unsupported/malformed snapshots, literal
untrusted text, clock-only expiry and preserved focus during an incoming offer.

Browser actors are simulated people; the MCP actor is scripted, not an independently
reasoning model or native vendor-host acceptance. No human delight or retention
claim follows from these checks.

Evidence directory: `/tmp/project-room-human-offers.kP2wxj`.
Passing logs: `core-final.log`, `invitations.log`, `offers-verified.log`,
`workers.log`. Final committed reruns, when present, use `committed-*.log`.
Earlier attempts are preserved separately: the first browser scope assertion
needed to wait for the async refresh, and the selection actor needed to wait for
the latest controls before opening the disclosure. A core hook check also caught
dynamic dialog fields queried as global static hooks; they are now dialog-scoped.

Screenshots under `test-results/` show desktop/mobile offer composition, alternatives
and selected-helper review state. These images were visually inspected. Test JSON
files record simulated-human/scripted-MCP scope. Temporary evidence should be
retained before cleaning that directory.

## Next coherent slice

Make the handoff from a selected helper to a reviewable contribution equally
obvious. Reuse stored drafts/results, retain author and producer attribution,
show the exact contribution being adopted, and keep assignment/dispatch/payment
separate. Test the full human + agent offer → selection → original contribution →
accountable adoption → independent review → human decision journey. Do not add
another competing task or result model.

The running previews and live site were not replaced. No push, deploy, external
account connection, model call, message relay or payment occurred.
