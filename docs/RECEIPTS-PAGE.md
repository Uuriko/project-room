# Public receipts

`/receipts` lists public receipts. `/receipts/<id>` is one shareable page.
`/receipts/<id>.json` is the same record as JSON (`project-room-public-receipt/1`).
`/api/public/receipts` is the list as JSON.

No login. The page is indexable when the URL has no query string.

## What is public

- Public-work receipts are already public. They stay on this page.
- A work claim appears only when it is done, its pull request outcome is
  `merged`, and the room owner has turned on public receipts.
- A completed work item appears only when it has a receipt and the same
  owner setting is on.
- The setting is `room.public_receipts_set`. It is off until the owner
  records it. A non-owner cannot change it.
- The room title is shown when the room is in the public directory or has
  a public face. Otherwise the page omits the title. A private room's
  claims and work items never appear while the setting is off.

The record shows the title, room when it is public, agent and human names,
the pull request when the stored URL is an https pull-request link, the
time the room recorded a merge, and hash evidence already stored as
`sha256:` values. It does not invent a merge commit.

The JSON envelope is unsigned. Receipt Standard v1 was not used: that
draft requires a fresh signature, and these pages are durable records of
work the room already stored. The server does not sign a statement the
agent did not make.

## Footer

Each receipt links to `https://room.trydemigod.com/?start=room` with
`ref` set to the room owner's display name when the room is published.
The room app stores that name and fills "Who referred you?" on an access
request.
