# Project Room: one combined local candidate

John requested: “unify everything as much as possible.” This is the integration
ledger, not a new product branch competing with the earlier prototype.

## Current source and preserved inputs

Use `work/project-room-unified-20260907`, branch
`codex/unified-local-20260907`, for further local integration work.
The root workspace's PROJECT-ROOM-CURRENT.md points here. Existing copies and
their unfinished work remain intact; do not resume edits in those copies without
first reconciling with this candidate.

| Source | Exact identity | Treatment |
| --- | --- | --- |
| Local account/invitation/guest/API milestone | Original base `7b5e92fa3245eab684e4a0f2e9c8f16c90441801`; complete preserved source snapshot `bc510072bdd8a4f9277f1aea515e3be9523df42d` | Included. Snapshot copies the allowed source, tests, scripts, docs and configuration; no live DB, credentials, dependencies or generated screenshots are committed. Original dirty checkout remains unchanged. |
| Published client candidate PR #20 | `f332fe590953ca8513eee58e55b01f29f46807ef`, base `30eaa935d55aaa91d6033d7ba9938f265a8cd20c` | Merged locally with explicit conflict reconciliation. Original remote PR remains untouched. |
| PR #12–14 stack | Preserved through PR #20 ancestry | Do not merge the obsolete stack again. PR20 is its integrated replacement. |
| Instinct latest service report | `c352d89a999f6be5d1a695d116e5daa30f392665`, comments 5566977847 and 5567486835 on issue #11 | Readable findings accounted for below. GitHub fetch returned “not our ref”; advertised identity branch still pointed at `1d184719`. No complete local matching identity.mjs/source tree was found in the checked Project Room and src paths. Full chain is NOT integrated. |
| Separate PR #9 harness | `08ccd8915a6d02f8f3fecaa3ca03c9e3bf7ca076` | Downloaded as retained Git reference `published/pr9`, not merged or run. Older schema assumptions and independent harness results remain separate from this build. |
| Earlier experimental gateway/Quiet Focus line | `work/project-room`, head `7ccbe2f6aca6743636d6d52fb552c3e51a6a4147`, gateway checkpoint `8b61372` | Preserved, not copied wholesale. It has separate agent-store/gateway/runtime modules; integrating it without canonical account/event adaptation would reintroduce a second work/runtime model. No live runtime claimed. |
| Grok Bot's conformance/adapter work | Latest observed receipt 5565330678; questions shared by Instinct at 5567414466 | No newer executable artifact or independent current-build result observed. Not counted as delivered. |

The source snapshot's inventory before integration matched the prior tested
fingerprint `b73fe979dec6b543194a83f4a7c4e46f9af3eec093e21e0f74d3e0f6d56a6b7f`.
That fingerprint does not describe this changed candidate.

## Reconciliation decisions

1. Retain canonical accounts, schema-v7 invitation journal/write fencing,
   invitation acceptance and share links. PR20's pre-account client does not
   replace current account/session ownership protections.
2. Bring in PR20's ReturnBrief controller, request-chain ownership, local refresh
   feedback and explicit frozen-horizon acknowledgement. Bind its ownership to
   account, authorization epoch and browser session as well as generation/room/member.
3. Keep one status implementation in src/workflow.js. Browser presentation,
   structured API next steps and return selectors all use it. PR20's
   src/work-status.js is only a compatibility re-export, not a second implementation.
4. Adopt PR20's exact-current-receipt decision checks and decision archival on
   blocker resolution/restart. Missing evidence and stale approval cannot silently
   close work. Preserve distinct producer/reviewer requirements.
5. Retain the stronger canonical composer selection, operation ownership,
   account-switch cleanup and invitation focus behavior while adding PR20's
   optional draft recovery. Scope recovery to room/account/auth epoch/member/session,
   refuse missing scope, preserve both message and command IDs, and never restore
   the old room/member-only storage format.
6. Union the browser suites rather than replacing the invitation suite with the
   composer suite. Add a combined guest/recovery/catch-up/agent journey. Keep
   screenshot generation and the existing CI entrypoint.
7. Avoid duplicate next-action copy in work cards; show one shared next actor,
   human-readable state and last recorded update. Reported work is not live presence.

### Instinct lifecycle findings

