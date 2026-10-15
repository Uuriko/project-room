# Private email import: first qualification boundary

## What this implements

A versioned email data contract, a Microsoft Graph JSON normalizer, a review-only reply projection and folder-delta classification. It is exercised with invented provider-shaped fixtures, not recordings from a mailbox. There is no network driver, credential store, persistence migration, new UI, provider setup or real sending in this checkpoint. The existing synthetic Inbox deliberately refuses these envelopes.

This advances the blueprint's real-email milestone without pretending the paragraph-only sample is a connected mailbox. Graph is the first shape qualified because it supplies structured recipient objects; this is not a promise to support only Microsoft or evidence of Microsoft approval.

## Representation and ownership

`server/email-envelope.mjs` owns the version-1 envelope and review projection. `server/graph-email.mjs` maps fully hydrated Graph message JSON into it. `scripts/email-contract-fixture.mjs` is an invented, reusable example; `tests/email-contract.test.js` exercises both modules and the existing Inbox refusal boundary.

The envelope contains:

- An account/connection/mailbox identity and positive connection revision, with an explicit sending identity and known aliases. No credential fields are accepted. These are data bindings, not proof of authorization; the future service must supply them from authenticated durable state.
- Opaque case-sensitive provider message, conversation, folder and change identifiers. Local source identity is scoped to account, provider, mailbox and immutable message ID, not subject or sender. Moving folders or reconnecting does not invent a new source identity. A content hash pins the full normalized observation.
- Separate From, Sender, Reply-To, To, Cc and Bcc. Empty subject/body and absent optional dates/message IDs remain representable. No display-name-based identity merging.
- Exact text or HTML body data. HTML is not sanitized or renderable by this module; no renderer is added. Neither a provider snippet nor a regex-flattened body substitutes for the message.
- Loaded versus unknown reply headers, retaining relevant reply relationships. Legal line folding is unfolded, not reparsed into outgoing MIME. Other headers and provider URLs are not projected.
- Unknown, partial or complete attachment metadata, distinct file/item/reference kinds, inline identity and size. Content bytes, links and attachment execution are not imported. A supplied metadata observation must bind the same parent message/change revision. The future fetch driver must confirm that binding across pagination, not just echo it.

There is no raw RFC address-header parser here. The normalizer accepts provider-parsed, bounded addr-specs; quoted/exotic forms outside the qualified subset fail explicitly rather than being split or guessed. All address rendering remains text. Recipient, body, metadata and total-input bounds reject oversized content rather than silently truncating it. Limits are pilot implementation limits, not email standards.

## Reply behavior

Reply targets Reply-To when present and otherwise From, not a delegate Sender. Reply all additionally includes original To/Cc after removing known own identities and exact duplicates. Domain comparison is case-insensitive; local parts remain exact. Bcc is never promoted into either visible recipient list. Incoming attachments are not silently forwarded. Unsupported recipient/attachment overrides are rejected instead of ignored.

The sending identity comes from the explicit connection, never from a received To field. A changed account, mailbox, connection revision or sending identity invalidates the review projection. A provider draft cannot be treated as a received message to reply to. A self-only reply needs deliberate recipient selection; that editor remains future work.

Output says `purpose: review-only`. It preserves provider reply context and exact source/body versions but cannot enter the current synthetic send state machine. No permission is inferred from this shape. A provider-created reply draft must eventually be re-read and checked against the approved recipients/body before dispatch; provider threading and altered recipients cannot be assumed to match our proposal.

## Provider findings that changed the design

Graph distinguishes From from Sender, supports structured recipient lists, and treats `hasAttachments` as excluding inline-only content. Consequently, `hasAttachments: false` does not establish that there are no attachment descriptors to load. [Message resource](https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0).

