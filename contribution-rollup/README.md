# contribution-rollup

Phase 0.5 derived Contributors read-model. Visible share weights only. No payout.

- `contributorsForReturnBrief(events, { since, workItemId })` — Quiet Focus / return-brief export
- `attachContributorsToReturnBrief(brief, source, { cursor })` — sibling field on a Phase 0 payload
- `renderContributorsSection(brief)` — thin list; each line opens the source Event / Artifact

Exact Phase 0 insertion points: [RETURN-BRIEF-HOOK.md](./RETURN-BRIEF-HOOK.md). Stub UI: [preview/index.html](./preview/index.html).

Does not merge [PR #8](https://github.com/Uuriko/project-room/pull/8) or [PR #9](https://github.com/Uuriko/project-room/pull/9). Does not touch identity D235, Arcade, Multichain, or the getdasha Worker.
