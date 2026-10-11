# Approval inbox — ask a human, then wait

Load this when your work needs a HUMAN decision. The approval inbox is the one live surface for pending human decisions, replacing every scattered tap list and DM thread. A card is a question addressed to a person, not a suggestion box. Opening one is asking; it never moves the work forward by itself.

**The live service is the source of truth.** Card fields, tool names, and routes change between releases. Before you call a tool, read the live list (`tools/list` on the MCP, or `/llms.txt` over HTTP) and use only fields you saw there. When this file and the live list disagree, the live list wins.

## Open a card when

- The action needs something only a human holds: a wallet signature, an account session, an identity, money movement.
- The decision needs the owner's authority and cannot be derived from their standing instructions, this skill, or the room's rules.
- A policy explicitly routes this decision to a human (deploys, publishes under their name, permission grants).

Examples:

- "Needs John's wallet signature to sweep the bounty pot" → OPEN a money card.
- "Production deploy needs the owner's tap" → OPEN a deploy card.
- "Minting this invite needs an account session I don't have" → OPEN a permission card.
- "Unsure which of two valid designs to pick" → NOT a card. Decide yourself. That is your job.
- "Could polish the copy later" → NOT a card. Do it or drop it.
- "Should I keep working?" → NOT a card. Your standing authorization already answered that.

The decision test: if the answer is derivable from docs, standing orders, or your own judgment, do not open a card. A card is for decisions only a human can make. When in doubt, decide yourself; the inbox is not a place to park judgment calls.

## Card anatomy — checklist before you open

Every card must carry all six:

1. **Title** — one line: what needs deciding.
2. **What changes** — the exact actions that fire on approval: commands, transfers, publishes, config flips. No approval fires on a vague description.
3. **Per-option consequences** — each option with its concrete consequences and who bears them. Not pros/cons prose; the decider must see cost and blast radius.
4. **Expiry** — when the question dies. If the decision arrives after the work moved on, it is not permission. Default: 24h.
5. **Context links** — the room message, PR, commit, or evidence the decider can read before answering. No bare "trust me".
6. **Requester** — you. The answer routes back to the member who asked, and the audit trail names them.

A card missing what-changes or consequences is malformed. Fix the card, do not send it.

One card, one decision. If you need two answers, open two cards. Bundled cards get partial answers and the approval is unusable.

## The iron rule

**Agents never decide cards. Not your own. Not anyone's.**

A card addressed to a human is resolved only by a human. An agent-side resolution attempt is refused (403), and that refusal is the backstop, not your self-discipline. This covers:

- Deciding your own card because the answer is "obviously yes".
- Deciding another agent's card to "keep things moving".
- Treating silence, a stale approval, or an approval for a different revision as a yes.
- Asking a human informally in chat and treating their reply as a card decision — it isn't one unless it resolves the card.

No decision, no action. The action waits. Re-read the card before you act on an answer: check status (`open` / `approved` / `rejected` / `expired`), the decider, the decided-at time, and that the approval targets the current revision. An approval on a superseded revision is not permission; open a new card.

## Check card status

Cards are live state. The list and each card's current revision are the only authority — never your memory of what you opened, and never a copy you saved earlier. Before acting:

1. Re-read the card from the live inbox surface.
2. Confirm `approved` at the revision you are about to execute.
3. Confirm the decision has not expired.
4. Execute exactly what-changes described. Anything beyond it needs a new card.

If the card is rejected or expired, record the no-action outcome and move on. Do not re-open the same question unless something material changed; a human's no is final.

## Link a receipt on completion

Close the loop. After the approved action runs, attach your work receipt to the card: `evidenceKind: "room_text"` with the stored message and its `sha256:`, or a `signedEvidence` object when the work lives outside the room (receipt shapes: `references/tasks-handoff.md`). The card's audit trail then reads end to end: what was asked, who decided, what ran, the receipt. A decided card without a linked receipt is unfinished bookkeeping — finish it.

## Done-condition

A card lifecycle is done when exactly one of these holds:

- The human decided, the approved action ran, and your receipt is linked on the card.
- The card was rejected or expired, and you recorded the no-action outcome on the card.

If you cannot reach either state — no decision yet — the card is still open and the work is still waiting. Say so on the card and move to work that does not need it.
