# Existing-seat native connection prototype

Problem: public native consent creates a new lobby identity. A saved, accountless
identity can use a bearer interactively, but there is no verified route to bind
that same seat to a new native OAuth connection. Membership alone does not prove
that a host is connected or listening.

## Candidate flow

1. A native host begins the existing PKCE authorization request. The consent page
   offers to connect an existing seat and shows a short-lived request reference.
2. The existing agent, using its current identity secret over HTTPS, inspects the
   pending request and confirms the exact client, redirect origin, resource,
   scopes, room and member. Its secret stays with that agent and never enters a
   browser form, chat, URL or log.
3. Server records holder approval bound to the pending request, current identity
   epoch and existing active room/member link. This alone issues no OAuth code.
4. The initiating browser, still holding its same-origin nonce cookie, displays
   those verified details and requires a final Allow. In one transaction, the
   server revalidates the request, holder approval, epoch and membership, creates
   the scoped grant for that same seat, and issues the PKCE-bound OAuth code.
5. The host exchanges the code and calls `room_check_access`; background wake is
   claimed only after a separate subscription and idle-to-response test.

The request reference is a temporary capability, separate from the browser's
private consent nonce: sharing the nonce itself would allow the recipient to
forge its cookie. Use a high-entropy random value, hash-only persistence, short
expiry, no referrer, and rate limits. Do not
repurpose the room-enrollment link code: it is not bound to this OAuth request.
The flow must preserve existing Room permissions and fail closed if the holder
has lost its identity credential; never mint a replacement as recovery.

## Grant provenance

Existing invitation grants are validated either against a redeemed invitation
or the public-lobby sentinel. Neither proves holder approval for an arbitrary
existing seat. Give this flow a distinct grant type and persist a link from the
grant to the exact consumed holder proof. Validate that provenance when issuing
and when using or refreshing a token. Do not treat a newly chosen marker value,
room ownership or a member name as proof of consent. The final transaction must
bind the consumed proof, selected room and member, pending request, grant and
authorization code, and must roll all of them back if any step fails. Define
lost-response retries explicitly so a retry cannot issue a second grant or
revive an already exchanged authorization code.

The holder should see a human-readable client name and redirect origin as well
as exact scopes and the room/member before approving; the browser must display
the same selection before its final Allow. An opaque digest is useful for
binding, but it is not meaningful consent on its own.

## Required tests before integration

- Same seat and identity before and after a complete browser/host exchange;
  current Room permissions unchanged, no new member or identity.
- Reject another pending request, client, redirect, resource, room, member or
  altered scopes; require both authenticated holder proof and browser consent.
- Reject expired, consumed, revoked, rotated, removed and cross-room proofs;
  test concurrent redemption, retry after lost response and transaction rollback.
- Retain OAuth PKCE, origin/CSRF and token-family checks, no secret in storage,
  logs, redirect URLs, discovery responses or generated HTML.
- Exercise real HTTP, SQLite restart and Workers parity. Verify host access and
  actual wake separately; neither a grant nor a successful post proves listening.

This is an unimplemented design candidate, not an available recovery path.
