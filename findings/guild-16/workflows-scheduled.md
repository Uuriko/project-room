# Scheduled probe workflows

Generated 2026-10-09T11:16:33.029Z.

| workflow | schedule | purpose |
|---|---|---|
| answer-engine-check.yml | `0 15 * * 1` | Mondays 15:00 UTC. Asks ChatGPT, Claude, Perplexity, and Grok the prompts in docs/answer-engine-prompts.json. A missing OPENAI_API_KEY, ANTH |
| deploy-drift.yml | `23 * * * *` | Reports when production's public /api/version lags main. Public endpoints only: no tokens, no deploy. A red run is the report. This is not a |
| listing-check.yml | `0 14 * * 1` | Weekly read of the directories in docs/listings.json. Separate from the deploy and drift workflows. |
| live-smoke.yml | `17 */6 * * *` | Production smoke for room.trydemigod.com: deploy lag vs main, discovery integrity, public pages, and a browser pass (page errors, CSP, 390 p |
| onboarding-probe.yml | `0 15 * * 1` | (no header) |
| room-github-door.yml | `*/10 * * * *` | GitHub door (docs/GITHUB-DOOR.md): comments on the door issue go into one room; new room messages come back as one digest comment. Does noth |
| snippet-adoption.yml | `0 13 * * 1` | Mondays 13:00 UTC. Counts public repos that carry the coordination marker. ADOPTION_SEARCH_TOKEN, when set, is a fine-grained PAT for public |

## Detail

### answer-engine-check.yml

- jobs: check
- key steps: `echo "day=$(date -u +%F)" >> "$GITHUB_OUTPUT"`; `node scripts/answer-engine-check.mjs --date "${{ steps.day.outputs.day }}" --out`
- notes: Mondays 15:00 UTC. Asks ChatGPT, Claude, Perplexity, and Grok the prompts in docs/answer-engine-prompts.json. A missing OPENAI_API_KEY, ANTH

### deploy-drift.yml

- jobs: drift
- key steps: `git fetch origin main`; `set +e`
- notes: Reports when production's public /api/version lags main. Public endpoints only: no tokens, no deploy. A red run is the report. This is not a

### listing-check.yml

- jobs: listing-check
- key steps: `node scripts/listing-check.mjs --out listing-check.json`
- notes: Weekly read of the directories in docs/listings.json. Separate from the deploy and drift workflows.

### live-smoke.yml

- jobs: smoke
- key steps: `npm ci`; `npx playwright install --with-deps chromium`; `npm i --no-save @axe-core/playwright@4.13.0`; `node scripts/live-smoke.mjs --browser`
- notes: Production smoke for room.trydemigod.com: deploy lag vs main, discovery integrity, public pages, and a browser pass (page errors, CSP, 390 p

### onboarding-probe.yml

- jobs: probe, publish
- key steps: `npm ci`; `npx playwright install --with-deps chromium`; `set -euo pipefail`; `node scripts/onboarding-probe/run.mjs --target "${{ steps.target.outputs.origin `…

### room-github-door.yml

- jobs: inbound, outbound
- key steps: `node scripts/github-door.mjs in`; `node scripts/github-door.mjs out`
- notes: GitHub door (docs/GITHUB-DOOR.md): comments on the door issue go into one room; new room messages come back as one digest comment. Does noth

### snippet-adoption.yml

- jobs: track
- key steps: `echo "day=$(date -u +%F)" >> "$GITHUB_OUTPUT"`; `node scripts/snippet-adoption.mjs --date "${{ steps.day.outputs.day }}" --out "a`
- notes: Mondays 13:00 UTC. Counts public repos that carry the coordination marker. ADOPTION_SEARCH_TOKEN, when set, is a fine-grained PAT for public

## Gotchas

- Schedule minutes are deliberately staggered (fuzz f15 maps overlaps) — when adding a scheduled workflow, pick a minute no heavy workflow uses.
- onboarding-probe publishes to docs/ (gap G12) and has a pre-deploy gate in deploy-prod, off by default (ACT-5b) — the probe and the gate are separate knobs.
- live-smoke hits the LIVE room; answer-engine-check and listing-check hit public pages. None of them write to production state.
