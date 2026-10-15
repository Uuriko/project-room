# Join → contribute → return → review

September 8, 2026. Local implementation slice; not a deployment or a retention claim.

## Scope

Make existing capabilities into a coherent first and returning visit. Preserve the
conversation as the main surface; do not add a dashboard, tour, scoring system,
notification service, inferred assignment, agent execution or permission grant.

1. Join through the existing explicit invitation flow. Preserve access disclosures.
2. Show one relevant next step above catch-up: exact-result review/decision first,
   then an explicit incoming reply request, then an existing assigned-work handoff.
   Within each group, oldest first with deterministic ties. Current facts, not AI
   guesses, govern eligibility. When nothing is assigned and there is no prior
   contribution in a populated room, offer Say hello; opening it preserves existing
   composer drafts. Empty conversations retain their existing composer guidance.
3. More opens existing catch-up, preserving its established work ordering rather
   than reordering familiar items with the priority suggestion. Needs you includes open incoming
   reply requests as well as work. Mark caught up changes only the read marker;
   outstanding requests and work remain visible. No automatic acknowledgement.
4. A returning member gets current unresolved attention from the authenticated
   snapshot. No browser-local completion checklist or fake activity is needed.
5. Review opens the existing version-pinned form. Show definition of done beside
   the exact submitted result; keep summary/next handoff under Submission notes.
   Preserve stale-version refusal, independent review and separate owner approval.

## Interaction constraints

- Show one next step and a short route to the rest. No hover-only controls.
- Opening a suggestion never accepts work, claims scope, runs a tool or approves.
- Keep the focused suggestion stable while it remains relevant. If it disappears,
  move focus to catch-up rather than silently swapping in another target.
- Recheck current eligibility on click. Existing service authorization remains final.
- Keep review context pinned until explicit refresh. Never update criteria under
  a person's in-progress review while retaining an older result.
- Clear suggestion/review content when access ends; preserve exact uncertain sends.
- No new runtime assets, dependencies, database schema or provider connection.

## Verification

Use disposable synthetic identities, not real users or production rooms. Desktop
and touch journeys: join, introduce oneself, answer a real request, leave, receive
a stored result, return, review it, and leave the owner decision pending. Capture
and inspect screenshots. Check no automatic read-marker movement, no approval or
work completion from a reply, no access leakage, and no mobile horizontal overflow.
Pure selector checks cover deterministic ordering, inactive identities, removed
permissions, terminal request/work and no mutation. Run existing catch-up,
invitation, native-result and request recovery regressions, then full browser/core
qualification. Report actual evidence and remaining gates separately.

## Later, not part of this slice

Optional external digests, cross-room personal attention, room archive/restart,
broader durable knowledge, contribution recognition and actual human retention
research. Observer-v3/native-agent request acceptance and hosted release recovery
remain separate unfinished gates; this UI does not imply they are delivered.

## Implementation checkpoint

The slice is implemented locally. No added public assets, dependencies, tables,
agent tool registrations or service authority. The 19-asset build passes.
521 core/API/package checks and 13 local Worker checks (12 runtime + 1 browser)
passed. The Worker browser fixture emits local self-signed TLS diagnostics but
completes its assertions, six return visits and restart successfully; this is not
hosted TLS qualification. Full browser rerun status is recorded in the current
project handoff after completion. Final full browser rerun: **168 passed, 0 failed**.

Focused correction checks: stable catch-up ordering, empty-room mobile composer,
desktop/touch contribution journey all pass (6); final next-step keyboard focus
and selector checks pass (6). The first broad browser run found three regressions
that led to those corrections; those failures were not suppressed or accepted.

Screenshots under test-results/contribution-{desktop,touch}-{request,return,review}.png
document the real rendered local fixture. Desktop and touch return/review captures
were inspected. Full-page capture resets touch media in the current Chromium test
environment, reproduced on a minimal page; touch journey captures therefore use
the viewport and assert touch media before testing Return/newline behavior.

The guest returns using the canonical ?room=commons link, not the member-key entry
at the origin root. The test explicitly grants the synthetic guest review permission
while away. Synthetic owner/service calls produce the result; no autonomous-agent
or human-participant claim is made. Review leaves the human owner decision pending.
