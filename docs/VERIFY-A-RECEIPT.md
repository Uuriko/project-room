# Verify a receipt (for strangers)

Someone handed you a Project Room receipt link and you want to know
whether to believe it. You need no account and about five minutes.
Receipts are the proof layer for work done in a room: a receipt is a
public record of one finished outcome, not an advertisement for it.

Start from a receipt that is already public — a link someone sent you,
or the public list at `/receipts`. Do not start by finishing work in a
brand-new room and expecting it to appear: finished work in fresh rooms
does not currently project to the public receipt faces, so a missing
receipt there proves nothing either way.

## The five-minute path

**1. Open the link (about a minute).** `/receipts/<id>` is one shareable
page; the same record is at `/receipts/<id>.json`. No login. Read what
the record actually claims: the title of the work, the room when it is
public, the names as the room recorded them, the pull request when the
stored link is one, the time the room recorded a merge, and the stored
`sha256:` hash evidence.

**2. Check the level of proof (about a minute).** A receipt carries one
of three levels, and they are not equal:

- **Server-verified merge** — a work claim this server recorded as merged
  before publishing. The strongest claim here.
- **Room-recorded completion** — a completed work item with a receipt.
  The room's own record; no server-verified merge backs it.
- **Artifact hash recorded** — a delivery whose artifact hash was
  recorded at submission. Its checks are worker-reported: not an
  acceptance, not a payment.

**3. Run the check (about a minute).** The plain page does not re-verify
anything: hashes on it are stored values. Every receipt page carries a
verification block. Unverified, it says "Not yet verified" and offers
**Verify this receipt now** — that is `?verify=1` added to the page (or
`.json`) URL. A verify run re-checks the record at read time: the record
is re-derived from its current source and compared field by field, a
public-work artifact is re-hashed, and a linked pull request is
re-fetched from GitHub and compared with the recorded merge. Verify runs
are rate-limited per address (10/minute); the plain page is unaffected.

**4. Read the graded verdict (about a minute).** The block renders one
verdict, stamped with the time it ran, saying what was checked, what was
not checked, and by whom ("the Project Room server, at read time"):

- `server-verified` — only when GitHub itself confirmed the merge.
- `record-checked` — the record matches its current source.
- `partially-verifiable` — a check could not run (e.g. GitHub
  unreachable).
- `contradicted` — a re-check found a mismatch, which the block names.
- `no-longer-verifiable` — the source is gone.

**5. Decide (the last minute).** Believe the receipt only up to the
level and verdict in front of you, at the time stamped. Anything weaker
than `record-checked`, or a level below what the sender claimed, is a
reason to ask the sender — not a reason to round it up.

## What a receipt does not prove

- **Not identity.** Names are as recorded by the room — not
  identity-verified.
- **Not payment.** No payment is proved by a receipt page; bounty credit
  movements live on separate lot receipts.
- **Not quality.** A receipt is a record, not a review. It shows the
  work was recorded as done, at the level stated — nothing about whether
  it was good.
- **Not permanent.** A receipt page exists only while it is public: the
  room owner's public-receipts setting is off until the owner records it
  on, and turning it off, leaving the public directory, or an operator
  unpublish hides the page. The record itself is unsigned.
