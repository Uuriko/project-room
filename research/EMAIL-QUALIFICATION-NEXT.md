# Next: qualify a real email boundary without pretending the sample is a mailbox

September 8, 2026. Research and proposed implementation sequence, not connected-provider evidence.

## Implementation update

The first code slice now qualifies Microsoft Graph-shaped message data in the unified checkout: `server/email-envelope.mjs`, `server/graph-email.mjs`, the invented `scripts/email-contract-fixture.mjs` and `tests/email-contract.test.js`. The [implementation contract](../docs/EMAIL-IMPORT-CONTRACT-2026-09-08.md) records the exact scope and the durable-import sequence. This is data normalization, review-only reply projection and folder-delta classification—not a live connection or persistence migration. Graph's structured addresses made it the first adapter shape; Gmail remains on the roadmap, with its different MIME/address boundary still to qualify.

The subsequent [durable import implementation](../docs/EMAIL-IMPORT-PERSISTENCE-2026-09-08.md), runtime `b0c0800`, now stores account-owned fixture connections, imported email versions and sync checkpoints while retaining private drafts. Schema 19 also rejects stale cross-folder observations using the message revision captured before hydration. Historical schema-18 records remain replayable. This is local implementation, not a real mailbox connection or deployed feature. Final verification is recorded in the runtime checkpoint rather than inferred from this plan.

The [offline sync driver](../docs/GRAPH-FIXTURE-SYNC-2026-09-08.md), runtime `fcc52b6`, now prepares pages from cloned invented recordings, hydrates duplicate/removal notifications, validates exact mailbox/folder cursor paths and reports reset-required without changing saved messages. Node cold-package and local Workers restart fixtures exercise it. It is not a network driver, background grant or live provider integration. The next product-facing slice is negotiated email reading and draft continuity in the same Inbox.

## Immediate next slice: one Inbox, not another mail product

1. Add an offline fixture driver. Capture connection, folder checkpoint and source revision before hydration; coalesce duplicate invalidations; re-fetch on source conflict. Prove incomplete pages, expired cursors, reconnects and cross-folder races without a network call. Never retry an old payload by merely replacing its expected revision.
2. Negotiate email support explicitly between the existing browser client and Inbox service. Older clients keep their existing source list. The user still opens Inbox, selects a message and edits their private draft—no extra top-level navigation or mandatory work item.
3. Begin with plain-text messages. Show sender, subject and body; put recipient detail, channel identity and attachment availability in compact contextual controls. Do not flatten HTML or present missing attachment bytes as downloadable files. Keep sender/account identity unambiguous when replying.
4. Reuse the existing draft and selected-sharing lifecycle. Specify a canonical text-selection anchor tied to the exact imported source revision before exposing Ask room for email. Share only the reviewed excerpt, not recipients, metadata, later messages or the whole mailbox. Preserve selection and drafts across room visits and reload.
5. Keep real send controls unavailable until provider-specific submission and uncertain-outcome handling are qualified. A fixture draft is not evidence of delivery. Test owner and room-member boundaries, stale responses, account switching, keyboard behavior, mobile return navigation and screenshot comparisons.
6. Record observed friction from simulated people separately from actual agent participation. A successful scripted journey does not prove human delight, retention or willingness to connect a mailbox.

Exit gate: a fixture-imported plain-text email is usable in the existing Inbox, retains its draft through restart and a room round-trip, and supports an explicitly reviewed excerpt-to-result loop without exposing private headers. Real provider qualification is a subsequent, separately authorized gate.

### Existing-UI integration details

- Add an explicit email-view capability to list/read responses and verify it in the client; do not weaken the current synthetic-source validator into accepting arbitrary channel objects.
- Derive one bounded plain-text view and exact selection anchors from the immutable imported version. Reuse the derivation for rendering, selected-sharing preview and journal verification. Avoid separate client/server paragraph heuristics.
- Replace the fixed “Sample message” label with truthful channel/account state. Keep sender and subject prominent; put full recipients and attachment availability in a contextual detail section. Do not include Bcc in normal address summaries or shared excerpts.
- The current send UI calls the synthetic sends endpoint when a source is opened. Gate this by the negotiated source capability before showing imported mail; a sample transport being available does not authorize email sending. Draft saving remains useful without any send control.
- Preserve draft and reader state on room visits. When refreshed imported content changes, keep the existing explicit review/merge behavior instead of replacing typed text.
- Qualify plain-text excerpt sharing as a journal contract before enabling Ask room for email. Preserve historical synthetic share receipts exactly; introduce a writer-compatibility change if the new replay semantics require it. HTML remains a separate rendering/selection qualification, not regex stripping.

