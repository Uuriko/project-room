# Secret flow S3: room-door secret (ROOM_DOOR_SECRET, ROOM_RECEIPT_TOKEN)
_head 6efe5fdbe_

## Workflows referencing it
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/deploy-prod.yml
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/merge-queue-eject-budget.yml
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/merge-queue-receipts.yml
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/rollback-prod.yml
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/room-github-door.yml
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/room-work-sync.yml

## Injection lines
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/deploy-prod.yml:28:# to muse-room when the ROOM_RECEIPT_TOKEN secret exists.
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/deploy-prod.yml:35:#   ROOM_RECEIPT_TOKEN           optional. Room bearer token used to post the receipt.
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/deploy-prod.yml:271:          ROOM_RECEIPT_TOKEN: ${{ secrets.ROOM_RECEIPT_TOKEN }}
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/deploy-prod.yml:282:          if [ -z "$ROOM_RECEIPT_TOKEN" ]; then echo "ROOM_RECEIPT_TOKEN not set; no receipt posted."; exit 0; fi
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/deploy-prod.yml:295:              headers: { authorization: `Bearer ${e.ROOM_RECEIPT_TOKEN}`, "content-type": "application/json", origin: e.PROD_ORIGIN,
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/merge-queue-eject-budget.yml:19:#      (ROOM_DOOR_SECRET, the same secret as room-github-door.yml) naming the
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/merge-queue-eject-budget.yml:63:          ROOM_DOOR_SECRET: ${{ secrets.ROOM_DOOR_SECRET }}
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/merge-queue-receipts.yml:13:# GitHub door (ROOM_DOOR_SECRET, the same secret as room-github-door.yml).
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/merge-queue-receipts.yml:39:          ROOM_DOOR_SECRET: ${{ secrets.ROOM_DOOR_SECRET }}
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/merge-queue-receipts.yml:56:          ROOM_DOOR_SECRET: ${{ secrets.ROOM_DOOR_SECRET }}
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/rollback-prod.yml:106:          ROOM_RECEIPT_TOKEN: ${{ secrets.ROOM_RECEIPT_TOKEN }}
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/rollback-prod.yml:113:          if [ -z "$ROOM_RECEIPT_TOKEN" ]; then echo "ROOM_RECEIPT_TOKEN not set; no receipt posted."; exit 0; fi
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/rollback-prod.yml:129:              headers: { authorization: `Bearer ${e.ROOM_RECEIPT_TOKEN}`, "content-type": "application/json", origin: e.PROD_ORIGIN,
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/room-github-door.yml:5:# the owner sets the ROOM_DOOR_SECRET repository secret and opens an issue
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/room-github-door.yml:37:          ROOM_DOOR_SECRET: ${{ secrets.ROOM_DOOR_SECRET }}
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/room-github-door.yml:55:          ROOM_DOOR_SECRET: ${{ secrets.ROOM_DOOR_SECRET }}
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/room-work-sync.yml:30:          ROOM_DOOR_SECRET: ${{ secrets.ROOM_DOOR_SECRET }}

## Scripts consuming it (leak surface: room posts)
  /home/hatch/workspace/pr-wave1000-guild-17/scripts/github-door.mjs
  /home/hatch/workspace/pr-wave1000-guild-17/scripts/merge-queue-receipt.mjs
