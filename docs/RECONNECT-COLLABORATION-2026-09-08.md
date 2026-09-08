# Reconnect collaboration and quiet human review

## Outcome

The integrated exercise connects focused work discovery, human clarification,
durable agent attention, process/service restart, an exact stored result and a
separate review. It stops at the human decision: neither viewing the result nor
an agent's pass approves it.

Screenshots exposed a small missing handoff: the decision dialog showed the
result and criteria but omitted the recorded review. It now offers one collapsed
check row. Opening it reveals the exact reviewer, finding and evidence version.
Only a check matching the current completion is shown. Background updates do not
replace the evidence someone is already considering; explicit refresh updates it
and keeps their notes. Sign-out clears the review text. Review and submission-note
disclosures have at least 44px touch targets. No new page, service, permission,
schema or agent tool was added.

## Test design

`scripts/reconnect-collaboration-browser-check.mjs` runs the same scenario in
desktop and touch browser contexts against separate disposable local fixtures:

1. A scripted MCP producer selects its assigned next step, reads selected work,
   accepts, starts and requests a clarification from the owner.
2. The producer disconnects. A simulated human answers in the browser using Enter
   on desktop or Send on touch. The answer does not complete the work.
3. The service closes and reopens the same database and origin. The full audit of
   all 20 application tables must match before and after restart.
4. A fresh producer process resumes its durable attention, reads the exact reply
   and explicitly acknowledges the local notice. Read operations and notice
   acknowledgement do not change Room data or human read markers.
5. Retrying the original question returns the original receipt without reopening
   it. The producer reads paginated discussion, posts an exact draft and submits
   it. A further fresh process retries that submission without duplication.
6. A separately identified scripted MCP reviewer discovers the review handoff,
   reads the exact completion text and records a check against its version.
7. The owner returns using the existing browser session. The decision is blank,
   the result is exact and the check details are collapsed. A newer review disables
   saving until explicit refresh; notes survive and untrusted markup remains text.
8. Expanded details wrap at 200% text. Sign-out clears all new review fields.
   Human approval remains null and all three human-style read markers remain zero.

This is simulated human use plus actual scripted protocol/process integration,
not native-model reasoning, independent human research or retention evidence.
The initial two tests passed before the screenshot-driven UI improvement. The
updated two tests and 552 core/API/package checks also passed; final full-browser
and exact-package qualification are recorded below when completed.

## Evidence

Screenshots and synthetic summaries are under `test-results/`, using the prefix
`reconnect-collaboration-{desktop,touch}`: `-answered.png`, `-decision.png`,
`-review-large.png` and `.json`. Summaries record tool/status traffic, exact result
version, pending human approval and final all-table audit, not access credentials.
Successful runs remove only their own isolated fixture directories.

Existing preview and retained older packages are preserved. No model invocation,
push, deployment, provider operation or live data change is part of this slice.

## Next

Use the integrated journey as regression coverage rather than another product
surface. Next evaluate the highest-friction remaining contributor handoff with
the existing work, clarification and review primitives before adding features.
Native-model acceptance still needs usage approval; independent recovery-authority
freshness and hosted recovery remain separate release gates. The broad goal is
active and incomplete.
