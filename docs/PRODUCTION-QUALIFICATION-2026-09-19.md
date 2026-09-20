# Production qualification — September 19, 2026

John authorized two additional passes and production deployment unless a strong blocker was found. **Production is held: rollback to the currently live release loses an uncertain-send retry.** No live deployment, database mutation, traffic change or external message was performed.

## Candidate and live state

- Candidate source: `eec5578084b25a9cadb7a5cd5e0ea191ff060d22`, runtime `4a2490b`, branch `codex/fable-handoff-review-20260919`.
- Actual live receipt: `7db8896a9d18523e48bb7e659c2d1feb16131f27`, built `2026-09-19T03:47:54.404Z`.
- Current provider version: `7a2a4cf2-638e-4cfe-8867-5ef4631d945b`, 100% traffic, worker `project-room-staging`.
- The worker name is historical: it serves the live application, including the getdasha.com room routes. No unrelated Worker or domain is part of this release.
- The `production` Git branch is stale and does not name the live code. Live `7db8896` is an ancestor of the candidate. All 37 public assets served by the live worker matched that commit byte-for-byte. Health/readiness were good.
- Schema remains 35. There are additive tables and new runtime behavior since live; unchanged schema number alone does not prove rollback safety.

## Pass 1 — hosted runtime and packaging

- Full local Workers/workerd gate: **31 passed, zero failed**, including authenticated browser, restart, storage, upgrade and historical recovery cases.
- Wrangler deployment dry-run passed. It built the allowlisted 38 current application assets and the worker bundle without deploying.
- Existing duplicate `slaAssessment` build warning also exists in live `7db8896`; it was not introduced by this candidate and was not silently treated as a new fix.
- Current provider bindings, origin, migration tag and active version were inspected read-only. No credentials were printed or copied into the repository.

## Pass 2 — critical journeys and actual-live rollback

- Overview, account workspace, private Inbox conversations, reconnect, reading/selection, session isolation and work lifecycle: **34 passed, zero failed** on desktop/narrow viewports.
- Exact candidate → live-revision → candidate package switch: **0 passed, 2 failed**, both desktop and touch.
- Reproduction: a reply request is committed but its response is lost; the candidate retains the original command and locks editing for exact retry. After passing through the current live version and returning to the candidate, the original command is absent from draft storage, the composer is empty and editable, and request mode remains open. The store still contains the already-recorded message. The test stopped before any duplicate send; duplicate-send risk is an inference from losing the identity required for exact retry, not a claimed observed duplicate.
- A focused diagnostic repeat confirmed the same storage loss in both viewports. No acceptance assertion was weakened.

The previous green fallback checks used `299ac45` and `82cd33e`, which are newer local checkpoints, not the code live today. They do not qualify rollback to provider version `7a2a4cf2-638e-4cfe-8867-5ef4631d945b`.

## Release decision and next action

Source is published to the candidate branch for review/CI. Hold merge-to-release and live traffic promotion until there is a qualified rollback path. Main's existing branch protections remain intact.

The smallest next investigation is draft-recovery compatibility across the exact live boundary. Either produce a compatibility repair that preserves the unknown command through the old reader/writer, including sign-out cleanup, or prepare and retain an independently qualified compatible fallback Worker version before promotion. Do not label an unuploaded local commit as an available provider rollback target. Re-run the exact package switch and corresponding workerd switch/privacy checks before deploying; keep all draft/command/read-only/sign-out assertions.

Earlier full local qualification remains valid for the candidate: **399/399 browser checks, 4,577 core passes / zero failures / one existing TODO**, repository checks and lint (zero errors, 79 existing warnings). It is development evidence, not proof that this live upgrade/rollback is safe.

Local logs are under ignored `test-results/production-qualification/`. Generated version stamping from the dry-run was restored to the committed template before publishing.
