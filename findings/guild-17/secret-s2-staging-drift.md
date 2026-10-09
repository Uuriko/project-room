# Secret flow S2: staging.yml + deploy-drift.yml secret usage
_head 6efe5fdbe_

## staging.yml secrets
  33:          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
  34:          SIGNING_KEY: ${{ secrets.ROOM_AGENT_CARD_SIGNING_KEY }}
  67:          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
  68:          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
  69:          ROOM_AGENT_CARD_SIGNING_KEY: ${{ secrets.ROOM_AGENT_CARD_SIGNING_KEY }}

## deploy-drift.yml secrets

## rollback-prod.yml secrets
  42:      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
  43:      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
  106:          ROOM_RECEIPT_TOKEN: ${{ secrets.ROOM_RECEIPT_TOKEN }}

## permissions lines
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/staging.yml:14:permissions:
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/staging.yml-15-  contents: read
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/staging.yml-16-
  --
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/deploy-drift.yml:20:permissions:
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/deploy-drift.yml-21-  contents: read
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/deploy-drift.yml-22-
  --
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/rollback-prod.yml:24:permissions:
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/rollback-prod.yml-25-  contents: read
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/rollback-prod.yml-26-
