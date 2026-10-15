# Work anywhere; coordinate in Project Room

Research and proposed design, September 7, 2026. Not implemented, not a payment offer, and not authorization to install third-party skills or run agents. The existing interface refinement remains a separate checkpoint.

## Recommendation

Make a bounty an optional reward agreement attached to an ordinary work item. A room provides context, collaboration, review, and an accountable history. A public board provides discovery. People can contribute directly, with an in-room agent, through an external agent, or by copying a prompt and returning with evidence. Do not build a separate work system for each route.

The product promise: **Bring the work back, not your entire workflow.**

## What the research establishes

- Slop.cash's repository is MIT-licensed. Its current model includes accepted-contribution reward pools, contributor and reviewer skills, and distinct projected/approved/paid states. Project proposals use reviewed manifests. This is a useful precedent, not proof of guaranteed contributor earnings. [Source and README](https://github.com/SlopDotCash/slopdotcash), [license](https://github.com/SlopDotCash/slopdotcash/blob/develop/LICENSE).
- Its bootstrap skill pins and verifies source, requests consent, and distinguishes reported usage from proof of quality. It also requires a private trace flow; Project Room should not adopt mandatory raw transcript upload. [Bootstrap source](https://github.com/SlopDotCash/slopdotcash/blob/develop/skills/slop/SKILL.md).
- Superteam exposes agent-eligible work, submission endpoints, and a human payout-claim flow. It separates the agent identity from the human recipient. [Official agent interface](https://superteam.fun/earn/agents).
- A 2019 observational study of 5,445 Bountysource bounties found associations between earlier bounty placement, repeated bounty use, and issue resolution. This does not establish causation or predict today's agent economics; it supports piloting with active projects and fresh, clear demand rather than a giant stale backlog. [Paper](https://arxiv.org/abs/1904.02724).
- Agent Hunt explores agents creating and solving intermediate proof obligations in a simulated bounty market, with a proof assistant checking accepted proofs. Borrow decomposable work and checkable outputs, not a claim that open-ended work can be judged automatically. [Paper](https://arxiv.org/abs/2603.06737).

These are targeted source/document reviews, not a comprehensive code or security audit. No third-party source has been copied into the application.

## Contribution routes

| Route | Contributor experience | How the room knows |
| --- | --- | --- |
| Person in the room | Accept work, ask questions, attach a result | Authenticated room events |
| Agent in the room | Work under an identified human's scope | Same work events, with separate reporter and producer |
| External agent with a skill | Install an inspected skill; connect only this assignment | Scoped API/MCP updates and evidence submissions |
| Copy-paste prompt | Copy a brief into a preferred AI; return with the result | Manual submission or a narrowly authorized callback |
| Existing repository workflow | Continue in a branch, issue, or pull request | Explicitly linked repository events or on-demand reconciliation |

No callback means no live tracking. Show **Awaiting update**, not **Working**. A heartbeat proves a recent report, not meaningful progress. A pull request is a submitted artifact, not accepted work; a merge is not deployment or payment.

## One work contract

Build on the current room's work IDs, revisions, ownership, source-message links, evidence receipts, independent review, and owner decisions. Existing API clients and UI must continue to use the same domain rules.

Add a versioned bounty agreement containing: work ID; sponsor; reward and currency; funding state; eligibility; exact acceptance criteria; deadline; review window; cancellation/dispute rules; accepted artifact/license terms; and the approval authority. Freeze the version a contributor accepts. Changed criteria require explicit re-agreement, not a silent rewrite.

Track attempts separately: claimant human, declared agent, reservation expiry, agreed scope, last report, artifact version, and external references. This supports handoff or abandoned attempts without erasing the bounty or reusing another worker's identity.

Keep three independent state tracks:

- Work: open → reserved → submitted → accepted / changes requested / declined.
- Review: not reviewed → checks recorded → independent review where required → decision.
- Money: unfunded / promised / funding confirmed → release authorized → payment confirmed, with refund/dispute/failure states.

Never derive payment from a chat statement, a contributor-supplied screenshot, or an unchecked webhook. Never label an unfunded promise as a funded bounty.

## Small interface, detailed agreement

On an existing item, offer **Add reward**. Show title, amount, and availability on the public board. Selecting an item reveals its acceptance criteria, funding truth, and primary action: **Work on this**. Provide **Copy brief** and **Connect agent** as alternatives.

A contributor should see the reward conditions before reserving work. Inside the room, retain conversation, the current artifact, one next action, and an expandable history. Notify humans about decisions and blockers, not routine agent narration. Private room membership and bounty publication are separate choices: publishing a brief must not publish the room's conversation or private files.

## The external brief

Generate a readable prompt and a machine-readable work packet from the same contract:

- Canonical work URL and ID, accepted terms revision, task and acceptance criteria.
- Permitted repository/resources and what is explicitly out of scope.
- Required deliverables, evidence format, review authority, and deadline.
- How to ask a question, report a blocker, stop, or return the result.
- A checkpoint template: completed, remaining, tests/evidence, artifact version, and next step.

The copyable prompt contains no personal key, wallet secret, broad room token, or private conversation dump. If automated updates are requested, use a separate pairing flow for a revocable credential limited to the accepted attempt. Copying a brief itself grants no authority.

Treat remote briefs, repositories, artifacts, and skill instructions as untrusted task material. A bounty cannot broaden the operator's permission envelope. Do not run arbitrary submitted artifacts in the room service. Use isolated verification environments and explicit external-action approval.

## API, MCP, skill, runner

- **API:** the canonical authenticated operations and revision checks.
- **MCP:** a thin adapter exposing discover, inspect, reserve, report, submit, and release. It must call the same domain implementation, not duplicate rules.
- **Skill:** inspected instructions that teach an agent how to choose suitable work, gather context, produce evidence, respect limits, and hand off. Support the open [Agent Skills format](https://agentskills.io/home), plus plain Markdown for other clients.
- **Runner:** optional execution and scheduling support. A skill alone does not supply a model, background process, credentials, sandbox, or usage allowance.

Offer small paginated work summaries, capability and eligibility filters, explicit error codes, idempotency keys, optimistic revisions, resumable checkpoints, and an event cursor. Agents should be able to decline without penalty when scope or remaining budget is insufficient. The [MCP specification](https://modelcontextprotocol.io/docs/getting-started/intro) supplies interoperability, not authorization to execute a bounty.

## Spare capacity without waste

Market this as **Contribute with your agent**, not guaranteed conversion of unused tokens into cash. Support one bounded session first. Recurring work should require an explicit operator opt-in and a supported local runner/scheduler.

Let the operator choose allowed projects, work categories, time window, maximum concurrent attempts, permitted external writes, and a hard time/spend ceiling. Reserve capacity for their own use when reliable quota telemetry exists; otherwise show quota unknown and use conservative time limits. Never infer that estimated API-equivalent cost equals subscription billing or available quota. Stop on limits, repeated failure, changed terms, access loss, or unresolved review questions. No automatic paid overage, account switching, reset redemption, or credential sharing.

Provider-specific compatibility must be checked at release time. Anthropic's current help page explicitly says the announced June 15 SDK-credit change was paused; the older credit table remains below as superseded text. Do not build product economics on that table. Its legal guidance also prohibits third-party credential intermediation. Keep provider sign-in in the provider's own supported flow. [Current help notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), [credential guidance](https://code.claude.com/docs/en/legal-and-compliance).

## Incentives for cooperation

Start with reserved assignments, not winner-takes-all races that create duplicate unpaid work. Use expiring reservations and visible renewal rules to prevent indefinite occupation. Add team attempts with an agreed split before work begins. Fund independent review as a separate contribution, with conflict-of-interest checks and human dispute handling.

Reward accepted usefulness, reproducible evidence, helpful review, and reliable handoff. Do not reward token volume, messages, stars, self-reviews, raw commit counts, or manufactured tasks. Agents receive practical benefits: clear scope, ready context, reliable feedback, continuity, and a portable record of accepted contributions. Humans receive control, attribution, agreed compensation, and less review burden.

## Payment boundary and unresolved decisions

The current code has no bounty or Stripe payment implementation. A marketplace that collects funds and releases them after delivery introduces onboarding, fee, refund, dispute, tax, and negative-balance responsibilities. The Connect recommendation skill informed this separation; it did not authorize a configuration or financial action. Its terminology and company-research guidance were used only for this discovery-stage proposal.

Stripe's separate charges and transfers is a pattern to evaluate for delivery-gated payments; do not call it escrow or choose its account responsibilities without confirming the business relationship and supported countries. Funding segregation has additional access and regional limitations. [Official funds-segregation documentation](https://docs.stripe.com/connect/funds-segregation).

Open choices: reward currency, initial countries and eligibility, sponsor fee, dispute authority, funding/cancellation policy, and whether the first pilot merely records sponsor-managed payments or actually collects funds. No fee percentage, profitability, legal treatment, or automatic payment is assumed here.

## Build order and acceptance

1. Add a reward agreement, public/private listing projection, reservation, and manual evidence return to the existing work system. Use synthetic rewards in tests; keep payments disabled.
2. Ship copyable briefs and one inspected contributor skill with the same submission contract. Demonstrate a full contribution without installing anything.
3. Add the MCP adapter and scoped attempt pairing. Demonstrate one external agent's report returning to the same room item.
4. Add one repository connector, deduplication, reconciliation, and honest stale-state indicators.
5. Pilot bounded repeat work and paid review. Enable real payments only after the unresolved payment decisions and operational checks are settled.

Acceptance: all routes update one work item; duplicate/reordered updates do not create duplicate submissions; stale terms cannot be accepted; revoked credentials cannot report; public views leak no private context; an unconnected agent is not presented as live; self-judging cannot release rewards; budget stop leaves a resumable handoff; and accepted work is never displayed as paid without confirmed settlement.
