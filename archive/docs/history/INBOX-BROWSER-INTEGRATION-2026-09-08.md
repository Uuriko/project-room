# Inbox / Rooms browser integration

Continues U05 from d2fce19. Local, synthetic messages; no provider or delivery.
The broader product goal and U05/U06 remain incomplete.

## Working flow

An account-authenticated room now has two stable destinations: Inbox and Rooms.
Legacy member-key room entry remains unchanged and does not gain private-inbox
authority. The inbox uses the actual account-scoped service, not the downloadable
U04 prototype. No sample content is added to an account merely by opening it.

Desktop uses aligned message rows and a separate reading/composing region.
Mobile uses focused detail with a Back action that remains available during
loading. Room-only invitation and connection controls do not appear in the
private inbox. The sender, recipient and synthetic/only-you label remain visible.

Read → write → Save draft requires no work item or agent. Enter inserts a
newline; there is intentionally no Send button. Saving writes the account's
private draft and never posts to a room. Saved drafts survive reload. Unsaved
per-source text survives destination/message navigation in the same tab, with
a browser warning before leaving; unsaved text is not automatically durable.
Reading position is restored for in-tab source navigation.

Ask room opens a current membership preview, including agent identities, and
starts with no text selected. It explicitly says shared text becomes room
history for future members too. Sharing uses the same canonical message command
as existing room conversation and returns to that room; the private draft stays
separate. Returning to Inbox resumes the selected source.

## Recovery and privacy

The private client reuses account-session transport but checks its own exact
response ownership. Account ID, authorization epoch, browser session revision
and binding must match. Old-account reads/errors cannot mutate a replacement
session. Current ownership mismatches and authorization loss clear private UI.
Room snapshots and agent reads still do not contain private source/draft bodies.

A save conflict keeps the local text and displays the currently saved alternative
beside the changed source. Use saved / Keep mine is a deliberate choice; saving
then uses the reviewed source and draft revisions. A draft based on an older
source requires review before it can be saved against the new source.

A lost or malformed save response locks the exact request for Confirm save.
No new request ID or second revision is silently created. If the tab is reloaded,
the service's saved draft is authoritative; an uncommitted unsaved draft is not
promised to survive.

Unconfirmed sharing retains its exact request metadata in tab sessionStorage:
request/source/room IDs, source and audience versions, paragraph indexes and
account-session ownership. It stores no source/draft body, address, access key or
CSRF token. Ownership includes the session binding, so treat this as private
browser state, not a public artifact. Reload can confirm the same operation.
Its original text is not re-rendered from a possibly newer source. Confirmation
uses the retained selection, not the newly displayed source.

Sign-out/access loss clears retained sharing metadata. Page departure keeps it
for same-session reload. If browser storage is unavailable, a warning asks the
user to keep the tab open until confirmation; reload recovery is then unavailable.
This is not a cross-device pending-operations inbox or a real external-send
reconciliation system.

## Tests and observations

Client tests cover ownership, headers, exact receipts and delayed account changes.
Browser journeys use disposable accounts and the actual local storage/HTTP:

- Desktop/mobile direct private drafting, room/source navigation and reload.
- Only selected source text reaches a scripted agent's room snapshot.
- Concurrent draft and changed-source decisions preserve both alternatives.
- Lost save response retries once without advancing draft revision twice.
- Lost share response survives reload without a second room post.
- New audience invalidates selection.
- Historical-source draft requires explicit review.
- Another tab switching the shared browser account clears private content and
  suppresses a held old-account response.

The first mobile test exposed a real navigation trap: loading hid the only Back
control. Back now belongs to the focused view rather than the loaded article.
An audience test also used an overly broad selector; it now observes the actual
sharing preview, not a hidden room-member row.

Screenshot review retained the aligned list/detail structure and removed
room-only chrome from the inbox. Save and Share retain words because their
different audiences cannot be communicated reliably with the same arrow icon.
These are simulated journeys and design judgments, not observed human preference
or evidence of retention.

## Remaining sequence

1. Complete the shared excerpt → optional work → native/agent contribution →
   exact review → human decision → private reply journey. Reuse canonical work,
   results and review records; approval must not send a reply.
2. Add independently qualified synthetic send identity/outcomes, including
   uncertain delivery and reconciliation, before any real email adapter.
3. Separate account-wide arrival from the currently selected room. The service
   owns inbox data at account scope, but this first UI enters through an
   account-authenticated room; it does not yet provide standalone account home.
4. Qualify retention/deletion, backup access, attachments, disconnect, real
   provider authorization and sender identity. No current UI implies a connected
   mailbox, encryption beyond existing storage/deployment controls or delivery.

Deployment, external providers and payments are unchanged.
