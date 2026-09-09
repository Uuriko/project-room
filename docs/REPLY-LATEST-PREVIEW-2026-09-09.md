# Latest recorded reply preview

## Decision and scope

The previous turn made concrete progress: schema25 inspection/review, exact recovery and preserved local text were committed and qualified. Starting state for this turn was clean `3c5af28`. The full product goal remains active; no scope or completion criteria changed. Current lane and bus checks found no conflicting edits or unread requests.

The blueprint requires correct messaging state and preserved drafts. The design guide requires stable reading position, honest uncertainty and minimum sufficient copy. Inspection found a mismatch between authority and display: a newer parent read invalidated a child's review correctly, but the v4 sheet could still show the older child's text. A refreshed open sheet also compared IDs/revisions without comparing the inspection version and current review permission. This could leave an outdated status above a disabled control.

Two designs were considered: add another view/version with explicit freshness fields, or use the existing preview contract to display the latest recorded read and revoke a captured comparison when its basis changes. The latter needs fewer concepts and no new destination, schema, storage format or transport permission. The private projection already describes a checked snapshot, not a guarantee of live freshness. Existing provider research and the prior review document remain applicable; no new claim about provider consistency is made here.

## Implemented

One account/attempt-scoped query now supplies the latest actual read to both future-update proposal bases and the v4 display. An acknowledgment is not a read. An unavailable read is not absent history and never falls back to older successful text. Latest supported or unsupported observations are compared against the child's proposal for display; the separate child-bound inspection qualification still determines whether review is allowed. Older negotiated views and historical receipts remain unchanged.

The comparison's captured basis now includes inspection version, source/local revisions and review permission/currentness, not only the child ID and revision. A background refresh keeps the visible text still, disables an obsolete review and tells the user to close and review again. Reopening shows the latest recorded read. Fresh child inspection is still necessary before review; seeing text does not confer authority.

Previously resolved but no-longer-current reviews say “Review out of date · not sent.” Missing previews say “Draft unavailable · not sent,” with Close as the single primary action. Read-only entry uses View reply rather than suggesting a review can be confirmed. Local writing, original creation intent and prior review evidence are preserved.

## Verification plan and results

The new core regression checks successful later reads, unavailable reads, unsupported HTML, preserved child/local evidence and invalidated review permission. Desktop/mobile browser regressions hold a comparison open during a newer parent read, attempt a queued confirmation, reopen the latest text and complete a fresh child review without adopting mailbox text. Another browser journey covers an already-reviewed update becoming stale and then unavailable through reload. Local Workers coverage carries the same unavailable-read state through a durable-object restart.

Focused core/client coverage passed 42 tests; desktop/mobile captured-preview coverage passed two; stale/unavailable browser coverage passed one. An initial core test incorrectly asked its fixture to construct a plaintext response from an already-normalized unsupported HTML body. Passing the original explicit HTML response corrected the fixture; the runtime continued to reject the malformed response. The initial failure log is retained. Exact committed suites and screenshots follow below.

## Next and boundaries

This improves a real interaction without claiming a live mailbox fetch. Provider freshness, source/connection rebasing for subsequent updates, capacity recovery, dedicated-account qualification and live operational readiness remain incomplete. No provider I/O, sending, paid models, money, publishing, deployment or other product edits are authorized or performed by this checkpoint. Continue the full blueprint rather than treating this display fix as product completion.
