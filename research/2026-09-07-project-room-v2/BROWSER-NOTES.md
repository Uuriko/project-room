# Product inspection evidence

7 September 2026. Read-only public exploration. Default in-app viewport approximately 319px wide; this is not a desktop/responsive breakpoint suite. No accounts, signup, applications, bounty claims, external tool runs, payments or service connections.

Stripe Directory skill was read for vendor discovery. The stripe CLI is absent and no Directory search connector was exposed. No directory query ran; official-site web search is the fallback. Searches included Paperclip agent orchestration/approval, Algora bounty claims, and Relay.app human-in-loop. Similar names were disambiguated.

## Paperclip

https://paperclip.ing/ : visually inspected entry. Actual CTA is waitlist or local installation. Expanded 'Can I use my existing agents?' FAQ; answer describes adapters/heartbeats. Screenshots paperclip-entry.png and paperclip-byo-expanded.png.

https://docs.paperclip.ing/guides/day-to-day/decisions/ : read illustrated decision queue documentation. Captured paperclip-decisions-docs.png. These are vendor sample UI images inside documentation, not a live managed company. No agent run, claim, approval or cancellation exercised.

## Algora

https://algora.io/highlight/bounties : actual public Open/Completed tab interaction. Open showed one $20 item, 28 months old, and 26 claims. Clicked Completed; first AX diff was unchanged, but subsequent DOM and screenshot confirmed active Completed and awarded-item list. Do not label the filter broken. Screenshots algora-open-board.png and algora-completed-board.png.

https://algora.io/claims/175fF8EcVwYqPvK7 : actual public detail. Long PR description precedes claim/payment panel in this narrow viewport. Navigated to Claim heading and captured algora-claim-status.png: $1,800 prize pool, $0 paid, Pending, February17 timestamps. These are displayed values, not audited provider balances or proof of unpaid breach. No PR/code execution or claim made.

## Linear

https://linear.app/agents : read public product presentation; opened Watch example, muted and played public 42-second video; sampled initial and ~19-second frame, not full video comprehension. Captured linear-agent-entry.png and linear-example-player.png. No workspace entered. https://linear.app/docs/assigning-issues : read and opened zoomable vendor assignment/delegation illustration; captured linear-delegation-sample.png. A picture of the assignment menu is not an assignment operation tested.

## Relay.app

https://relay.app/ : inspected actual shutdown announcement; expanded Can I export my data? FAQ; captured relay-shutdown.png and relay-export-faq.png. Current homepage says free access ended August15; paying access ends September14. Docs landing page reverses groups, so exact dates are source-conflicted. No login, export or migration performed. Treat as historical/winding-down reference, not a currently available new-user automation service.

## Gumloop

https://www.gumloop.com/templates/ai-hubspot-assistant-for-slack-simple-crm-chatbot : watched public sample replay, then expanded '2 steps'. Attempted 'Skip to end' after initial observation, but replay completed and button disappeared; next snapshot confirmed 'Watch again'. No execution or customer-data connection. Captured gumloop-replay.png and gumloop-steps-expanded.png. Sample explicitly starts with invented/demo data instruction and reports no actual lost deals before illustrative numbers. This is not analytical evidence; don't reuse sample numbers. On narrow viewport sample content scrolls within a bounded area above a persistent Use this Agent CTA.

https://www.gumloop.com/pricing : read current Pro/Enterprise table; expanded usage-limit FAQ. It says agents stop at included-credit exhaustion and PAYG is not enabled by default. Captured gumloop-pricing.png and gumloop-credit-limit-faq.png. No trial started or billable plan selected. The screenshot was captured during ordinary public-page use, not a zero-credit account test.

## Coverage and remaining limits

15 screenshots saved. Actual read-only public interaction across Paperclip, Algora, Linear, Relay.app and Gumloop. Only Algora exposed a live public work listing/status flow; Linear and Gumloop examples are demonstrations, and Paperclip decision UI is illustrated documentation. LaborX and n8n are documentation-only comparisons. LaborX linked terms prohibit automated use; no interaction/integration test performed. No claims about live execution, cancellation, current account-specific eligibility, processor balances, private dashboards, or end-to-end usability.
