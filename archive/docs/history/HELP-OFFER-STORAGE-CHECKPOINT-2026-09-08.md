# Help offers: durable storage checkpoint

Previous goal turn made progress by testing a dormant contract. This turn enables
the contract in the local authenticated service with schema/writer14. It does not
deploy it or add human offer controls, dedicated agent tools or execution.

## What works

- The existing command endpoint accepts strict offer-open and offer-update data.
  The authenticated actor and service clock are authoritative. Exact work, help
  and offer revisions are checked inside the existing write transaction.
- Opening, selection, decline, withdrawal and explicit release reuse the exact
  command receipt ledger. A retry returns the original event, not a new offer or
  resurrection. Ordinary messages and work revisions remain unchanged.
- One offer per helper/request version, five pending per task and per member,
  and one selected helper per task are enforced while holding the write lock.
  Selection is a coordination record, not a work assignment or external grant.
- Expiry or withdrawal never silently frees a selection. Release requires an
  explicit acknowledgement that outside activity is unverified. Valid cleanup
  remains available at event/projection capacity; new work does not bypass limits.
- Retained-history reconstruction verifies invitations, offers, transitions,
  accountable/helper membership facts and the current/checkpoint projections.
  It reconstructs relevant historical facts without applying modern completion
  rules to all legacy work. Retained events behind a checkpoint are still checked.
- Startup rejects pre14 offer-field/event collisions before upgrading. Current
  and checkpoint fields are checked even when null or empty. Older Node writers
  and Workers permits are fenced atomically; failed migrations roll back.

## Evidence and corrections

Final source: `39849416e8d3305a99f446232a3ef0f6bd3d21e4`.
Runtime tree: `c08207cbc068d6e87f8505caaa3e34b00416af4c`.
663 core/API/package,16 local Workers and193 full simulated-human browser checks
pass. The browser/Workers runs used
the same runtime bytes as this final source (later changes added tests only).
Three complete passing logs and two inspected Workers screenshots are retained
in sibling `project-room-runtime-packages-20260908/evidence-offer-storage`.
All68 source runtime hashes match the frozen candidate. All test runs finished.

Final added tests
cover an actual cross-task race for one member's remaining offer slot, receipt
insertion rollback and exact HTTP serving of all21 public assets. Independent
Node database connections also race competing selections and a task's last slot.

Genuine frozen v8–v13 Node/Workers upgrades preserve populated data, roll back
injected failures, retire pre-open old writers and survive restart. Workers tests
exercise offer→selection→invitation withdrawal→release plus exact retries after
restart. These are local workerd tests, not a hosted migration or provider restore.
The historical v8/v12 fallback-switch tests remain historical; neither is a14
fallback. No database was downgraded to make a test pass.

The first full regression exposed three assertion/fixture failures and one real
asset-serving omission: the new browser-imported module was missing from the HTTP
allowlist. It is now served and all public asset bytes are tested over actual HTTP.
Expected package counts now include the new module. The older13 discovery test
uses its own genuine frozen13 fixture rather than opening new14 data. Subsequent
full core and Workers runs passed. Desktop/mobile Workers screenshots were viewed;
the existing conversation layout is intact, with no new offer UI claimed.

## Frozen candidate and boundaries

Verified package: `../project-room-runtime-packages-20260908/offer-storage-3984941`
relative to the repository root. Schema14,68 files,21 public assets.
Manifest SHA256: `cf856bccfebc1ecd84803120e1896dd6d38a452752ee734dd57e5981dd495796`.
The initial package command was refused because its destination was relative;
the successful command used an explicit absolute new directory. No package was
overwritten. Historical13 packages are preserved unchanged.

No push, deployment, live migration, provider write, model call, payment or existing
preview restart occurred. Tests use synthetic records and scripted clients, not
human research or proof of agent reasoning, retention or collision-free external
execution. The full goal remains active/incomplete.

## Next: finish the human/agent slice

1. Add negotiated, authenticated offer context to current-work and selected-task
   reads. Validate exact scope/participant facts and fail unavailable on older
   services. Existing help discovery currently describes invitations, not offer
   queue eligibility; do not silently reinterpret its existing version1 contract.
2. Add thin agent offer/select/decline/withdraw/release operations using these
   same command shapes, authority checks and exact receipts. No dispatch.
3. Add contextual Offer / Choose / Release controls inside the existing help
   disclosure, not a new dashboard. Preserve drafts, keyboard/touch behavior,
   stale context choices and unknown-save recovery.
4. Test the complete simulated-human/multiple-scripted-agent negotiation and
   contribution journey, including selected-scope changes and unverified outside
   activity. Ordinary answers and parallel drafts remain separate capabilities.
5. Qualify a distinct14-compatible fallback and hosted/current-authority recovery
   before any authorized release. Native-host acceptance remains a separate gate.
