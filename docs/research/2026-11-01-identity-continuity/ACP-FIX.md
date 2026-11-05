# ACP saved identity fix and finite acceptance

Runtime candidate:001adec71229d5789447c56f2d7c9ff3c1b31826, based on frozen reproduction7da187f89a44600b29d97ca0061d1cb3e34abfdd / main ef583ba81. No push, deployment, live key or schema change. Pairing e619 remains untouched. Native OAuth and parser/link/agents files are unchanged.

`room-acp <single-use agent invitation> --room <saved-room-id>` now uses that explicitly selected saved Room identity. The invitation chooses the destination. The client requires exact saved apiBase, verifies the identity ID with the existing bounded identity room-list route, and checks the source membership using the identity credential and existing identity-only snapshot. Labels/provider logins are not identity proof. Redemption receives the verified identity secret through the existing RoomClient interface.

- Same-room existing membership keeps the server409, the unused invitation and the saved file byte-for-byte. No bypass, regrant or new principal.
- Another room joins as the same identity and saves only the existing returned room-scoped connection. The original room credential remains unchanged. Original request IDs, save recovery and token recovery semantics are retained.
- An ambiguous default overwrite refuses before redemption. Explicit selection may correct a preflight-only refusal, with the same private request ID; once any business mutation has been attempted, the journal's selected room/member/identity binding cannot change.
- Preview only identifies the destination before locking. The actual redemption/recovery room and selected identity must still match before saving or continuing recovery. A changed response refuses and retains the uncertain original operation.

## Destination ownership and interruption

The existing private SQLite/file journal primitive is reused. Acquisition is always invitation then one destination; no two destination locks are acquired. The destination key follows the actual sanitized saved filename across origins. Its receipt binds the unresolved invitation-operation digest to exact apiBase and Room ID. A different invite/origin cannot replace that unresolved operation, including after process exit. Every physical lock closes on failure. Timeout, unknown response and later ambiguous errors do not clear the durable owner; only an authoritative first no-write refusal or durable successful save/completion does.

The original operation can reconcile an interrupted save, including a process exit after file rename and before completion receipt. It recognizes its own previously journaled identity/member, preserves that file, completes the receipt and clears unresolved ownership. Legacy code journals retain their old key and original request body; an already-used code is recovered only through that saved operation, not treated as a fresh invitation.

## Explicit shared-link limit

Selected-identity SHARE to a new target **remains incomplete** and refuses before membership admission/token rotation, with guidance to request a single-use RM invitation. Shared admission lacks a request-bound, non-revoking scoped-credential issuance/recovery receipt. The current rotate endpoint is not idempotent and can revoke existing target-room onboarding keys. The candidate does not install the broad existing identity bearer to fill that gap or silently rotate another host's credential. An already-saved target scoped credential is checked and reused byte-for-byte. Existing first-time share compatibility is retained, with no claim that every shared-link enrollment/mint interruption is solved.

This remaining contract is also recorded in full-audit-20261031/EXECUTION-LEDGER.txt. The candidate introduces no backend endpoint or new identity store. Existing RM lost-response recovery keeps its previously adopted rotation semantics: matching target-room onboarding keys may be replaced; it is not a new non-revoking multi-host issuance guarantee.

## Evidence

- Frozen7da reproduction:4 controls passed/1 intentional MVP replacement guard failed. CLI selected-room join anonymously created identities1→2, agents3→4, links1→2 and overwrote the file.
- Candidate guard now forwards the existing identity credential and receives the backend409: identities1→1, agents3→3, links1→1; saved bytes and invitation preserved.
- `/tmp/acp-saved-selection-all-final.log`:116/116 ACP/native-identity controls pass, including package/bridge/listener/permissions/restart/wake suites. This run preceded two error-wording changes and a test helper portability correction.
- `/tmp/acp-saved-selection-final-affected.log`:26/26 recovery/selection controls pass after those final edits. Covers simultaneous different-invite race, unresolved response/save failure, actual child-process exit before response and after file rename, original retry, selected identity binding, cross-origin filename collision, legacy journal wire equality, response mismatch, shared-limit refusal and preservation of another target host's credential.
- Changed-file ESLint clean; exact runtime/manifest/dependency/coverage preflight passes666 runtime source files. Manifest changes are only README, cli and join asset hashes.
- Actual npm archive built from exact001adec.20 explicit input files; all extracted bytes match source; no tests, node_modules or private state. Cold extracted CLI performs real local first enrollment, then selected same-room409 with identity count1 and unchanged saved file/invitation. ArchiveSHA2566dd9c774a58dc956fde080b427ca6e3330d1c5aa65df572c08d288f09ef0bcf9. This does not qualify an actual host/model turn.

One prior broad run had113/114 passes because a listener test created two different identities in the same credential home and relied on silent overwrite. It now gives the second independent agent a separate existing ROOM_ACP_HOME; the listener protection assertions remain unchanged. The final-save fault fixture now injects its directory blocker after redemption to exercise the actual interrupted-save path, since a preexisting invalid target is correctly refused before burning the invite. Full failed logs are preserved; no permission check was weakened.

Root owns composition with5574 and Grok's /a parser, final head checks, merge, deployment and live journey qualification. No new release authorization is inferred from the local package test.

## Composition with main c52db5878

Normal merge a4da3f539be8cc46bf037aedacc8467a1f181c5b preserves every original candidate commit and exact main c52db58787467390042295b181b152ef3ba4de12. Main link/agents/parser sources, issuer selection and CODEX_HOME behavior remain byte-identical to main. The generated manifest already composes correctly without manual hash edits. INDEX now reaches both identity receipts and main’s legacy wake-drain removal receipt.

The combined source passes 55 affected selection/recovery/join/agent/preflight/package/identity controls and preflight checks 667 runtime files. Changed-file ESLint has zero errors/warnings. Actual 20-input npm archive SHA256 is 174f731afc8594438fbca9373289aedb0ad3b794ef75de9f342ed6fe14dc68e1. Every extracted input matches source. The extracted CLI cold enrollment followed by selected same-room409 preserves identity count1, saved bytes and unused invitation. This remains local fixture evidence, not a host/model or deployed qualification. Selected SHARE new-target remains incomplete under the boundary above.

CI=1 contract passes, including both cross-cutting catalog guards; the runner explicitly skips the full Node suite in this mode. The first contract run caught two candidate Markdown orphans; minimal INDEX links fix both (803 links pass). Repository ESLint reports 0 errors and 335 existing warnings. Both contract logs are retained. No push, PR, deployment, live key or schema change.
