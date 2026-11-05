# Finite existing Room identity qualification

Base ef583ba81eeeb284c8b743829aa4a0555752a0e8. Synthetic local HTTP only; no live DB, keys, OAuth client registration, model calls or runtime changes. Pairing e619 remains unchanged. This is a reproduction/review checkpoint, not a mergeable green fix.

Run: `node --test tests/identity-continuity-qualification.test.mjs` with Node24.22.1. Result: **4 controls pass /1 intentional MVP guard fails**. `/tmp/identity-continuity-final2.log` retains the complete result; ESLint for this test is clean. CLI joins use the normal accepted arguments through main; the fixture's joinOnly switch skips ACP adapter/model execution and therefore does not qualify host readiness.

| Supported path | Observed authoritative state |
|---|---|
| First ACP invitation enrollment, no prior Room identity | Exactly1 new identity/member. Same-invitation retry preserves IDs and adds nothing. Legitimate enrollment. |
| Existing RoomClient configured with verified identitySecret, fresh invite to same room |409 identity_already_linked; no new identity/member, invite remains available, saved connection unchanged. Correct refusal. |
| Existing RoomClient configured with verified identitySecret, invitation to second room + identical retry | Identities1→1, one second-room identity link, same new room member on retry; scoped credential passes actual checkConnection. Correct attachment. |
| Existing managed agent, account OAuth connection=account + chosen agent_binding | Identity possession proved by existing link code and agentConnections.create; authenticated account selects that bound agent.2 consent/code exchanges, refresh and room_check_access preserve identities1→1/members2→2/links1→1. Correct continuity. |
| ACP fresh invitation with --room commons after saved existing connection passed checkConnection | CLI ignores room selection and sends redemption without Authorization. Success overwrites commons.json, identities1→2/agentMembers3→4/links1→2. Exact retry stays2/4/2. Both old and new credentials still authenticate. Intentional red guard requires refusal without overwrite or explicitly selected-principal attachment. |

The ACP red proves lost selection and silent local replacement, not that a provider login, display name or human account proves the same agent. A deliberate new agent may legitimately need a new identity, but the current command does not distinguish that from replacement of the selected saved Room principal. The proposed guard is an MVP product contract for review; it does not retroactively authorize auto-merging or claim that --name defines identity.

## Corrected native OAuth assessment

Accountless invite OAuth has no accepted existing Room identity input. It explicitly tells the user that reconnecting from the beginning uses a fresh invitation and creates a new agent seat (`server/mcp-invite-oauth.mjs:116`). A provider-side existing Dot without any verified Room principal is first-time Room enrollment. The invitation and nonce bind its new grant; the same nonce retry does not create another seat. This is not evidence of a duplicate-identity bug.

The page offers the supported existing-agent alternative. `server/http.mjs:1741–1750` links to connection=account; `:1790–1816` lists validated choices and posts agent_binding; `:1900–1906` revalidates before code issuance. `server/mcp-oauth.mjs:59–87` requires active account, exact human account/membership, exact identity link/epoch, active managed connection and controller authority. Being an invitation sponsor/accountable human alone is insufficient. The finite HTTP control demonstrates the supported route preserves IDs. No native OAuth runtime change is proposed.

## Smallest ACP contract proposed for root review

Use the already parsed --room as an explicit saved-connection selection on join, instead of accepting and ignoring it (`room-acp/src/cli.mjs:49`; args.mjs:16,45). Before invite redemption, load the selected saved connection, verify it with existing RoomClient.checkConnection, require its saved identitySecret and exact approved apiBase match, then pass that identitySecret through the existing RoomClient constructor/redeem path (`room.mjs:12,35–58`). No new flag, identity registry, principal merge or OAuth permission.

- First-time join with no existing selected Room identity remains enrollment.
- Selected existing identity joining a new room retains identity and gains only the explicit invitation's room membership/scope.
- Already active in the target room returns existing server409 without consuming the invitation or overwriting local credentials. It may explain how to use the saved connection; do not silently rotate/regrant it.
- Missing/revoked/invalid selected identity, multiple ambiguous saved principals or origin mismatch must refuse before consuming an invitation or replacing any file. Do not substitute a fresh identity or widen grants.
- The private existing join journal must bind the explicitly chosen identity ID/API base for retries, while retaining the original request ID and current interrupted-save/recovery behavior. Do not infer identity from a newly rotated bearer or persist a second identity store.
- Without explicit selection, discovering an existing target-room saved file must not silently replace it. A reviewed later UX may distinguish deliberate second-agent enrollment; this qualification does not invent a replacement flag or policy.

Runtime mutation is held for root contract review and Grok parser-lane reconciliation. Grok was notified on disk bus437560ec; no /a/parser/link/agents/origin policy source was edited. Only this new test and memo are owned by this checkpoint.
