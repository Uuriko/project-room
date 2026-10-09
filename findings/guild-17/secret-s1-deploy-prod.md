# Secret flow S1: deploy-prod (CLOUDFLARE_API_TOKEN, ROOM_AGENT_CARD_SIGNING_KEY, ROOM_RECEIPT_TOKEN)
_head 6efe5fdbe_

## Injection points (workflow)
  184:      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
  185:      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
  189:          SIGNING_KEY: ${{ secrets.ROOM_AGENT_CARD_SIGNING_KEY }}
  225:          ROOM_AGENT_CARD_SIGNING_KEY: ${{ secrets.ROOM_AGENT_CARD_SIGNING_KEY }}
  236:          ROOM_AGENT_CARD_SIGNING_KEY: ${{ secrets.ROOM_AGENT_CARD_SIGNING_KEY }}
  271:          ROOM_RECEIPT_TOKEN: ${{ secrets.ROOM_RECEIPT_TOKEN }}

## Consumption in called scripts (wrangler + signing)

## Log-exposure pattern scan (echo/printf of token vars, ::add-mask missing)
## ::add-mask usage in deploy path
