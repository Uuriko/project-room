# Find, reuse, contribute, review

## Decision and plan

Qualify the complete human–agent loop, not merely each isolated feature. Reuse
should start fresh work from useful content; it must not inherit previous success,
assignment, permissions or approval. Keep the existing search, Use again form,
agent work list, result and decision surfaces rather than introducing a dashboard.

1. Seed a synthetic completed outcome, with a recorded independent check and a
   pending human decision. Discover it through actual desktop/touch browser search.
2. Open its original record and Use again. Verify only title/done criteria carry
   over, people remain unselected, read mode and fresh review requirements remain.
   Submit an edited new assignment deliberately; preserve the source unchanged.
3. Use separate scripted producer/reviewer MCP processes. Search needs-me, follow
   exact selected-read pointers and read the current Room brief before actions.
   A reviewer cannot accept the producer's work merely because it is searchable.
4. Submit exact room-native draft evidence. Change the result while the reviewer
   holds old context. Refuse stale-revision review, preserve an explicitly chosen
   historical finding without approving the replacement, then review the current
   exact version separately. No silent substitution of new evidence.
5. Open the simulated human decision UI: show the current result and corresponding
   check, with no decision preselected. Check desktop/touch layout, screenshot it,
   and verify sign-out clears private context. All reads preserve the20-table audit;
   all human read markers remain untouched.
6. Investigate any demonstrated failures, rerun affected checks, retain evidence
   and update the handoff. Do not expand scope simply to produce a runtime change.

## Research

[Linear issue templates](https://linear.app/docs/issue-templates) illustrate a
reusable starting point within ordinary issue creation. Our design deliberately
copies fewer fields: title and done criteria, not an old assignee, status or review.
[Notion duplication](https://www.notion.com/help/duplicate-public-pages) provides
another explicit reuse entry point. Neither reference proves this product's
retention or supports automatic permission inheritance. No source code copied.

This is simulated human use and scripted protocol integration, not a human study
or native-model acceptance test. No models, payments, external work or deployment.
Candidate schema12 and fallback4d22189 remain the applicable baseline; the broad
goal's historical schema8 references are not a reason to downgrade it.

## Findings and evidence

Both desktop and touch journeys pass. Search-to-reuse carries over exactly the
definition and asks for new participants. A separate agent finds that assignment
through bounded search, reads the changed brief and submits a new result. The
wrong assignee and stale review get service-level `command_rejected`, not merely
a malformed-protocol error. Explicit historical verification remains separate;
only a new check of the replacement appears on its human decision form.

The brief update deliberately leaves the task revision unchanged. This is not a
new bug: a task revision is not a brief freshness fence. The integration guide now
calls out the need to read current context. The test's script makes that choice;
it cannot prove an independent AI will follow it.

Screenshot inspection confirms the default review summary stays collapsed and
mobile controls remain reachable, including200% root text sizing. Full evidence
details can be opened without selecting an approval. Search and review text clear
on sign-out. No product defect was demonstrated, so no runtime change was made.

The new script is imported by the existing work-search browser suite, so the
ordinary `test:browser` command includes these two regression journeys. Direct
execution remains `node --test scripts/discovery-contribution-browser-check.mjs`.
Synthetic screenshots and JSON are written under `test-results/` with prefix
`discovery-contribution-{desktop,touch}`. Each read audits all20 application tables;
owner, producer and reviewer read markers remain0. This is not a retention study.

All65 runtime files match retained candidate-cefc89b, including all19 public
assets. Candidate and fallback packages are unchanged; prior13 Workers and2
exact-commit fallback results are retained, not reported as freshly rerun here.

Final checks:562 core/API/package tests and176 browser checks pass, including the
two new integrated journeys. Four final screenshots were inspected and retained,
with both synthetic JSON records, in
`../project-room-runtime-packages-20260908/evidence-discovery-contribution/`.
No runtime package was rebuilt because every packaged byte remains unchanged.
No push, deployment, native model or existing preview restart occurred.

## Now / next / later

Now: preserve repeatable whole-journey evidence for the existing collaboration loop.
Next: profile the remaining agent discovery/read cost with realistic synthetic
room sizes, then decide whether a bounded server-side read is warranted. Current
search limits output, not the full snapshot transfer; avoid adding another index
or endpoint without measurements and a clear compatibility/authority contract.
Later: native-host acceptance after usage approval, hosted recovery with independent
current-authority evidence, and measured real-user activation/return studies.
