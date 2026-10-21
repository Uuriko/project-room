# Public receipts

`/receipts` lists public receipts. `/receipts/<id>` is one shareable page.
`/receipts/<id>.json` is the same record as JSON (`project-room-public-receipt/1`).
`/api/public/receipts` is the list as JSON.

No login. The page is indexable when the URL has no query string.

## Share layer

`/receipts/<id>/og.png` is the receipt's share card: the title, the graded verdict line, and a footer
stating that hashes are stored values, not re-verified — rendered at request time from the same public
record as the page and named by the page's `og:image`. It exists only while the receipt is public: the
read re-checks the owner toggle and operator unpublish on every request. Unlike the pages (`no-store`),
the card is cacheable for five minutes so link unfurlers can fetch it — the one deliberate exception,
bounded by that TTL.

The detail page embeds JSON-LD (`CreativeWork`) mirroring the visible record: title, verdict level,
pull request, hash evidence (labelled as stored, not re-verified), and the proven note as its
description. Names are omitted — the page qualifies them as room-recorded, not identity-verified, and
the structured vocabulary cannot carry that qualifier. There is no rating or review markup: a receipt
is a record, not a review.

The detail page also carries a share block: the pre-filled share text
("<title> — <verdict line>") shown verbatim on the page,
one-tap share links (X, LinkedIn, email — plain anchors; these pages are
script-free), and the badge embed below.

`/receipts/<id>/badge.svg` is the embeddable badge for READMEs and
portfolios: the surface name and the receipt's graded verdict in words —
never a bare checkmark, which readers take as a blanket quality verdict.
It resolves through the same public read as the page, so it exists only
while the receipt is public, and it is cacheable under the same
five-minute exception as the OG card. The snippet the page offers wraps
the badge in the receipt link with the verdict line as its alt text.

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
the proof page: bounty credit movements are recorded by lot receipts,
which never appear as proof-page entries. A lot receipt's own detail page
is public only under the same owner receipts setting as every other
receipt, and its share surfaces follow that same gate.

The proof page carries the same share layer as a receipt: JSON-LD
(`CollectionPage` with an `ItemList` mirroring the visible entries and
their level notes) and a per-room share card at
`/r/<slug>/proof/og.png` — the room's counts and the stored-hashes
footer — gated by the same view and cacheable under the same five-minute
exception as the receipt card.

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
  shows every ledger movement the lot carries (each movement's kind,
  amount, source and destination accounts) plus the settlement's worker
  and refund amounts, the bounty's poster, worker, award, pinned rubric
  hash, and settlement outcome. Before settlement, and for journal
  lots that are not bounty movements, the id is a 404. The record is
  composed from the credit ledger at read time, not stored as a copy.
  Like the claim and work-item shapes, a lot waits for the owner's
  public-receipts opt-in (#3594): a settled lot is public only while
  the room's own public-receipts setting is recorded on. Never
  recording the setting keeps the lot private, exactly like recording
  it off; the room's directory receipts switch turned off and
  operator unpublish hide it too — the same switches that hide the
  other shapes.
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

A public-work receipt also carries its outcome, composed at read time
from the receipt record and the room's review record: `state` (the
record's own state — `submitted` until the designated reviewer's
acceptance stamps it `verified`; a rejection or revision request, which
never stamps the record, reads as `rejected` or `revision_requested`),
`verification` (the tier the record carries, `hash_only` or
`system_checked`), `checksReported` (the checks the worker reported),
`executedChecks` when the record carries platform-executed checks, and —
once a review is recorded — a `review` summary (review state, the
reviewer's verdict and kind, and the verdict/decision times). The
reviewer's identity, reason, and review fingerprint never appear. A
rejected delivery reads as rejected on the page, in the JSON, and in
the list — it is not removed, and it is not dressed as accepted work.

## Verification

Every detail page carries a verification block, and the HTML page
verifies at read time: opening `/receipts/{id}` runs the re-check (or
serves the run another reader triggered moments ago — see the bound
below) and renders one graded verdict in the same block, stamped with
the time that run actually ran: what was checked, what was not checked,
and by whom ("the Project Room server, at read time"). **Verify now**
(`?verify=1` on the HTML or `.json` URL) always runs the checks fresh.
When a run cannot be produced at all, the block says "Not yet verified"
with the Verify now action — unverified is a displayed state, never a
blank. The JSON twin keeps the stored record on plain reads (its
`verification` field, when present, is the tier recorded on the claim);
with `?verify=1` the JSON gains the read-time verification object
(`project-room-receipt-verification/1`), so "checked just now" is
distinguishable from "stored values" in both shapes.

A verify run re-checks the record at read time. The verdict is computed
from the re-check, never replayed from the stored label: a receipt
whose facts no longer hold degrades to the honest tier instead of
keeping the verdict it was issued with. The checks
(server/receipt-verify.mjs): the record is re-derived from its current
source and compared field by field; a public-work artifact is
re-hashed; a bounty lot's escrow entries are re-hashed and their chain
links re-checked; the linked pull request is re-fetched from GitHub and
its current state compared with the recorded merge — including whether
a later merged pull request reverted that merge. Verdicts — exactly
four graded tiers: `server-verified` (only when GitHub itself confirmed
the merge and no merged revert undoes it), `room-recorded` (the record
re-checked clean against the source the room recorded; no
server-verified merge backs it), `partially-verifiable` (a check could
not run, e.g. GitHub unreachable — the block names it under not
checked), `no-longer-verifiable` (the live facts no longer support the
record: the source is gone or unpublished, or a re-check contradicts
it — the block names the mismatch). The cost bound: a verify run can
cost GitHub calls, so HTML reads share one run per receipt per 60
seconds per server instance (the rendered stamp is that run's own
time), and explicit Verify now runs are rate-limited per address
(10/minute). The plain JSON read makes no external call.

## Footer

Each receipt links to `https://room.trydemigod.com/?start=room` with
`ref` set to the room owner's display name when the room is published.
The room app stores that name and fills "Who referred you?" on an access
request.
