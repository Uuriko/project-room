# Secret flow S5: ROOM_OPS_POST_TOKEN / ROOM_OPS_ROOM_ID / ANALYTICS_INGEST_TOKEN
_head 6efe5fdbe_

## Injection lines (workflows)
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/answer-engine-check.yml:36:          ROOM_OPS_POST_TOKEN: ${{ secrets.ROOM_OPS_POST_TOKEN }}
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/answer-engine-check.yml:37:          ROOM_OPS_ROOM_ID: ${{ secrets.ROOM_OPS_ROOM_ID }}
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/answer-engine-check.yml:38:          ANALYTICS_INGEST_TOKEN: ${{ secrets.ANALYTICS_INGEST_TOKEN }}
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/listing-check.yml:25:          ROOM_OPS_POST_TOKEN: ${{ secrets.ROOM_OPS_POST_TOKEN }}
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/onboarding-probe.yml:53:          ROOM_OPS_POST_TOKEN: ${{ secrets.ROOM_OPS_POST_TOKEN }}
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/onboarding-probe.yml:54:          ROOM_OPS_ROOM_ID: ${{ secrets.ROOM_OPS_ROOM_ID }}
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/snippet-adoption.yml:35:          ROOM_OPS_POST_TOKEN: ${{ secrets.ROOM_OPS_POST_TOKEN }}
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/snippet-adoption.yml:36:          ROOM_OPS_ROOM_ID: ${{ secrets.ROOM_OPS_ROOM_ID }}
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/snippet-adoption.yml:37:          ANALYTICS_INGEST_TOKEN: ${{ secrets.ANALYTICS_INGEST_TOKEN }}

## Do these reach artifacts or PR comments? (artifact paths in those workflows)
== listing-check.yml artifacts:
  32-          name: listing-check
== snippet-adoption.yml artifacts:
  42-          name: adoption-${{ steps.day.outputs.day }}
== answer-engine-check.yml artifacts:
  43-          name: answer-engine-${{ steps.day.outputs.day }}

## Script sinks (do scripts print token values?)
  /home/hatch/workspace/pr-wave1000-guild-17/scripts/listing-check.mjs:291:    token: process.env.ROOM_OPS_POST_TOKEN ?? "",
  /home/hatch/workspace/pr-wave1000-guild-17/scripts/snippet-adoption.mjs:454:  const secrets = [env.ADOPTION_SEARCH_TOKEN, env.GITHUB_TOKEN, env.ROOM_OPS_POST_TOKEN, env.ANALYTICS_INGEST_TOKEN]
  /home/hatch/workspace/pr-wave1000-guild-17/scripts/snippet-adoption.mjs:512:    credential: String(env.ROOM_OPS_POST_TOKEN ?? "").trim(),
  /home/hatch/workspace/pr-wave1000-guild-17/scripts/snippet-adoption.mjs:522:    credential: String(env.ANALYTICS_INGEST_TOKEN ?? "").trim(),
  /home/hatch/workspace/pr-wave1000-guild-17/scripts/answer-engine-check.mjs:319:  secrets.push(String(env.ROOM_OPS_POST_TOKEN ?? "").trim(), String(env.ANALYTICS_INGEST_TOKEN ?? "").trim());
  /home/hatch/workspace/pr-wave1000-guild-17/scripts/answer-engine-check.mjs:377:    credential: String(env.ROOM_OPS_POST_TOKEN ?? "").trim(),
  /home/hatch/workspace/pr-wave1000-guild-17/scripts/answer-engine-check.mjs:388:    credential: String(env.ANALYTICS_INGEST_TOKEN ?? "").trim(),
