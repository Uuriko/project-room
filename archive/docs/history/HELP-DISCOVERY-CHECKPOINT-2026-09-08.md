# Help discovery checkpoint

Previous checkpoint: schema13 invitation storage and recovery were implemented.
This slice adds agent-facing discovery using existing work reads and MCP tools.
It is local only; the overall goal and complete help feature remain unfinished.

## Implemented

- Optional `room_list_work({focus:"help_wanted"})` and the equivalent client call
  list explicit current invitations a participant may offer to help with.
  No new tool, dashboard, background watcher, notification or automatic work.
- One committed work snapshot and one service timestamp determine scope, expiry,
  accountable consent and participant eligibility. Client-clock skew does not
  change invitation expiry. Work revisions and help revisions remain separate.
- The accountable worker and designated independent reviewer are not listed as
  helpers. Other current humans and agents can discover eligible invitations.
  Room capabilities do not bypass credential, sponsor, session or tool authority.
- Selected-work reads include optional versioned help context and the participant
  facts needed to check it. The client recomputes supplied help guidance and
  rejects malformed or inconsistent responses, without a weaker fallback read.
- No-query discovery includes all eligible records in the existing500-work bound.
  Query filtering happens after eligibility and before the existing25-hit limit.
  Counts and truncation guidance remain explicit. Search does not inspect help
  scope, message bodies, files or event history; selected reads supply full scope.
- Completing work closes discovery. Reopening work does not revive consent from
  before completion. Revoking/restoring accountable access requires reaffirmation.
  Expired and withdrawn invitations disappear; ordinary progress preserves them.

## Compatibility finding

Unconditionally adding fields to work snapshots would break the older client's
exact envelope validator. Metadata is therefore opt-in through
`X-Project-Room-Help-Context: 1` on the existing `?view=work` read. The service
rejects unsupported versions and inappropriate header/view combinations.
Unrequested responses preserve the old envelope; no schema bump is needed.

An actual frozen87a5423 client reads new-service ordinary search, focused work and
selected context. The new client reads an actual frozen87a5423 schema13 service:
ordinary reads work, but help discovery returns `help_context_unavailable`.
Its populated invitation remains intact. Missing metadata is not an empty success,
permission to act or a reason to retry with a weaker read. Historical schema12
fallback behavior is also tested on genuine old data, never downgraded13 data.

This is compatibility evidence, not full schema13 fallback qualification. The
existing historical8/12 Workers app-switch checks do not qualify a13 release.

## Qualification

- 627 core/API/package checks pass, including8 new discovery checks.
- 15 local Workers regressions pass; the added explicit HTTP negotiation
  assertions also pass in a focused rerun.
- Desktop/touch contribution journeys now read open invitations through real
  scripted MCP, read selected scope and observe withdrawal. Each read checks the
  all-table audit hash. Their existing simulated human draft/adoption/review
  journey remains separate from the not-yet-built invitation-bound offer flow.
- All184 browser checks pass (170 seconds). Two inspected screenshots show
  preserved composer text/focus; no new human invitation UI.

Frozen runtime2912aa911dc6a9290fe2995533bc0babb2f15f4f,
tree2b1cca6362b1ce1f0458fbb3945319b203179cc7, schema13,67files,20assets:
`../project-room-runtime-packages-20260908/help-discovery-2912aa9`.
Manifest SHA256:
`4c514860611e2d04726301ca544b490abceadd92e9287ebf5979438450f24f08`.
0e504a3 adds only Workers HTTP test assertions; runtime bytes are unchanged.
Four logs, two screenshots and two validated scripted-journey JSON records are
preserved in sibling `evidence-help-discovery`. Both records explicitly identify
simulated humans, actual scripted MCP, discovery tested and invitation UI absent.
All test processes finished; all67 current runtime files match the frozen package.

## Next

1. Bind offers to an exact active invitation and scope, with bounded outstanding
   offers, explicit responses and late-withdrawal handling. Preserve ordinary
   discussion and drafts without presenting them as invitation-bound authority.
2. Add short contextual human publish/withdraw controls with scope and expiry.
   Preserve exact unknown-save recovery, stale refresh, mobile and keyboard flow.
3. Test simultaneous helpers, changed scope, independent review, returning human
   choice and unwanted repeated offers before enabling automated offer tooling.
4. Qualify distinct schema13 fallback/recovery packages on populated data.
   Hosted/current-authority recovery and native-agent reasoning remain separate.

No deployment, live migration, push, paid models, provider actions, external task
execution or changes to the user's existing preview were performed.
