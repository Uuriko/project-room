# Account-first Inbox

## Local behavior

Open `/?account=1` to sign in with an account key without selecting or joining a room. Inbox and Rooms are the two primary destinations. The local sample launcher now prints this account-home URL; its returned room-bound URL remains available to existing fixtures.

An account with no memberships can read, save and send a synthetic private reply. That does not create work, invite a helper, join a room or change room history. Rooms lists only the current account's authorized memberships; empty accounts can join through an invitation. Selecting a room opens its existing conversation. Switch room is contextual, not another main destination.

Room access and account access have separate lifetimes. Room loss clears room context, result previews and sharing controls without discarding the same account's private draft. Account loss/replacement clears private content and navigation metadata. Periodic visible-page and focus checks confirm account identity without changing client ownership on an unchanged response. Transport uncertainty is reported, not misrepresented as sign-out. Existing service checks remain authoritative for every read and write.

Private source text never appears in room discovery. Listing is authenticated, bound to the account session and paginated in stable room-ID order, at most 50 candidate memberships per page. Inactive or no-longer-authorized memberships are omitted; continuation advances past examined candidates. Pages are not a frozen snapshot and opening a listed room rechecks current access.

Ordinary member-key entry and invitation routes are preserved. The root legacy entry has not been silently converted into public registration. The new account route is not an access-control boundary and needs no secrecy.

## Small design changes

- Hide irrelevant room connection chrome on account home.
- Preserve private drafts while opening a room from an invitation.
- Clear room success notices when leaving their destination, while retaining unresolved error feedback.
- Keep direct reply independent of work/review machinery.

## Verification

New browser coverage includes desktop/mobile accounts with no rooms, direct synthetic sending, room discovery, room-only revocation, account revocation, another-tab replacement with a held response, legacy entry, explicit invitation joining, lost sign-out acknowledgement and temporary account-check failure.

Service/client tests cover membership filtering, bounded pagination, binding requirements, unprivileged credential refusal, account replacement and delayed confirmation. The local Workers HTTP check exercises the same room-list route.

Final committed-suite counts and screenshots belong in the accompanying checkpoint evidence; candidate passes are not deployment evidence.

## Remaining scope

Real mailbox connection, account enrollment/recovery UX, native personal conversations, hosted agents, rewards and deployment qualification remain separate roadmap work. Synthetic provider acceptance is not real delivery. Simulated-browser tests are not evidence of human delight or retention. The new account home is explicit; making it the universal root entry requires an intentional legacy-routing migration.
