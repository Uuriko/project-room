# Inbox sharing checkpoint

## Implemented

The email share sheet offers **All text** as a deliberate alternative to manual
excerpt selection. It selects the plain-text body, previews it, and still requires
Share. It does not include recipients, attachments, HTML, other messages, private
drafts or permission to reply externally. The existing 4,000-character room-message
limit includes the excerpt prefix; oversized selections are refused, not truncated.
Users can then select a smaller excerpt.

The selection control is disabled once submission begins. Existing source/audience
revision checks and immutable uncertain-request retries remain authoritative.
Paragraph checkbox change handling no longer applies to unrelated controls.

## Evidence

- Six focused browser scenarios pass: desktop/mobile All text, desktop/mobile
  email-to-room-to-draft collaboration, lost acknowledgment, changed source.
- 85 inbox/email Node tests pass, including audience changes, account isolation,
  revocation, exact retries, transactional rollback and recorded-email recovery.
- Full inbox browser regression: 65/65 pass, zero skipped (47,673 ms), including
  audience changes, account switching, private drafts and send-review recovery.

These are local tests with synthetic/recorded mailbox input, not live email delivery.

## Prioritized next implementation

1. **Selected-audience private context.** Do not implement a recipient picker over
   room-wide messages. Establish a separate private context record and explicit
   grants, with the owner always retaining access. Scope agent identities to their
   actual room/account bindings. Resolve “my agents” and “all agents” to visible,
   concrete recipients at confirmation rather than silently granting future agents.
   Test every read surface, search, events, exports, receipts and revocation. Do not
   put private content in room-wide logs or notifications. Revocation stops future
   reads but cannot retract copies already received.
2. **A complete email connector.** Use the existing account-private model and
   versioned observations, but implement real authorized transport separately from
   fixture readers. Prove reconnect, cursor recovery, deduplication, disconnect,
   recipient review and uncertain-send reconciliation before calling it connected.
   External credentials/access and deployment remain approval gates.
3. **Additional services.** Research each provider's supported integration model,
   account eligibility and limitations before offering Connect. Do not imply all
   personal messaging accounts support equivalent APIs or privacy guarantees.
4. **Whole conversations and attachments.** Require explicit scope, safe handling
   and bounded storage; All text is not a substitute for those features.

No connector, selective-agent privacy, hosted deployment or production readiness is
claimed by this checkpoint.

## Room-history privacy audit

Follow-up regression tests exercise new human and agent memberships after a share.
Both can read the existing excerpt through the real room snapshot. Neither receives
the original private source, sender, subject, unselected paragraph or saved draft.
A new human's own account session also cannot read the sender's private source.
An exact share retry after membership changes does not duplicate the post.

Requests with unsupported recipient-selector fields are rejected rather than
silently treated as room-wide shares. This does not implement selective access.
The existing share-sheet warning about future members is now asserted visible on
desktop and mobile; no additional visible copy was necessary.

Evidence: 11/11 inbox tests and 3/3 focused browser checks pass. This confirms the
room-history boundary, not a fixed-recipient grant. The selected-audience feature
must use a distinct private read path with revocable, explicit grants; ordinary
room events are unsuitable storage for that content.

## Private grant backend (local, not deployed)

The separate backend path now supports `source.grant` and `grant.revoke` through
the account-session/CSRF-protected `/api/inbox/commands` endpoint. Creation accepts
the same revision-bound excerpt selection as room sharing, plus 1–20 explicit
`memberIds`. It records selected text privately without emitting a room event.

Named recipients read `/api/rooms/:roomId/private-context/:grantId` using their
existing room identity. Every read requires active current authentication, the
same recipient membership revision, the source owner's active account/auth epoch
and membership revision, an unrevoked grant, and an unexpired seven-day lifetime.
The owner retains access. Reads return selected text and read-only scope, not
source metadata, recipients, attachments or drafts. The grant ID is not a bearer
capability; unselected and future room members receive an unavailable response.

