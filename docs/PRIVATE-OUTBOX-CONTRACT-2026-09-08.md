# Private reply outbox: service checkpoint

This implements the durable send-intent and synthetic transport layer of U05/U06. It does not yet expose sending in the browser, mount a transport on an HTTP endpoint, connect an email account or authorize any external message. The previous reviewed-result → private-draft UI remains unchanged.

## Product contract

Sending remains separate from saving a draft or accepting room work. Direct replies need neither a work item nor an agent. The next UI should use the existing private reader and composer, show the exact sending account and recipients, then offer one deliberate action. It must not reuse desktop chat's Enter-to-send behavior for email.

States are facts, not optimistic labels:

| State | Meaning | Permitted next step |
| --- | --- | --- |
| queued | Exact saved reply reserved; transport has not begun | Dispatch or cancel |
| unknown | Dispatch began; acceptance is not established | Look up this attempt; never automatic resubmission |
| accepted | Adapter reports acceptance with a correlated provider ID | Check delivery if supported |
| delivered | Adapter reports delivery | Retain receipt |
| rejected | Adapter explicitly reports it did not accept | A deliberate new reservation is allowed |
| bounced | Accepted submission later failed delivery | Retain both facts; no blind resend |
| cancelled | Reservation cancelled before dispatch | A deliberate new reservation is allowed |

There is no unsupported Read or Recall state. An empty lookup result is not proof of rejection. A crash immediately after the dispatch marker but before the provider call therefore remains unknown until independently resolved.

Microsoft documents that a 202 send response precedes processing and does not establish delivery. AWS's idempotency guidance distinguishes one request identity from a different intent with similar parameters. These support our distinction between a stable local operation and provider-specific evidence; they do not establish universal exactly-once delivery. [Microsoft Graph](https://learn.microsoft.com/en-us/graph/outlook-things-to-know-about-send-mail), [AWS Builders' Library](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/).

## Exact intent and authority

The server builds a preview from the current saved draft and current source. It pins account ID and authority epoch, source/draft revisions, synthetic adapter, From, To, subject, exact body and an empty attachment list. The preview digest is required to reserve the intent. Arbitrary caller-supplied recipients or body are not accepted at reservation.

Synthetic sources have one sender and recipient. This is not a qualified email Reply-To algorithm, mailbox authorization model or attachment implementation. Real adapters must supply and qualify those semantics before adoption.

Only an active account session can read or reserve/cancel its private send. Room keys, including owner and agent keys, do not grant access. No private outbox text is copied into room events. The journal records the account epoch for auditing.

Immediately before the transport call, dispatch rechecks the saved draft, source and account epoch and records unknown in a committed transaction. Changes invalidate queued authorization. Once a provider call is in flight, revocation cannot unsend it; a later authorized session can reconcile the existing attempt.

Only one queued/unknown attempt may exist for a source. A submitted draft revision cannot be submitted again with a new request ID. Cancellation and definitive rejection allow deliberate new reservation. A new edited/saved draft can be a new deliberate intent after the earlier attempt is resolved.

## Storage and API

Reuse private_inbox_commands; no additional production table or public event stream. Send records are derived from the private journal. Schema 17 fences older writers that cannot replay its new actions.

- GET /api/inbox/sources/:id/send-context: exact current preview.
- GET /api/inbox/sources/:id/sends: account-owned attempt history.
- POST /api/inbox/commands: send.reserve and send.cancel, with existing cookie, session binding, origin, CSRF and rate protections.
- send.dispatch and send.observe: trusted in-process transport interface only. HTTP requests cannot impersonate provider outcomes, including retries of existing internal commands.

Exact command retries return their original receipt, not a rewritten current status. Use the separate history read for current state. Stale revisions and conflicting observations cannot downgrade delivery or change the correlated provider ID.

The pilot's 5,000 ordinary-command capacity does not prevent settling or cancelling existing reservations. The trusted transport also avoids appending unchanged accepted observations on every poll. Send history is currently journal-derived and bounded by pilot use; pagination/indexing should be added before expanding this pilot's capacity.

## Synthetic driver and failure qualification

SyntheticInboxTransport accepts only a synthetic submit/lookup adapter. It commits a dispatch marker before awaiting submit. Concurrent drivers do not both submit the same reservation. A repeated dispatch call after that marker reads the existing state; reconciliation calls lookup only. Correlation binds account, send ID and preview digest.

The test-only SyntheticMailFixture uses a separate SQLite database and can fail before submission, after durable acceptance or reject definitively. Both databases can close and reopen. This tests real local persistence boundaries, not any remote provider, independent agent reasoning or distributed production durability guarantee. It has no network code.

Coverage includes exact preview/identity, source/draft changes, authority changes before and after submission, HTTP transport forgery refusal, account-private reads, duplicate admission, concurrent dispatch, lost acknowledgment, missing lookup, restart, backup, observation ordering, bounce/rejection and capacity settlement.

Migration checks use genuine schema-16 and older packages. Local Workers fixtures carry populated reserve/dispatch/acceptance histories across restart. The cold exact-commit recovery fixture includes both reviewed adoption and accepted-send history.

## Next implementation slice

1. Add a clearly marked, opt-in synthetic transport to the local service; it must remain unavailable for real provider sources.
2. Add exact-preview validation to InboxClient, contextual Send sample / Check status / Cancel controls and retained unknown-attempt handling across reload and account changes.
3. Test the whole synthetic private source → selected room excerpt → work → review → private reply → simulated send journey on desktop and mobile, plus a direct reply with no work.
4. Add an explicit operator reconciliation path for permanently unknown cases; do not silently reinterpret lookup absence as safe to resend.
5. Qualify actual agents and provider-specific email authority, synchronization, attachments, status and operational recovery before any authorized real-account pilot.

The broad product goal remains active. No send UI, live provider, external message, deployment, payment or model invocation is claimed here.