The rework approval invalidation finding is covered by current reducer history,
the imported archive-on-resolve/start change, and integrated return-selector tests.
Supersession already retires active claims in the canonical base with explicit
`status: superseded` and `supersededAt`; existing event tests pin that behavior.
Instinct uses `released` plus a reason. We preserve the canonical event vocabulary,
not both representations. Verifier findings still use exact-version
`verification.recorded`, not an unversioned direct blocker path.

This is behavioral accounting against readable reports, NOT an independent
execution or complete merge of Instinct's identity/OIDC/session-administration,
contribution-ledger, review-class or operational work.

## Verification and evidence

Verification is on the combined source, not a sum of the inputs' test counts.
The new tests in tests/unification.test.js cover shared status/next-actor agreement,
stale and missing evidence, account/epoch/session-bound draft ownership, and
catch-up ownership. scripts/unified-journey-check.mjs exercises new guest entry,
opt-in draft recovery after reload, shared conversation, scripted agent completion,
review, and matching browser/API catch-up in one disposable room.

All automated identities and artifacts are synthetic and controlled by this
operator. These are not independent agents, organizational independence, live AI,
John's real approval, device/assistive-technology certification, or a release.

## Remaining unification dependencies

- A complete, reconstructable Instinct service/identity source artifact, including
  its base and ordered changes, is needed before schema/API adaptation can be done
  responsibly. A reported hash and passing count cannot substitute for source.
- Grok's current executable conformance/adapter artifact and intended target
  revision are needed for independent runtime/contract validation.
- Remote publication/merge/deployment are not performed by this local operation.
  The tool rejected the attempted shared GitHub coordination message; it was not
  delivered. A non-blocking explicit destination/payload approval question was
  sent to John. Local board/bus claims were posted, not a claim of remote receipt.
- Existing source references are preserved; no service from Dasha, Desk or DIE
  has been imported. “Everything” here means Project Room, not unrelated products.

## Operational boundaries

The original 127.0.0.1:52330 preview and original source copies are preserved.
Only the disposable localhost:52331 preview may be switched after a complete
passing run, with its existing database retained and a rollback copy recorded.
The source handoff is a local merge commit; GitHub PR #20 and main are unchanged.
No old test total is added to the current result.

## Final local receipt — 7 September 2026

- Core/API/syntax: 183 passing tests, zero failures or skips.
- Combined browser suite: 33 passing scenarios, zero failures or skips.
- Runtime: Node 24.19.0, Playwright 1.62.1, installed macOS Chromium headless
  shell revision 1234 (Chrome for Testing 151.0.7922.34). These are local results,
  not a newly run GitHub CI result.
- Source/test/config inventory digest:
  `094d6cc6e8ef4d9c72a43051a2c4079b5422108e4209c5f1c18f548141ef9280`.
  Computed with the prior audit's sorted src/server/client/scripts/tests plus
  index.html/package.json/server.mjs inventory; docs, generated artifacts,
  Git metadata, ignore rules and CI configuration are not included in that digest.
- Lockfile SHA-256:
  `4fa2de4c761761b195619dcf594b75333a268cd5296c06c65965096f2d6a7e70`.
- Logs: test-results/unified-core.log and test-results/unified-browser.log.
- Browser images include test-results/unified-desktop.png and
  test-results/unified-guest-mobile.png, plus the combined suites' invitation,
  conversation, catch-up and reflow screenshots. These are generated local
  artifacts, not committed public assets.
- The existing disposable preview at http://localhost:52331/ now serves this
  candidate. Its served src/app.js digest matched the local file:
  `71c5dce1784fc5d9344565d95ff20de9b613924a1848521b79df65965e9e9ff9`.
  Refresh an already-open page to load the new UI; we did not discard its unsent text.
- Both existing synthetic handoffs remain revision 9, next step complete.
  No new identity or business decision was made on the retained preview.
- Previous execution session 37219 exited successfully. New service session:
  95809. Same database:
  `/var/folders/h3/r7zqdttd19v3xzb_q69dqkzc0000gn/T/project-room-acceptance-OiUVFY/room.sqlite`.
- After stopping the old service, a private rollback copy was saved at
  `/tmp/project-room-unification-backup.wEDt0R/room.sqlite` (directory private,
  file mode 0600). Read-only invitation audit passed: 3 invitations, 6 journal
  entries, no legacy baselines, complete journal history.

The integration introduces no database schema change. To roll back code, stop
only the disposable unified service and run the original canonical server
against the same DB; do not overwrite later user data with the backup casually.
Use the backup only for an explicitly chosen recovery operation. Original
preview at 127.0.0.1:52330 and all source inputs remain untouched.
