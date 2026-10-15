# Outside contributor credit

Local implementation checkpoint: `1e075981f58239b9c2d5cd390c3fbe1f0ceb3313`, schema 26. Not deployed.

## Product outcome

An owner can bring a draft back from another person or AI and credit its producer without enrolling that contributor. The existing result form adds **Outside person or AI**; choosing it reveals one **Credit** field. Other choices keep that field hidden and exclude its value from submission. Switching choices preserves the local name. No new navigation, account flow, or tool is introduced.

The result details and catch-up history identify outside credit as reported. A compact **Outside credit** status replaces the misleading unknown-producer label. Ordinary evidence review remains useful, but does not become confirmed independent review.

## Contract

| Choice | Stored attribution | Effect |
| --- | --- | --- |
| Room member | Existing member ID; `reported` | Existing reported-member rules |
| Outside person or AI | Null member ID; `external-reported`; `externalProducer` | Credit only |
| Unknown | Null member ID; `unknown` | No producer asserted |

`externalProducer` is an optional, nonblank, well-formed string of at most 160 UTF-16 code units. It preserves the submitted value. It cannot coexist with a non-null member producer ID. It is not a credential, identity proof, connection, invitation, or claim that an outside AI actually ran.

The existing direct completion command and MCP tools `room_record_completion` and `room_submit_text_result` accept the same optional field. Native text results still require explicit `producerId: null` when outside credit is supplied. External-link completions may omit the member ID. Read results and selected-work context retain the credit; exact receipt validation, replay, audit and retries preserve it.

## Review and authority

- The submitter remains the authenticated room participant; outside credit cannot impersonate a participant.
- No membership, access, work assignment, reviewer permission, read marker or external action follows from credit.
- A designated reviewer may record a useful check of the exact evidence. With outside credit, that check records `independenceConfirmed: false`.
- If the work requires independent verification, that check cannot unlock approval. Existing work policies are not changed.
- Previously saved results and their reviews are not silently rewritten or transferred.
- An uncertain save locks the original inputs. Closing, reopening and retrying uses the identical operation, including the name.

This separation follows the useful distinction between attribution and acting on behalf of another agent in [W3C PROV-O](https://www.w3.org/TR/prov-o/). Project Room does not implement or claim PROV certification.

## Upgrade boundary

Schema 26 changes stored attribution semantics without adding a table. The writer fence is nevertheless advanced: a version-25 writer must not replay or overwrite a version-26 receipt and discard its meaning.

Migration preserves valid historical room data. An older database already containing the formerly unsupported outside-credit field is rejected for operator reconciliation rather than retrospectively reinterpreted. Migration remains transactional; failures roll back the version, fences and data. Local SQLite and the actual local Workers adapter both retire already-open older writers.

This is upgrade compatibility, not a security boundary against an administrator with database access. A schema-25 binary is not a rollback target for a migrated schema-26 store. Any eventual deployment needs its own backup, migration and rollback plan and current authorization.

## Qualification

- **926 core tests passed**, including strict inputs, exact native reads, replay, unchanged members, evidence review, approval gates, a genuine MCP subprocess with restart/retry, and actual historical SQLite migrations through version 25.
- **27 local Workers tests passed**, including historical versions 7–25 upgrading to 26, transaction rollback, cached old-writer refusal, outside credit retention and restart.
- **46 surrounding browser/harness checks passed** before the final catch-up-label and scoped-form-selector polish.
- **11 final browser checks passed** on the committed runtime: outside credit desktop/mobile, exact uncertain retry, catch-up attribution, native results and quiet attribution.
- People in these browser exercises are simulated. The MCP test is a real protocol subprocess driven by a script, not a separately reasoning AI or an independent human reviewer.
- No provider calls, real mailbox activity, outbound messages, payments, new inference runs, push or deployment were performed.

The first browser run used an agent credential at the human login screen and was correctly refused; the fixture now explicitly seeds a simulated human reviewer. The first broad suite also identified stale version-25 test expectations and dynamic form selectors inconsistent with the static-hook check. These were corrected, and the complete suite reran successfully.

Screenshots were inspected at:

- `test-results/external-credit/desktop-76933c92-69be-4ba8-b40d-1a3910e73664/return/adopt.png`
- `test-results/external-credit/desktop-76933c92-69be-4ba8-b40d-1a3910e73664/checked.png`
- `test-results/external-credit/mobile-d01c6c60-2afc-44dd-8973-7042df4a2c31/return/adopt.png`
- Earlier successful mobile review: `test-results/external-credit/mobile-1684226c-28bc-4ada-881a-0602b8b47ef0/review.png`

The final directories also contain scripted evidence, exact commands and result snapshots. Disposable fixture stores and credentials were removed by test cleanup; screenshots and synthetic evidence remain locally.

Offline runtime package: `/private/tmp/project-room-external-credit-package-1ojkZd/runtime`.
Verified 82 files, 24 public assets, schema 26.
Manifest SHA-256: `2ce81c2b89dc8a6c67fe61eccb0381f96df1e21e2d9a7b526845bf02db0fac66`.

## Next work

1. Design explicit identity resolution for outside contributions, including shared human/AI authorship and how a reviewer can establish independence. A name alone must never be upgraded automatically into identity or authority.
2. Make the unresolved-provenance next step actionable while retaining useful review on lower-risk work. Do not add mandatory enrollment to the manual contribution path.
3. Continue the existing mailbox reconnect/context-rebase and capacity-policy work.
4. Qualify an actual native AI host and an independent reviewer only with the required usage/access authorization.
5. Keep the broader unified-product goal active. This checkpoint completes the outside-credit slice, not the full goal.