Revocation is owner-account-only, works without room access, and is permitted at
the normal journal capacity limit. Exact retries return historical receipts and
cannot revive a revoked grant. Already received copies cannot be recalled.

Remaining work before presenting this as a complete feature:

- Concise recipient review, grant management/revocation and owner-visible receipts.
- Private recipient discovery and agent tools; never announce the text or private
  recipient list in a room-wide message, notification, search index or export.
- Clear handling for copied context and derived work: read access is not permission
  to repost privately shared text into a public room or send an external reply.
- Load tests before scaling beyond bounded pilot data. Grant reads use a primary-key
  lookup, while revocation checks remain bounded by the owner's private journal.
- A compatible rollback candidate and replay/recovery proof containing actual
  grant/revoke records. The table schema remains 33, but older code does not
  understand these new journal actions. Schema equality is NOT proof of fallback
  compatibility. Do not deploy using the previous pre-grant fallback pairing.

Live email and other service connectors remain separate, unfinished work.

Backend checkpoint evidence: 7/7 dedicated private-grant tests; full Node suite
1,315/1,315 passes, zero skipped (41,739 ms); existing Workers HTTP smoke 1/1 passes.
The latter checks shared HTTP compatibility, not a hosted grant journey. No UI or
MCP grant test is claimed. New tests cover real HTTP creation/read/revocation,
unselected identities, future membership, exact retries, restart replay, owner
account epoch revocation, expiry using a fresh credential, malformed selections,
and transactional journal failure. No deployment or production-data migration.

### Recipient account fence

New human-recipient grants pin both room membership revision and the bound account's
authorization epoch. Revoking and restoring the recipient account cannot revive an
old grant, even if its room membership is unchanged and it obtains a fresh key.
A new grant is required. Inactive recipient accounts cannot receive new grants.
Replay validates the pinned epoch against the account's recorded history rather
than incorrectly substituting its current epoch.

Earlier local grants without the human account pin remain replayable but cannot
authorize that human recipient; the owner must issue a new grant. Agent recipients
continue to use current room credentials and their exact membership revision.
This change does not add grant UI or agent-tool discovery.

Evidence: full Node regression 1,316/1,316 passes (47,622 ms), followed by dedicated
grant coverage 9/9 after adding the legacy-receipt replay case. No production code
changed between those runs. The legacy case reconstructs the prior receipt shape
in a disposable database, verifies replay/restart, denies recipient access, keeps
owner access, and confirms that a new pinned grant works. Grok independently
confirmed the original 20ee115 recipient-epoch gap; this addendum addresses it.

## Owner-side sharing interface

The share sheet now offers Room or Selected people & agents. Private sharing
requires an explicit recipient selection (maximum 20), uses the existing text
selection, and explains the seven-day lifetime and copied-content limitation.
Private submission stays in Inbox and emits no room message. An uncertain retry
persists only operation metadata, including exact recipient IDs, never message
text. Scope and recipients remain locked until the original request is resolved.
The scope control is disabled while context loads to prevent a late response from
overwriting an early choice.

An account-private grant listing backs the collapsed Private shares section.
Owners can revoke access and recover the listing after reload. It shows the latest
100 records, explicitly says when more exist, and does not claim that an unrevoked
record guarantees current recipient authorization. Revocation retries retain the
same request in the open view; reopening reloads current recorded state.

This completes owner-side selection and revocation, not recipient discovery or
agent integration. A recipient still needs the specific grant ID and the existing
authenticated private-context HTTP endpoint. No content or grant IDs are announced
to room-wide listeners. Recipient UI, agent tools, older-grant pagination and the
compatible recovery/release candidate remain outstanding.

Owner UI evidence: 68/68 full inbox browser checks pass (71,549 ms), including
desktop/mobile private selection, reload/revoke and uncertain-response exact retry.
Full Node regression: 1,318/1,318 passes, zero skipped (53,719 ms).
