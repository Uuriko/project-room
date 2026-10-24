# Agent offer workflow checkpoint

The product goal remains active. This local slice extends the selected-work
read foundation at `fc3cff1`; it is not a deployment or completion of the product.

## Working now

- MCP and CLI can request offer context separately from source-message content.
  Help discovery points to the negotiated read and explicitly distinguishes an
  invitation from queue eligibility.
- Five thin MCP/direct-client actions: offer, select, decline, withdraw, release.
  They share the existing service command contract and exact receipt checks.
- Selection does not change the accountable member, task lifecycle/revision,
  execution permissions, read markers or payment authority.
- New direct-client `helpAction` preserves identity preflight and never performs
  implicit task reads, rebase, retry or takeover.
- Older services return a specific unsupported-offer-context diagnostic.
- Offline runtime packaging includes the new module and verifies it cold.

## Verification

Final working-tree syntax and core regression: **680/680 passed**. This includes
five new help-action tests, negotiated MCP read validation, cancellation recovery,
CLI flag combinations and a real subprocess/HTTP multi-client test.

The multi-client test connects two separately credentialed helpers plus the
accountable agent, with a second coordinator process racing selection. Both
helpers can offer, exactly one selection succeeds, and the losing proposal
remains an alternative. A restarted helper recovers the original offer receipt;
changed input under that ID is rejected. Ending consent leaves the selection
needing review, until an authorized explicit release. A renewed invitation
allows a new deliberate offer, followed by withdrawal. Cross-helper withdrawal
and unauthorized selection are refused.

These actors are scripts, not independently reasoning AI models. No native vendor
application or autonomous-agent acceptance is claimed. Existing tests exercise
independent database writers; the new MCP race is concurrent HTTP requests.
No browser UI was changed or fresh screenshot generated in this slice.

Evidence directory: `/tmp/project-room-agent-offers.Qgz2mB`.
Final passing full-suite log: `core-verified.log`.
Targeted package/action/transport checks: `targeted.log`, **19/19 passed**.
Earlier `core.log` and `core-final.log` preserve failures before correcting the
package allowlist/candidate fixture and the new direct-client test's synthetic
credential. Do not present those earlier logs as passing.

The read/action guide is [AGENT-HELP-OFFERS.md](AGENT-HELP-OFFERS.md). Default MCP
has 29 tools; the existing explicit local-attention option adds two. No new public
endpoint, schema migration, dependency, provider access or background process.

Post-commit verification at `b3efc2e` found one additional stale historical test
assertion: the new exact package correctly exposed 29 tools while its cold-import
test expected 24. The assertion now distinguishes packages with and without the
help-action module; no runtime behavior changed. Preserve
`committed-b3efc2e.log` as that failed attempt, not a passing verification.

## Next: make this equally usable for people

Add one compact contextual offer entry inside the existing help disclosure, not
another dashboard. Show the invitation scope, a short plan field, pending
alternatives and a selected helper only when relevant. Keep expired/review-needed
selections visible even when the invitation is hidden. Preserve drafts, focus,
scroll and exact retry input across live updates. Preview changed scope before a
new deliberate action. Use the same service gates and recorded outcomes as agents.

Qualify browser contract negotiation before rendering controls; missing offer
support is not an empty queue. Test human/agent interaction, desktop/mobile,
expired consent, competing selections and lost responses, then inspect screenshots.
Assignment, dispatch and review remain explicit subsequent operations.

No remote push, deployment, payment, provider connection or outbound user message
occurred. The browser and live site remain on their prior versions.
