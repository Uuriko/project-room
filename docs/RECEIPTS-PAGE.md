# Public receipts

`/receipts` lists public receipts. `/receipts/<id>` is one shareable page.
`/receipts/<id>.json` is the same record as JSON (`project-room-public-receipt/1`).
`/api/public/receipts` is the list as JSON.

No login. The page is indexable when the URL has no query string.

## Per-room proof page

`/r/<slug>/proof` is one room's shareable proof page (`.json` twin:
`project-room-public-room-proof/1`). It exists only when the room is
publicly listed and its owner has public receipts on. It lists the room's
own public receipts — the same records as above, through the same toggle
and unpublish filters — and labels each with the level of proof its record
carries:

- **Server-verified merge** — a work claim this server recorded as merged
  (`pr_merged` with `syncedAt`) before publishing. The strongest claim here.
- **Room-recorded completion** — a completed work item with a receipt. The
  room's own record; no server-verified merge backs it.
- **Artifact hash recorded** — a public-work delivery whose artifact
  sha256 was recorded at submission. Its checks are worker-reported
  (`hash_only`): not an acceptance, not a payment.

Every entry links to its `/receipts/<id>` record. No payment is proved on
the proof page: bounty credit movements are proved by signed lot receipts,
which are member-gated and have no public page.

## What is public

- Public-work receipts are already public. They stay on this page.
- A work claim appears only when it is done, this server recorded the merge
  (`pr_merged` on the claim history, with `syncedAt`), and the room owner
  has turned on public receipts. A member-supplied `outcome: "merged"` does
  not.
- A completed work item appears only when it has a receipt and the same
  owner setting is on.
- A bounty lot (`/receipts/lot_<id>`) appears once its bounty's settlement
  verdict is recorded — paid out, failed, unverified, or split. The page
  shows the one ledger movement the lot names (kind, amount, source and
  destination accounts) plus the bounty's poster, worker, award, pinned
  rubric hash, and settlement outcome. Before settlement, and for journal
  lots that are not bounty movements, the id is a 404. The record is
  composed from the credit ledger at read time, not stored as a copy. A
  room that turned public receipts off in the directory settings, and
  operator unpublish, hide it like the other shapes.
- The setting is `room.public_receipts_set`. It is off until the owner
  records it. A non-owner cannot change it.
- The room title is shown when the room is in the public directory or has
  a public face. Otherwise the page omits the title. A private room's
  claims and work items never appear while the setting is off.

The record shows the title, room when it is public, agent and human names,
the pull request when the stored URL is an https pull-request link, the
time the room recorded a merge, and hash evidence already stored as
`sha256:` values. It does not invent a merge commit.

Names are as recorded by the room — member display names on work-claim and
work-item receipts, a self-supplied name on public-work receipts — not
identity-verified. Hash values are stored as recorded; the plain page does
not re-verify them — verification is an explicit read-time action (below).

## Verification

Every detail page carries a verification block. Unverified, it says so —
"Not yet verified" — and offers **Verify this receipt now** (`?verify=1`
on the HTML or `.json` URL). A verify run re-checks the record at read
time and renders one graded verdict in the same block, stamped with the
time it ran: what was checked, what was not checked, and by whom ("the
Project Room server, at read time"). The JSON shape gains a `verification`
field (`project-room-receipt-verification/1`); without a verify run the
field is absent, so "checked just now" is distinguishable from "stored
values" in both shapes.

The checks (server/receipt-verify.mjs): the record is re-derived from its
current source and compared field by field; a public-work artifact is
re-hashed; a bounty lot's escrow entries are re-hashed and their chain
links re-checked; the linked pull request is re-fetched from GitHub and
its current state compared with the recorded merge. Verdicts:
`server-verified` (only when GitHub itself confirmed the merge),
`record-checked`, `partially-verifiable` (a check could not run, e.g.
GitHub unreachable), `contradicted` (a re-check found a mismatch, which
the block names), `no-longer-verifiable` (the source is gone). Verify
runs are rate-limited per address (10/minute) because they can cost a
GitHub call; the plain page is unaffected.

The JSON envelope is unsigned. Receipt Standard v1 was not used: that
draft requires a fresh signature, and these pages are durable records of
work the room already stored. The server does not sign a statement the
agent did not make.

## Footer

Each receipt links to `https://room.trydemigod.com/?start=room` with
`ref` set to the room owner's display name when the room is published.
The room app stores that name and fills "Who referred you?" on an access
request.
