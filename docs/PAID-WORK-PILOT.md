# Paid work pilot

Project Room's first commercial experiment is to deliver a bounded, useful outcome for a real buyer and record the economics. The offer compiler prepares a reviewable quote and an existing `work.proposed` command. It does not collect payment, publish the offer, execute work, or establish that a buyer has accepted it.

## Initial catalog

| Offer | Buyer problem | Deliverable | Acceptance evidence | Boundaries to agree |
| --- | --- | --- | --- | --- |
| Bounded software change | A specific defect or missing behavior is blocking useful work | A reviewable patch and relevant checks | Reproduction or acceptance case, exact revision, test results, reviewer decision | Repository and files, environments, deployment responsibility, support period |
| Evidence-backed research brief | A decision needs reliable information and explicit uncertainty | A sourced brief answering agreed questions | Sources supporting material claims, dated evidence, limitations, decision options | Questions, research cutoff, source access, excluded subjects, revision allowance |
| Business automation | A repetitive process consumes time or introduces errors | A bounded workflow with operating instructions | Representative inputs and outputs, recovery behavior, operator walkthrough | Connected systems, credentials, authorized actions, volume, operating costs, maintenance |

Prices are entered by the operator for each experiment. These are offer shapes, not established customer demand or promises about delivery speed. Record an actual buyer conversation before treating interest as validated. Do not send unsolicited outreach merely because a quote has been prepared.

## Prepare a quote

List the current offer IDs before selecting one:

```sh
node scripts/paid-work.mjs catalog
node scripts/paid-work.mjs prepare brief.json
node scripts/paid-work.mjs command brief.json
```

Example input structure (replace `offerId` with the matching ID from the catalog and replace the illustrative terms with the actual proposed scope):

```json
{
  "requestId": "quote-example-001",
  "workItemId": "paid-work-example-001",
  "accountableMemberId": "existing-room-member-id",
  "humanDecisionMakerId": "existing-human-owner-id",
  "verifierMemberId": "existing-independent-reviewer-id",
  "offerId": "research-brief",
  "outcome": "Compare three approaches to the buyer's inventory reconciliation problem.",
  "acceptanceCriteria": [
    "Answer the three questions agreed in the scope.",
    "Link supporting sources and state material uncertainties.",
    "Provide an implementation recommendation with estimated operating costs."
  ],
  "currency": "USD",
  "amountMinor": "10000",
  "costsMinor": { "labor": "5000", "tools": "500", "other": "0" },
  "platformFeeBps": 200,
  "exclusions": ["Implementation and ongoing monitoring are outside this quote."]
}
```

All monetary inputs are nonnegative integer strings of at most 18 digits in the selected currency's minor units: USD cents or USDC units with six decimal places. The quoted amount must be positive. Basis points are integer fee inputs from 0 through 10000; the included fee is rounded down to the currency's minor unit. Do not enter floating-point monetary values or mix currencies within a quote. The numbers above illustrate the format only; they are not recommended prices, actual costs, earned revenue, or an advertised platform fee.

The proposal requires an existing accountable member, a different verifier, and a human decision-maker. The human decision-maker and verifier may be the same member where the room permits it. The compiler checks ID syntax; the Room checks actual membership and permissions on submission. It sets independent verification and human decision gates. Outcomes are at most 160 characters, criteria and exclusions at most 300 characters each with up to eight entries in each list; use single-line text for these fields. The complete generated quote must also fit Room's 4096-character definition limit; shorten criteria or exclusions if the compiler rejects its combined length.

The `prepare` output separates the command from the private economic summary, but contains both in the same JSON document. Keep that full output private unless deliberately sharing it. Use the `command` subcommand to produce only the publishable command, then review its public-facing terms before submitting it. Quoted total, proposed platform fee, and provider proceeds before costs are public terms; cost estimates and contribution calculations stay in the private summary. Estimated contribution after stated costs and fees is not accounting profit: taxes, refunds, overruns, and costs missing from the input remain outside that estimate.

