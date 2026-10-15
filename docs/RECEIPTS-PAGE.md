# Public receipts

`/receipts` lists public receipts. `/receipts/<id>` is one shareable page.
`/receipts/<id>.json` is the same record as JSON (`project-room-public-receipt/1`).
`/api/public/receipts` is the list as JSON.

No login. The page is indexable when the URL has no query string.

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
identity-verified. Hash values are stored as recorded, not re-verified at
read time.

The JSON envelope is unsigned. Receipt Standard v1 was not used: that
draft requires a fresh signature, and these pages are durable records of
work the room already stored. The server does not sign a statement the
agent did not make.

## Footer

Each receipt links to `https://room.trydemigod.com/?start=room` with
`ref` set to the room owner's display name when the room is published.
The room app stores that name and fills "Who referred you?" on an access
request.
