# Manual draft-return checkpoint

Tested local source: `73c04e5b5c375007f1d5d9da94e5b2a34b4770d5` on
`codex/unified-local-20260907`. **Not pushed or deployed.** The existing unbounded
product goal remains active and incomplete.

## What improved

Use my AI → Paste AI draft → Post draft now describes what the flow actually does.
It records a conversation contribution, not completed or independently verified
work. A quiet View latest draft link appears on the work card only when a linked
draft exists. The original source link remains separate. Already-linked drafts
no longer offer a duplicate Make this work action.

The browser adds a stable message ID using the existing command contract. Only an
exact owned receipt clears the draft: correct room, submitter, event type, message
ID and all submitted fields, with positive sequence, valid event identity and a
boolean duplicate flag. Packet ID alone cannot distinguish multiple submissions.

Uncertain saves retry the captured command without rebuilding it from the form.
Pre-ledger errors, including rate limiting, cannot erase earlier uncertainty.
Confirmed post-ledger rejection unlocks correction; explicit older-draft consent
is still required. Draft and retry identity survive close/reopen in this session,
not reload or access loss. The shared refusal helper preserves New work behavior
while removing its duplicate classification logic. Failed button submits restore
an actionable retry without overriding newer focus.

Confirmed saves reveal the exact message, even when unrelated messages arrive.
A confirmed receipt plus failed snapshot instead says to refresh; saving remains
successful. Latest-draft navigation uses canonical message order, preserves other
thread composer text and does not move caught-up markers. Old-session results
cannot clear, announce or navigate a newer draft. A second opener cannot silently
replace an open draft. Both portable editors now genuinely enlarge at 200% text.

No new schema, event, public asset, endpoint, dependency, authority, dashboard,
notification, agent dispatch or analytics channel. No native artifact/evidence
adoption was added. Formal completion still requires reported HTTPS evidence,
an exact version and explicit producer attribution.

## Final verification at the committed source

| Gate | Result |
| --- | --- |
| Syntax and complete core/API suite | 387 passed |
| Complete isolated browser suite | 112 passed |
| Local Workers, including packaged recovery switch | 9 passed |
| Public application asset build | 15 exact assets |
| Production Worker bundle | 203,302 bytes |
| Exact runtime package and standalone verification | 49 files, schema v8, 15 assets |

The final browser run took about116 seconds. New coverage: two pure tests and
12 browser journeys, plus strengthened existing desktop/touch portable checks.
These are 508 automated checks, not 508 people or proof of retention/growth.

Cases include committed/uncommitted malformed successes, wrong actor/message,
first-attempt rate limiting, committed-loss→429→same retry, uncommitted-loss→stale
rejection→explicit correction, failed snapshot after confirmed save, exact-message
and latest-draft navigation, unrelated thread drafts, replacement-session late
success/failure, mobile guest→accountable human discovery, and actual enlarged
editor text. Work state, reported evidence, approval and cursors remain unchanged
by draft posting/navigation.

One added fixture initially attempted browser login with an agent key. The service
correctly rejected it: browser sessions require a human membership. The fixture was
corrected to use a distinct accountable-human work item; no production authority
was weakened. Preliminary/focused runs are not substituted for the final full run.

Root viewed eight synthetic screenshots across this turn:

- `test-results/draft-return-work-linked-draft.png`
- `test-results/draft-return-mobile-accountable-return.png`
- `test-results/portable-desktop-packet.png`
- `test-results/portable-mobile-stale-return.png`
- `test-results/portable-mobile-large-text.png`
- `cloudflare/test-results/cloudflare-desktop.png`
- `cloudflare/test-results/cloudflare-mobile.png`
- `cloudflare/test-results/cloudflare-return.png`

Three read-only agents reviewed the whole journey, runtime/authority/replay and
failure/accessibility behavior. Root was sole source editor. Sites guidance kept
the existing architecture and progressive disclosure, with visual and actual
text-size checks; no Sites registration or hosting switch occurred. Research and
design inferences are in [the plan](DRAFT-RETURN-PLAN-2026-09-07.md).

This slice uses simulated human browser testing and existing scripted API checks;
no additional autonomous participant exercise or actual human study is claimed.
Earlier actual-agent evidence remains separately documented at its own checkpoint.
All test processes exited and their disposable Node fixtures were cleaned by the
test lifecycle. Existing previews and deliberately retained synthetic Workers
evidence were preserved. No new persistent fixture listener or plaintext agent
configuration was left running.

## Release boundary

Package retained outside the checkout:
`../project-room-runtime-packages-20260907/candidate-73c04e5`.

- Source tree: `5d11cc5c062f14a103a452deb4687e3796a7b254`.
- Manifest SHA256: `006f10f2b35fd55628efe6baaf2d93208b773dea5b4f013386d4ff74f498abcb`.

Earlier packages remain unchanged. The exact candidate→pause→frozen7075→candidate
switch passed on the same populated local Workers object, with schema8 and all18
tables. Existing message IDs/proposal fields replay unchanged under the fallback.
Frozen7075 still predates pause mode: independent traffic blocking or a separately
tested pause-capable fallback remains required for real release. This is not
provider PITR/current-authority reconciliation. Node is not Durable Object data
failover. Known local TLS refusal diagnostics were emitted; verification was not
disabled and all nine Workers checks passed.

Recorded live fb90a70 / Worker901be347 / schema7 is unchanged and not reverified.
No push, deploy, wrangler, live migration, provider/account/DNS/Dasha/Desk changes,
payments, paid inference, outreach or recurring automation occurred.

## Next coherent slice

1. Improve generic work-action dialogs (Post evidence, review and decision) with
   exact receipt confirmation, retained unknown retries, owned callbacks/focus,
   and explicit stale-revision reconciliation that preserves entered text. Do not
   silently rebase a decision onto a newer evidence version. Preserve all approval
   and external-action boundaries.
2. Then evaluate a truthful room-native contribution→evidence bridge and a narrow
   opt-in agent read of linked returned drafts. A UI-reported permalink is not
   server-validated evidence; an event semantic change requires fallback/replay
   qualification even without a new SQL table. Do not launch artifact storage or
   automatic promotion just to fill this gap.
3. Continue the broader free/BYO-agent, retention and voluntary-growth priorities.
   Keep features contextual, avoid new dashboards, and distinguish simulations
   from actual users. This checkpoint does not complete or narrow the goal.