Graph supports requesting text bodies and retrieving selected internet headers. The adapter requires fully hydrated fields rather than accepting a delta stub or snippet as a complete message. HTML remains inert data until a separate rendering boundary is qualified. [Get message](https://learn.microsoft.com/en-us/graph/api/message-get?view=graph-rest-1.0).

Immutable IDs are case-sensitive, require an explicit request preference and remain stable within the same mailbox; archive-mailbox moves and export/reimport can change them. The contract requires the caller to declare immutable-ID mode, but only a future driver test can prove it actually uses that preference on every request. [Immutable identifiers](https://learn.microsoft.com/en-us/graph/outlook-immutable-id).

Folder deltas can report removals for folder moves, contain read-state changes and omit ordering guarantees. They use opaque next/delta links. Our classifier therefore returns `hydrate` or `absent-from-folder`, not a complete source replacement or global deletion. Repeated observations stay explicit for a durable driver to reconcile. The cursor is never fetched by this code. [Message delta](https://learn.microsoft.com/en-us/graph/api/message-delta?view=graph-rest-1.0).

Microsoft's reply guidance uses Reply-To rather than From where supplied, and separates creating a reply draft from sending it. A future implementation must qualify the additional permission and crash-reconciliation consequences of provider draft creation. [Create reply](https://learn.microsoft.com/en-us/graph/api/message-createreply?view=graph-rest-1.0).

## Next implementation: durable private import

1. Persist an account-owned connection with revision, state, provider identity, granted capabilities and a private credential reference. No generic room agent can mint or read that connection. Use a fixture-backed driver first.
2. Add an authenticated importer-only journal operation for full email observations. Preserve the existing synthetic source format and replay. Use a schema/writer fence before a new record kind is committed. Deduplicate unchanged observations without allocating another source revision or dropping a draft.
3. Store folder membership observations and sync checkpoints separately from message content. Commit each page plus its checkpoint atomically. Bind driver results to the connection generation and reject late responses after reconnect/revocation. A folder removal must not delete the message or draft; confirm mailbox-level state separately.
4. Hydrate changed messages; treat attachment-page and parent-version mismatch as incomplete, not success. Expired cursors trigger bounded resync with explicit coverage, preserving drafts. Never infer deletion from a missing partial page. Verify cursor origin/path and do not follow arbitrary provider-supplied URLs with credentials.
5. Project a bounded list/detail view into the same Inbox. Keep account/channel identification visible, recipients and attachment detail contextual, private/room drafts separate, and any unrendered body state truthful. Do not expose raw HTML or fetch its remote images automatically. No second dashboard.
6. Extend selected excerpt sharing deliberately; the current paragraph-only sharing cannot be reused by silently stripping HTML or including attachment metadata. Test exactly what room members receive and what stays private.
7. Add provider-specific draft/submit/reconciliation with durable identity and authority. Unknown send outcomes remain unresolved until supported evidence arrives. A local review is not permission to call a provider or send.
8. Qualify a dedicated mailbox only with explicit authorization; actual OAuth, service policy/verification, private-data retention, account recovery, deletion, operational support and real delivery remain open gates.

## Evidence scope

Tests cover normalization, recipient selection, exact versions, mailbox/account separation, unknown/inline attachments, mixed attachment versions, partial delta reads, folder moves, malformed and bounded input, and refusal by the current synthetic Inbox. There are no human participants, native vendor models, actual provider observations or new screen changes. No screenshot would prove this data boundary; exact fixture/assertion results are the relevant evidence. Full application regression results are recorded at checkpoint after committing the candidate.

### Committed checkpoint

Final tested commit `7e270f5323dbc265e7da5bc0c589e47ca8d96e5d` includes the email modules from `32b086d` and a browser-test synchronization correction. Syntax checks and all 758 core tests passed, including 19 new email-contract tests. All nine focused account-workspace browser tests passed on that same commit. Schema 17 and production routes are unchanged; these modules are not mounted as a provider API. The full 233-test browser suite and 18 local Workers checks were not rerun in this slice; their previous checkpoint must not be described as current-candidate proof.

Local evidence: `test-results/email-contract-7e270f5/` contains final logs, a readable invented-message/Reply/Reply-all/folder-move trace and refreshed existing-Inbox screenshots. The first browser run ended 8/9 because the test treated a visible-but-disabled invitation button as completed reauthentication. The corrected test deliberately holds the sign-in response, verifies busy/disabled state, releases it, waits for confirmation, then verifies old private content is cleared. The failed run is retained; no app-code fix is claimed for that test synchronization defect.