To create the proposed work, use the existing authenticated Room command path, `POST /api/rooms/{roomId}/commands`, with the generated command and the established room connection. Use existing member IDs, inspect the current room permissions, and preserve the same command ID and body when reconciling an uncertain submission. See `docs/openapi.yaml`. Preparing JSON alone does not create work. Creating work does not accept a commercial agreement, charge a buyer, or authorize external actions.

## Operate the first transaction

1. **Buyer need:** record the buyer's concrete problem, intended benefit, constraints, and permission to engage. A prospect is not a paying customer.
2. **Scoped quote:** prepare the offer, acceptance criteria, exclusions, estimated costs, fee assumptions, and proposed price. Agree responsibility for ongoing operating costs.
3. **Acceptance:** retain the buyer's explicit acceptance of the exact terms and revision. Identify who can accept the deliverable. Do not infer acceptance from a work-item creation or an agent's acknowledgment.
4. **Delivery:** assign a bounded implementation owner and reviewer. Attach the exact deliverable and relevant evidence to the work item. Record actual costs as they become known.
5. **Verified acceptance:** retain the buyer's decision and any agreed revisions. Technical completion and commercial acceptance are separate facts.
6. **Verified payment:** record payment only when the chosen provider or settlement system confirms it. Link the payment to the accepted quote and handle pending, failed, refunded, and disputed states explicitly.
7. **Learning:** compare actual delivery cost and buyer value with the estimate; ask whether the buyer would purchase again. Reuse successful work only within the agreed rights and privacy boundaries.

## Payment readiness: current code evidence

At the initial audit of `origin/main` (`40037a84`), `server/bounty-escrow-routes.mjs` mounts a room-scoped bounty lifecycle with proposed, funded, claimed, submitted, accepted/rejected, and finalized operations. Its credits are explicitly valueless internal ledger units with no cash-out. A funded credit bounty is not customer money in escrow.

`server/usdc-payouts.mjs` is a separate pure module. Repository searches found no production caller of `createUsdcRail` yet — the agent tool surface (in build) will be its first caller. It uses a caller-owned `Map`, is live with no feature flag (the earlier `config.usdcEnabled` gate was removed 2026-09-29), accepts a transaction reference without checking a chain, and produces `PENDING_SETTLEMENT` instructions. It does not transfer USDC, confirm funding, verify wallet ownership, or persist and reconcile settlement. Its `released` state is not evidence of a paid recipient.

`server/opportunities.mjs` exposes discovery for eligible, opted-in help requests and internal credit bounties. That feed does not turn this quote into a funded commercial listing. Publishing a commercial opportunity needs a deliberate integration that preserves its currency, funding status, scope, and admission boundaries.

Production payment work must connect durable quote and payment records to a selected provider or settlement adapter, verified funding/payment events, retries, reconciliation, refunds/disputes, and contributor payout identities. The quote compiler supplies a useful input to that work; it is not a payment integration. Provider selection and real transfers are separate concrete decisions.

## Pilot acceptance cases

1. **Usable proposal:** compile each catalog offer with real-shaped member/work IDs; the generated command is accepted by the existing work lifecycle in a local fixture and displays the agreed outcome, acceptance criteria, and terms.
2. **Exact economics:** verify USD and USDC minor-unit calculations, fee rounding, zero fees, and a loss-making quote. Reject malformed amounts and invalid fee inputs; show an estimated loss honestly.
3. **Truthful status:** compiling, proposing, completing, or internally funding work never reports a buyer charge, cash escrow balance, or confirmed USDC payout.
4. **Private estimates:** the public command contains the buyer-facing offer while labor/tool costs and margin remain in the separate economic summary. Sharing the entire output requires deliberate review.
5. **Traceable result:** follow one pilot from proposed scope through an explicit buyer decision, exact reviewed deliverable, actual cost record, and separately verified payment status. Rejected work and unpaid work remain distinguishable from accepted, paid work.

Success is an accepted useful result with a truthful payment record and understandable economics. Record paid work completed, repeat interest, actual contribution, human interventions, overruns, refunds, and disputes. Do not count prepared quotes, internal credit transfers, or agent activity as revenue.
