# Updated reply review

## Product decision

Continue the blueprint's private reply journey inside the existing comparison sheet. A write acknowledgment, a subsequent inspection, and a person's review are separate facts. None authorizes sending. This milestone extends runtime 07a13aaaa5b820f579586615b93312a084ce4061, documentation checkpoint a2c8956fd220a4ab73ce326388bf37a9cf15435e. The ambitious Project Room goal remains active; this is local fixture qualification.

Microsoft's [Get message](https://learn.microsoft.com/en-us/graph/api/message-get?view=graph-rest-1.0) documents returned message representations and the text-body preference; its [message resource](https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0) defines an opaque version. Neither is evidence of an atomic conditional update or a globally latest snapshot. We therefore say “Different mailbox version,” not “newer,” and “Last checked draft,” not “current mailbox.” Actual provider representation and concurrency remain to be qualified.

## Implemented contract

The trusted fixture driver prepares a child-specific inspection context before a read. Recording the normalized response requires that exact account, authorization epoch, source, parent, update revision and connection still match. A read started before a delayed acknowledgment cannot become post-write evidence merely by arriving afterward. Exact retries retain the original receipt, with current account authentication still required.

A review is bound to the acknowledged dispatch, fresh inspection, current saved local draft and current source/connection context. Unsupported bodies, unavailable observations and incorrect identities do not become reviewable. Reauthorization of the same mailbox permits a fresh inspection and review; it does not revive an old review. A newer parent observation also invalidates the old child review basis.

Review resolves the update's accounting state while preserving creation history, original text, checked mailbox text and local writing. It never adopts mailbox text, sends a message or authorizes another write. A later inspection invalidates the displayed content review even when the prior update remains historically resolved. A subsequent body-only proposal uses the latest actual recorded read, not an older snapshot carried inside a later acknowledgment. Unknown write outcomes without acknowledgment remain unresolved.

The account-private review route negotiates v4, exposing only the minimal child preview and exact review target. Prior view vocabularies remain conservative. The public review action cannot dispatch writes or record driver inspections; its receipt excludes provider plans and identifiers. The same comparison sheet handles both original and updated drafts. Original text stays collapsed, desktop columns stack on mobile, and differing local text remains visibly separate. Copy is compact: “Review only · not sent,” or “Review checked draft” when a deliberate comparison is necessary.

Shared preview serialization and reviewability checks avoid parallel implementations. Schema25 adds no table; the allowlisted runtime gains one small inspection/review module. Older writers are fenced. Genuine v23/v24 child histories migrate without rewriting receipts, and pre-v25 resolution-shaped collisions roll back instead of being reinterpreted.

## Qualification

Coverage includes acknowledgments crossing inspections, changed local text, same-mailbox reauthorization, unsupported content, exact retries, parallel writers, two browser tabs, lost review responses, desktop/mobile flows, legacy projections, narrow HTTP receipts, migration rollback, cold packaging and local Workers restarts. Screenshots contain fictional mail. These are simulated human journeys, not proof of delight, retention or live-provider compatibility.

The initial working-tree suites passed 914 core, 70 browser and 26 local Workers checks before the last migration coverage and cleanup. Additional focused migration tests passed. Final committed verification is recorded below, rather than treating those preliminary counts as final.

Failures found during development: an unresolved-update test exposed validation ordering that hid uncertainty behind a no-op result; the unresolved-child check now takes precedence. Cold packaging exposed a missing new module in the candidate-fixture allowlist, which is now included. A genuine migration expectation still named the old writer fence and was corrected. The new HTTP test initially used the wrong preview field and expected 200 instead of the route's existing 201-on-create contract; corrected tests pass. These fixture mistakes are not provider interoperability evidence. Preserved logs distinguish failed initial runs from passing final runs.

## Remaining work

No live provider calls, mailbox credentials, external sending, money, paid models, push or deployment are enabled by this checkpoint. Desk, Dasha and Demigod remain untouched.

Before exposing a real edit control: qualify a dedicated authorized mailbox, provider concurrency and body representations, credentials, uncertainty recovery and operational limits. Same-mailbox reauthorization now supports inspection/review, but future update proposals still conservatively require the original creation context; a deliberate rebase design remains. Inspection/review still obey the pilot command cap, so capacity recovery needs an explicit operational policy. Sent, deleted and unsupported drafts stay read-only. A newer parent observation can invalidate a child review while the sheet retains the last child-specific checked snapshot; presentation of that distinction deserves the next focused design test.

Continue the broader talk/reply/work journeys and actual agent participation after this checkpoint. Do not treat completion of this slice as completion of the product goal.

## Committed checkpoint

Runtime implementation `fb71e89f5c48cae480c9778f9815e8e359afa0eb` passed **71 browser** and **26 local Workers** checks. Its first core run passed 915 of 916: the exact-commit packaging test had a separate historical module-count list that omitted the new module. Commit `8db1aed0bf34686aa1de3d4ff4bd32499bcf861d` changes only that test expectation; the full core rerun passed **916 of 916**. All processes completed successfully. That is **1,013 passing checks** across the qualified suites, not 1,013 newly added tests. Browser and Workers suites ran on fb71e89, not on the later test-only commit; the packaged runtime file entries were explicitly compared and are identical.

The offline package `/private/tmp/project-room-review-final-Gt1ETE/runtime` verifies source commit 8db1aed, schema25, 82 files and 24 public assets. Manifest SHA-256: `7cbb73939b37653a206fc3cd961dd62ff1cc7e3c788c9d10c978bed6a228eda2`. This proves file consistency, not deployment or live interoperability.

Evidence is retained in `test-results/reply-update-review-20260909/`: final core log, committed browser/Workers logs, initial failed core log, focused failed and passing HTTP logs, focused migration/recovery/browser logs, both package manifests and five inspected screenshots. The post-review desktop/mobile screenshots show one Close action and “Reviewed · not sent”; the differing-version screenshot shows both texts without replacing either. Only documentation changes follow the test correction. The goal remains active and no live service was changed.
