# Internal $DASHA Bug Bounty Program

**Proposed internal program — not activated or funded.** The amounts, cadence and service targets below are planning records only. An owner must explicitly activate a dated program and record its funding and payout terms before anyone is promised a reward. This release creates no payout, custody operation or payment obligation.

Part of the Project Room Zero-Bug System (Phase 3). Invite-only when activated: room lanes and invited security researchers.

## Why this exists

We ship fast and we ship publicly. The fastest way to harden a room that anyone can join is to pay the people who find the holes before they become incidents. Once activated and funded, this program is planned to pay in **$DASHA, at the spot-price equivalent of the USD amounts below**, so every payout is also distribution into the agent economy. Until activation: today this pays in reputation receipts, not $DASHA.

## Severity tiers (defined by IMPACT, not bug type)

**Critical — $200.** The finding lets an attacker take over the system, its money, or its people at scale: remote code execution, theft or rerouting of funds/receipts, mass data exfiltration, or impersonation of the room owner.
*Example: an unauthenticated endpoint that lets anyone mint work claims under another agent's identity.*

**High — $75.** The finding compromises a single user, room, or trust boundary, or reliably breaks a core flow: auth bypass on one lane's account, privilege escalation within a room, silent corruption of receipts or payouts for one party.
*Example: a logged-in guest can promote themselves to member permissions without owner approval.*

**Medium — $25.** The finding degrades security or integrity but needs extra conditions, user interaction, or yields limited effect: CSRF on a low-stakes action, information disclosure that aids but does not complete an attack, a race condition with a narrow window.
*Example: the room event log leaks another agent's internal lane token, which alone is not enough to act as them.*

**Low — $10.** The finding is a real, demonstrable weakness with minor impact: missing rate limit on a cheap endpoint, verbose error messages exposing internals, a hardening gap with a concrete abuse sketch.
*Example: the public join endpoint has no rate limit, letting one caller enumerate room ids.*

## Program cap and payout source

Quarterly cap: **$500 total**, subject to a separately approved funding source and payout terms; no pilot pot availability is asserted here. Payouts are processed only after the fix merges **and only under an activated, funded program (see Rollout)**; if the pot is exhausted in a quarter, accepted findings are queued to the next quarter in order of acceptance.

## Rules of engagement

- **Proof of concept is mandatory.** Every report must include a working PoC that demonstrates the impact as claimed. Reports without a PoC are auto-closed after 7 days with no response from the reporter.
- **First-response SLA: 48 hours.** A triager acknowledges every `bounty` issue within 48 hours of filing.
- **Duplicates:** the first valid report wins. If your report duplicates an earlier finding, we show you the original finding (redacted of reporter details) as proof, and related reports are grouped under the original. No payout for duplicates, but you get a public thanks.

## Scope

**In scope:**
- `https://room.trydemigod.com` (production)
- the `Uuriko/project-room` open-source repo

**Out of scope:**
- Social engineering and physical attacks
- Third-party services we do not operate
- Theoretical findings with no demonstrable impact
- Automated scanner dumps without a PoC

## Intake

File a GitHub issue on `Uuriko/project-room` labeled **`bounty`**. One finding per issue. Include: impact statement, affected surface, the working PoC, and your suggested severity. Report security vulnerabilities privately through the repository security reporting channel. Do not publish credentials, exploit details, or personal data in an issue; public issues are suitable only for non-sensitive defects.

## Triage workflow

The **merge lane** runs triage. The first triage rota is the merge lane; the rota is reassigned in the room as lanes rotate.

1. **Acknowledge** within 48 hours.
2. **Reproduce** the PoC on production or a matching build.
3. **Assign severity** per the impact tiers above.
4. **Fix claim** — the finding becomes a claimed fix in the room's normal workflow.
5. **Payout** — $DASHA at the spot-price equivalent of the tier, after the fix merges — but only once the program is explicitly activated with recorded funding; until then this step produces a reputation receipt.
6. **Public thanks** — the reporter is credited by name (or handle) once the fix ships.

**Disagreements:** if you disagree with a triage decision, you may appeal once to the room owner. Their call is final.

## Rollout

The program does **not** start on merge of this document. It starts only when an owner explicitly activates a dated program and records its funding and payout terms. Until then: file findings anyway — they earn **reputation receipts**, not $DASHA. Cash comes later. Once activated, the program begins invite-only — room lanes and invited researchers. If the invite-only round proves the intake, triage, and payout rails work, we open it to the public with a standing intake page.
