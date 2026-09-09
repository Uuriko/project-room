# Local v8 recovery checkpoint — 2026-09-07

The combined local candidate now has stronger read-only backup verification,
an exact-commit runtime package, pause-before-storage behavior and a tested
compatible application switch. **Nothing in this checkpoint is pushed or deployed.**
Recorded live remains fb90a70 / Worker 901be347 / schema v7; live was not reverified.
The long-running product/retention/growth goal stays active and incomplete.

## Source and retained artifacts

- Implementation: `b605e968a1e914a91f84f7f94a96b06e2b783a13`.
- Final tested source and runtime package: `65f094eb66231e13007dc5fc44853d9a812194ad`.
- Frozen compatible v8 baseline: `7075c1ddfe5ced3ae970f817dbfd0fc3e88a13b6`.
- Subsequent checkpoint documentation does not change the runtime.

Both exact packages are preserved outside the source checkout, under the project
mirror's `work/project-room-runtime-packages-20260907/`:

| Package | Files / public assets | Manifest SHA-256 |
| --- | --- | --- |
| `candidate-65f094e` | 49 / 15 | `2cc5d94d0f29c2cc220a6d6179cd619df772683a0e8e6c8d683905b2e9d6094e` |
| `baseline-7075c1d` | 47 / 15 | `c7a958ce6fdcc3d70bee48961112a2a5abcf60b44d1699ef1ae5d2a1eda0a562` |

These are source/runtime artifacts, not data backups. They contain no user data,
operator credentials, fixture state, dependencies, screenshots or publication
authority. Independent verification checks exact content and the allowlist;
trusted provenance requires keeping the manifest digest separately.

## Implemented behavior

1. Existing Node online backup now audits all 18 application tables. It checks
   SQLite/FKs, schema/writer fences, invitation/share-link integrity, room identity,
   projection replay from a retained legacy checkpoint plus strict tail (or full
   history without one), reminder receipt chains/row relationships, and table
   fingerprints. It never repairs or migrates while verifying. Reports contain
   counts/digests, not messages, raw credentials or participant identifiers.
2. Disposable two-room recovery fixture covers account/member bindings, current/
   revoked keys, room/account/guest sessions, suspended/logged-out identities,
   pending and accepted invitations, share-link cancellation and retry, retained
   commands/read markers, evidence and active/cancelled/resolved reminders. A real
   supported v1 fixture migration creates its legacy checkpoint before newer data.
3. Exact-commit packaging reads Git blobs, not dirty/untracked workspace files.
   Fresh private destinations and a manifest-last completion marker prevent silent
   overwrites. Standalone verification rejects missing/changed/extra/nonregular
   files, duplicates and incomplete output; checks literal imports and metadata.
4. New strict operator pause flag returns no-store 503/Retry-After before database
   startup/bootstrap/object binding. Missing/corrupt production data can remain
   paused without being opened; returning to normal still refuses invalid data.
   Host/origin checks remain. No restoration or administration endpoint was added.
5. Actual cold packaged Node startup, real workerd package switching, browser resume
   and existing workflows remain in automated gates. CI's Cloudflare checkout now
   retains the history needed to package the exact fallback ancestor.

## Verification performed

Final tested source `65f094e`, existing Node 24.19.0 and installed locked tools:

- `node scripts/check.mjs`: **377 passed**, including all source syntax checks,
  nine recovery tests, six pause tests and the packaged-runtime contract.
- Complete configured `test:browser`: **77 passed**. New journey starts the actual
  Node entrypoint paused over populated data, verifies no changes/cookies, resumes
  the same Room, signs in and checks preserved data and 390px/200%-text reflow.
- All configured local Cloudflare checks plus browser: **9 passed**. No wrangler,
  live API or provider administration was used.
- Exact public asset build: **15 assets**. Production entrypoint bundles locally
  to **203,302 bytes**; no dependency or storage-schema change in this slice.
- Both retained packages independently verify with the manifest hashes above.
  Cold verification ran with Git absent from PATH and without the source checkout;
  the packaged production Node service was started paused then resumed with an
  explicit external disposable database and loopback proxy simulation.

The Workers rehearsal imports each exact package's production entrypoint through
a test-only wrapper. It keeps the same class/binding/object name and persisted
object while switching candidate → candidate paused → baseline → candidate.
All 18 application-table fingerprints match at each boundary, schema remains 8,
idle writer permit remains 0. Candidate and baseline can create work/reminders;
their exact retries survive later switches. Baseline store-level exercises also
check room/account/guest sessions, denied revoked/suspended/logged-out identities,
historical reminder/guest retries and pending invitation acceptance. HTTP owner
reads/writes, denied old agent key and unchanged human cursor are separately tested.
No in-flight switch or provider PITR is claimed.

Final rehearsal's synthetic audit fingerprints:

```text
seed:           5cfd356855c84f7dad809a7fb341dcef82900912e22acfa12c721936c6bacba0
afterCandidate: 0a2cecf6b70bf60fac71c013d0f1ef4667fc5f3e9e284a128fc71ef6bf0efea8
afterBaseline:  8a91c549be8053a1c04f59dcfa64f2f003d899fbc71d2b471db972a86da59a4e
```

## Visual evidence and review

Viewed current `test-results/recovery-paused-desktop.png`,
`recovery-resumed-desktop.png`, `recovery-resumed-mobile-large-text.png`, and local
Cloudflare `test-results/cloudflare-desktop.png` / `cloudflare-mobile.png`.
Pause deliberately uses a dependency-free two-line unavailable response, not a
working app shell. The resumed app preserves its quiet catch-up, conversation,
contextual work and mobile layout. The enlarged-text capture includes the existing
temporary sign-in status; no human preference or retention lift is inferred.
Screenshots are local, ignored regression artifacts, not newly published evidence.

Three agents reviewed read-only; root was sole editor. Review led to stricter
reminder history/account checks, truthful checkpoint replay reporting, pause host
checks, invalid-config/resume tests, a corrected destination basename, clearer
literal-import limitations, cold server startup and broader fallback identities.

Early fixture runs caught and corrected test-only assumptions: a non-HTTPS test
origin, an unsupported command field, Node fetch ignoring the chosen Host header,
macOS temporary-path aliases in the standalone CLI guard, and a style-tag injection
blocked by the existing content policy. The final full runs pass. The local
Workers browser emits known synthetic certificate-rejection diagnostics; certificate
validation was not disabled and the browser/restart assertions passed.

## Remaining gates and next work

Use the [operator runbook](V8-RECOVERY-RUNBOOK.md). A captured copy can restore access
revoked after capture; table fingerprints do not prove current authority or every
historical fact. Node recovery is not Durable Object data failover. Frozen 7075
does not understand the new pause flag; real fallback requires an independent
traffic block or separately tested pause-capable artifact. Provider PITR→undo,
including recovery when normal app startup is unavailable, remains untested and
requires separate explicit authorization. Do not migrate the live v7 workspace yet.

All test listeners/browser processes finish under fixture cleanup. New recovery/
package fixture data and plaintext test credentials are removed with their private
temporary directories. Existing compatibility/browser fixtures retain their own
synthetic persistence as before; existing previews/live data were not touched.

Next under the active goal: research and plan one **previewable reusable outcome or
work-template loop**, then implement the smallest complete useful slice. Preserve
free/manual/BYO-agent value and current authority. Default to deliberate selection,
no inherited members/permissions/credentials, no automatic public posting and no
claimed retention/growth until measured. Keep completed recovery work as a gate,
not an excuse to restart it or mark the whole product goal complete.
