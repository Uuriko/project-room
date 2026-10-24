# Help invitations: service and recovery checkpoint

Previous goal turn was progress: fd6b49a implemented a dormant shared contract.
This checkpoint connects it to the real reducer and authenticated command service.
The full help-wanted feature remains unfinished: no human setup controls, structured
agent discovery or invitation-bound offer path yet. No publication or live migration.

## Implemented

- `work.help_updated` stores one optional invitation on an existing work record.
  Strict fields, exact work/help revisions, current accountable authority, bounded
  scope/expiry and owner withdrawal use the shared contract. Help changes do not
  increment work revisions, move read markers, assign work or dispatch an agent.
- Existing generic HTTP commands authenticate the actor, stamp event time/identity,
  persist receipts atomically and replay exact retries. Reusing an ID with different
  content fails. An old opening receipt is historical, not evidence of current consent.
- At event/projection capacity, existing invitations can still be withdrawn once;
  new openings/updates remain refused. Earlier offers/drafts are not erased.
- Writer/schema13 gates the new semantics. Node preserves historical guards;
  Workers replaces only verified old permits/guards atomically. Pre-open old writers
  cannot mutate upgraded data. No automatic data downgrade or fallback bypass.
- Migration rejects existing helpWanted projection/checkpoint fields, including null,
  and pre13 occurrences of the reserved event type. Ignored legacy message fields
  remain ordinary message data; they do not become invitations.
- Startup/read-only/recovery checks validate the retained help history, including
  content behind checkpoints. A narrow historical projection reconstructs work
  definition/revisions, accountable access and completion anchors without applying
  modern completion/verification authorization rules to unrelated legacy work.
  Current/checkpoint help and supporting facts must match that history. Startup
  checks use a consistent transaction and fail closed; they do not repair help data.
- Public/runtime allowlists include the shared module. Historical schema12 manifests
  keep their exact19 assets; current schema13 has20. No new package dependency.

## Findings and corrections

The browser/scripted-MCP journey found an integration bug missed by the first
service tests: native draft provenance searched for any event with expectedRevision
and assumed it incremented the task. Help checks that revision but does not increment
it. After invitation changes, reading/adopting a valid draft consequently failed.

An explicit shared list of actual work-revision event types now drives the historical
evidence lookup and help auditor. The lookup remains bounded to one prior mutation,
with parameterized types. A regression test covers help open/withdraw → draft read
→ exact native adoption → recovery. Four desktop/touch scripted helper/contributor
journeys pass after the correction; these are not native-model reasoning tests.

The new browser step injects actual help events through the service while a human
has unsent text. It waits for each exact event to appear in the browser's history,
checks text/focus/work revision preservation, then continues existing contribution
and review. This proves event delivery/replay compatibility, not an unbuilt help UI.
The existing conversational offer predates the invitation and is not represented
as an invitation-bound offer. Two inspected screenshots show the retained composer.

Compatibility fixtures also needed correction. Old-service tests must create data
with their frozen schema12 fixture, not a current schema13 constructor. Historical
Workers switch tests now use exact historical source and per-package asset lists.
No test downgrades new data to make an old service accept it. HTTP create remains201;
the initial test expectation was corrected rather than changing the existing API.

## Evidence and limits

- 619 core/API/package checks pass. Includes exact cold-package open/withdrawn help
  recovery and retries, two independent Node worker threads racing update/withdraw,
  checkpoint corruption cases, real schema8–12 upgrades and failed-upgrade rollback.
- 15 local Workers checks pass. Includes actual adapters upgrading7–12 to13, injected
  failure rollback, old-writer rejection, help open/withdraw/restart retries and two
  browser contexts on the current service. Two checks preserve historical8/12 app
  switching; **they are not schema13 fallback qualification**.
- All184 browser checks pass on the final fixed source (172 seconds). The earlier
  failed run is retained as evidence of the draft-provenance bug, not overwritten
  or represented as passing. The four focused help/contribution journeys also pass.
- Frozen source `87a54234db084eb7a2fe31de092c6301b5158bd2`, tree
  `a621670fd2fb26d3b63c7b171f0367da0294d42c`, verifies at
  `../project-room-runtime-packages-20260908/help-storage-87a5423`:
  67 runtime files,20 assets,schema13; manifest SHA256
  `0558ef33062aaa3504f73061cca7892153803d1575fd92accd0ad12a6fadb55f`.
  This is a preserved service checkpoint, not a full-feature release certificate.

Four logs (core/browser/Workers and pre-fix browser failure), two inspected final
screenshots and two validated scripted-journey JSON records are retained at
`../project-room-runtime-packages-20260908/evidence-help-storage`. The records
explicitly mark help event replay as tested and invitation UI as unimplemented.
All test processes finished;67 current runtime file hashes match the preserved
package. Schema12 candidatecf377f3/fallback4d22189 remain untouched.

## Next

1. Add optional structured help context and bounded discovery through the existing
   authenticated work reads. Include the membership facts required to validate
   supplied guidance; older services remain unavailable, not implicitly open.
2. Bind explicit offers to the exact active invitation/revision with service-side
   limits and late-withdrawal handling. Ordinary conversation remains available;
   no inferred acceptance, assignment, claim, external permission or payment.
3. Add short contextual human scope/expiry/withdrawal controls with exact unknown-
   save recovery, stale refresh, keyboard/mobile/large-text tests and screenshots.
4. Qualify a distinct schema13-compatible fallback on populated data after the whole
   slice is implemented. Existing schema12 fallback4d22189 cannot serve13 data.
   Preserve both historical packages. Native-host and hosted/current-authority
   recovery remain separate gates.

No deployment, push, provider/DNS change, live migration, payment, paid model,
automation or existing-preview restart. Broad goal active/incomplete.
