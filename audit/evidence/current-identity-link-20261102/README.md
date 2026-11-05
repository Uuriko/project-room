# Normalized existing-identity linking

Own runtime `5aba0ad8f`; tests `31006729d` and `9fdb8c9c9`, based on root `80b05fbf0`. Root access-request patch `0cf6fe9a5` was separately composed locally as `b3bca4781`; do not cherry-pick that duplicate back to root.

`AgentIdentities.link` used whole-room hydration for the name census. Removing that read exposed its next dependency: the existing `Store.command(member.added)` had no qualified normalized context. The fix uses the existing protected roster for name checks and the existing `currentInviteContext` / `prepareCurrentWrite` path for member addition and active-true relinking. It retains Store.command authentication, server policy stamps, reducer permission/name/capacity checks, command journal, exact writes, hooks, history-floor transition and rollback. The identity holder's proof is still consumed only inside the enclosing transaction. No global identity is rotated.

The initial authorization now reads owner plus authenticated actor; the membership decision admits the complete protected roster. Its internal 1,024-record reservation is specific to membership admission and retains the existing 256 KiB byte limit and ordinary 200-record default. An explicit deactivation remains refused: held-work dependencies were not qualified by this patch. No full legacy document fallback is added.

Qualification:

- Four causal before failures retained; original four controls pass after the patch.
- Final focused controls prove same global identity/secret, exact narrow grants, cold authentication, no duplicate membership, malformed holder-proof refusal, save fault after real proof consumption with atomic rollback and exact-input retry, inactive member reactivation, reserved-name refusal, unauthorized linker refusal, admission of the 100th member and refusal of the 101st.
- Those five controls composed with root's access-request test: **6/6 pass**, no skips, exit 0.
- Actual Native Worker on the **package-default July engine**, no override: **1/1 pass**, no skips. The real saved-proof fault rolls back, exact retry commits, cold restart authenticates the intended same identity with exact permissions, duplicate link remains 409, link count is one and sequence unchanged.
- Existing identity suite initially had **25 pass / 1 fail** solely because line 729 read `store.room(newAgentRoom)` to assert the owner. Its equivalent protected `roomAuthority.ownerId` assertion preserves the expected identity and all delegated-admin negatives. Final **26/26 pass**, exit 0.
- Holder-proof, link-code and membership-delegation suites: **48/48 pass**, no skips, exit 0.
- ESLint exit 0, with 34 existing raw-member warnings; secret scan exit 0. No whole-suite, deployed or live claim.

Commands use `/Users/johnpotter/.local/bin/node` v24.22.1:

```sh
node --test tests/current-identity-link.test.mjs tests/normalized-access-requests.test.mjs
node --test tests/agent-identities.test.js
node --test tests/identity-link-holder-proof.test.js tests/identity-link-code.test.js tests/membership-delegation.test.js
node --test cloudflare/current-identity-link.check.mjs
```

Full logs, source hashes and outcomes are retained in `receipt.json` and compressed attachments. Synthetic fixture data only. Account/OAuth continuity and the wider owner-admin port have separate owners and evidence.
