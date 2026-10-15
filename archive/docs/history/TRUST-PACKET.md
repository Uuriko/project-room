# Trust and support packet

The one page to hand a prospective pilot participant or their reviewer.
Written 2026-09-14 for BUILD-01 issue #6 item F6. Everything here points at a
file in this repository; placeholders marked **owner to confirm** are not
facts until the owner fills them in.

Project Room is an invite-only pilot. It is not an enterprise release and
holds no certifications (see "Certifications not obtained").

## Support

| Item | Value |
| --- | --- |
| Support owner | **Owner to confirm** (named person and backup) |
| Support channel | **Owner to confirm** (address or channel participants should use) |
| Response expectation | **Owner to confirm** (no service-level commitment exists in the repository) |
| What to send | The `X-Operation-Id` from the failing response, or the owner-only support export (`docs/SAFE-DIAGNOSTICS.md`). Never send keys, invitation links or message bodies. |

The support export contains whitelisted scalars only (operation ids, times,
status codes, error categories, templated routes, room id and title, service
revision); `tests/support-export.test.js` pins that it carries no invite
codes, hashes, access keys, link tokens or message bodies
(`docs/SAFE-DIAGNOSTICS.md` "Support export").

## Incident and status communication

Drawn from `docs/V8-RECOVERY-RUNBOOK.md` and `docs/SAFE-DIAGNOSTICS.md`. The
runbook governs; this is the participant-facing summary.

1. **Detect and triage.** Failed room requests log one line of operation
   metadata with an error category (`access`, `not_found`, `conflict`,
   `rate_limited`, `unavailable`, `internal`, `input`); the category, not the
   message text, is the triage signal (`docs/SAFE-DIAGNOSTICS.md` "Error
   categories", "Diagnostic records"). `/api/health` is process liveness and
   `/api/ready` reports whether a room can be read; neither proves
   durability or backup freshness (`docs/INVITE-ONLY-DEPLOYMENT.md` "Launch
   proof").
2. **Pause before touching data.** `ROOM_MAINTENANCE=1` returns an uncached
   503 with `Retry-After` before storage opens; readiness becomes
   unavailable and no one is routed around the pause to a writable instance.
   Drain admitted requests and stop or reconcile external agents first
   (`docs/V8-RECOVERY-RUNBOOK.md` "Pause and compatible application
   fallback").
3. **Choose the operation deliberately.** A compatible application switch,
   restoring an older capture, and pausing are three separate operations
   with different guarantees; never point old v7 code at migrated v8 data
   (`docs/V8-RECOVERY-RUNBOOK.md` "Three separate operations").
4. **Recover on a disposable copy first.** Capture with the online backup
   API, verify read-only, rehearse on a separate copy, record the capture's
   actual horizon (`docs/V8-RECOVERY-RUNBOOK.md` "Node capture and
   disposable recovery"; `docs/INVITE-ONLY-DEPLOYMENT.md` "Backup and
   restore"). For the hosted Durable Object, provider point-in-time recovery
   is untested and requires separate approval (`docs/V8-RECOVERY-RUNBOOK.md`
   "Cloudflare gates still requiring separate approval").
5. **Reconcile authority before reopening.** Post-capture revocations,
   account epochs, used or cancelled invitations, receipts and external
   effects are reconciled; uncertain access is invalidated rather than
   silently restored (`docs/V8-RECOVERY-RUNBOOK.md` step 5).
6. **Communicate.** Tell participants what happened, the exact deployed
   revision (`/api/version` exposes the release receipt without
   authentication; `cloudflare/README.md` "Design"), what was restored, what
   may have been lost since the capture horizon, and whether they must sign
   in again. Where and how status is posted: **owner to confirm** (no status
   page or notification channel exists in the repository).

Hosted acceptance evidence and rollback baselines are recorded in
`cloudflare/README.md`; no monitor or alerting is installed by this repository
(`docs/INVITE-ONLY-DEPLOYMENT.md` "Launch proof").

## Security reviews

- `docs/SECURITY-REVIEW-2026-09-14.md`: static review of the BUILD-01 Phase 0
  and 1 pull requests, with findings and follow-up tasks B47 to B51.
- `docs/RE-AUDIT-2026-09-14.md`: re-audit after BUILD-01 Phases 0 to 2
  (gates on `main`, a security pass over `server/http.mjs`, docs drift, Node
  and dependency inventory). It lands with PR #154 from branch
  `claude/build-01-reaudit`; until that merges, read it there.
- Earlier: `docs/SECURITY-REVIEW-2026-09-12.md` and
  `docs/SECURITY-REVIEW-IDENTITIES-2026-09-12.md`.

## Data boundaries

`docs/DATA-BOUNDARIES.md`: what is encrypted where (TLS at the edge, hashed
credentials, unencrypted SQLite content and exports), the deployment
configuration names and how they rotate, the third parties that handle data,
what the repository states about region, the plaintext path to an external AI
runtime, and the explicit statement that no end-to-end encryption is claimed.
Its "Owner to confirm" list is the set of facts that still need the owner.

## Retention and deletion

From `docs/EXPORT-RETENTION-DELETION.md`:

- A room export (any member) is the complete event history as JSONL,
  including deleted and edited-away content; it is an unencrypted
  point-in-time copy owned by whoever downloads it.
- Deleting a message hides it (a tombstone remains) but does not erase it
  from the event log, exports or backups. Editing keeps prior versions until
  the message is deleted. Search and previews never show tombstoned bodies.
- Room import (owner only) replaces history wholesale with the file.
- There is no self-serve room deletion; removing a room entirely is an
  operator action on the database and its backups, and exports already taken
  are not recalled.
- Composer drafts live only in the tab's session storage (12-hour expiry);
  presence is ephemeral.
- Retention periods for the live database and backups: **owner to confirm**
  (the repository defines what deletion means, not how long data is kept, and
  the fallback backup timer deliberately does not auto-delete;
  `docs/INVITE-ONLY-DEPLOYMENT.md` "Backup and restore").

## Access model in one paragraph

Membership is invite-only: guests join through bounded-use, expiring
invitation links and are conversation-only; provisioned members hold
seven-day keys that an operator rotates; sessions last at most eight hours;
recovery is an operator procedure, not self-service; guest names are
unverified (`docs/INVITE-ONLY-DEPLOYMENT.md` "Small launch scope" and "Return
visits and pilot limitations"; `docs/SERVICE.md` "Run and provision").
Route-by-route authority is tabulated in `docs/ROUTE-AUTH-TABLE.md`.

## Certifications not obtained

None of the following has been obtained, started or audited for, and none
should be implied in any conversation about the pilot:

- SOC 2 (Type I or Type II)
- ISO/IEC 27001, 27017, 27018, 27701
- HIPAA (no business associate agreement is offered; do not put PHI in a room)
- PCI DSS (no payment data is handled or accepted; `cloudflare/README.md`
  "Deployment gate and next steps" records that payments are not enabled)
- FedRAMP, StateRAMP, IRAP, C5, Cyber Essentials
- GDPR or UK GDPR data processing agreement, standard contractual clauses, or
  a data protection impact assessment: **owner to confirm** whether any
  agreement is in place; none exists in the repository
- CSA STAR, TX-RAMP, HITRUST
- Penetration test by an independent third party (the reviews above are
  internal static reviews)

## Owner to confirm

1. Support owner, backup, channel and response expectation.
2. Where incident status is communicated to participants.
3. Retention periods for the live database and backups.
4. Whether any data processing agreement or privacy notice exists.
5. Everything in `docs/DATA-BOUNDARIES.md` "Owner to confirm".