## Why account home matters

The account-first Inbox removes room membership as a prerequisite for private messages. The current source format and transport are still deliberately synthetic: source data contains sender, recipient, subject and paragraphs; the sample transport requires a synthetic adapter. Do not remove those checks just to label the existing demo “Gmail.”

## Verified external constraints

Google distinguishes send-only access from mailbox-reading access. gmail.send is sensitive; gmail.readonly is restricted. Its current scope guidance says storing or transmitting restricted-scope data on servers requires a security assessment. A server-backed personal inbox therefore has an approval/verification path beyond implementing OAuth. Choose the narrowest scopes for the actual feature and verify the applicable review requirements before a pilot. [Google scope guidance](https://developers.google.com/workspace/gmail/api/auth/scopes).

Gmail threading requires a matching threadId, compliant References and In-Reply-To headers, and matching Subject headers. Our current paragraph-only source cannot faithfully represent that boundary. Preserve these provider facts in the private domain instead of guessing reply relationships from display names or subjects. [Gmail threads](https://developers.google.com/workspace/gmail/api/guides/threads).

Gmail incremental history can expire; an out-of-range startHistoryId returns 404 and requires full synchronization. A sync checkpoint is not permanent authority. A fresh sync must merge current provider observations without silently deleting unsent local drafts. [Gmail synchronization](https://developers.google.com/workspace/gmail/api/guides/sync).

Microsoft Graph sendMail returns 202 without a response body. This confirms acceptance, not completion or delivery. Adapter capabilities must describe the evidence a provider actually supplies, not force every provider to imitate the synthetic fixture's lookup guarantee. [Graph sendMail](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0).

The Gmail send reference defines a Message response but does not establish the synthetic adapter's application-level operationId contract. Treat stable retry/reconciliation support as something to qualify per provider, not as a guarantee inherited from our test driver. [Gmail send](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send).

## Proposed next implementation

1. Define a private connection record: owning account, provider/account identity, granted capabilities, connection revision, last verified state and private credential reference. Agent membership is not mailbox authority.
2. Introduce a versioned imported-email envelope: provider message/thread IDs, sender and reply-to, recipient lists, subject, dates, relevant reply headers, normalized body parts and attachment descriptors. Keep original-provider facts distinct from rendered preview text.
3. Build a recorded-fixture adapter with no external network: inbound pagination, repeated observations, expired sync cursor, reconnect, revocation, changed thread, malformed MIME and unsupported evidence. Exercise real-shaped payloads before storing real messages.
4. Make the composer truthful about channel and exact sending account. Preview recipients, thread relationship and attachment versions. A changed connection or envelope requires fresh review.
5. Define per-provider submission and reconciliation. Reserve one exact intent, mark dispatch before making the outside call, never infer “not sent” merely from an empty search or failed request, and offer human reconciliation when evidence is insufficient.
6. Qualify a dedicated test mailbox only after provider/account access and sending are explicitly authorized. Start with read-only import; then a small recipient-allowlisted send trial. Preserve local-only sample mode.
7. Before general availability, qualify consent, credential storage/rotation, deletion/retention behavior, provider review requirements, operational support and recovery. Importing a private mailbox does not authorize exposing it to a room or model.

## Product acceptance

The user opens Inbox, knows which account a message belongs to, reads it and replies without creating work. Ask room shares a chosen excerpt only after audience confirmation. The result can return as a private draft, but review/approval never sends it. Connection failures keep drafts and show uncertainty without adding a second workspace.

## Decisions intentionally still open

The first actual mailbox provider and authorized test account are not established by this research. Do not quietly use the user's existing personal mail or connected apps. Gmail and Microsoft are qualification candidates, not a commitment to ship both at once. Native private conversations and richer local attachments remain safe parallel roadmap work if provider access is not yet authorized.
