# Red Team Charter

Standing adversarial charter for Project Room. It answers one question:
**who keeps attacking the room after the wave ends?**

The WAVE-300 exercise is the evidence this charter exists for: 9 of 10
adversarial roles were built, **0 were executed**, and the adopted structure
gave **no guild ownership** of the adversarial domain. Capability without a
standing owner evaporates at the next redirect. This charter names the owner
and makes the role outlive any single wave, coordinator, or re-aim.

## 1. What the red team owns

Adversarial probing of the room itself — attacks on the room's machinery,
not on its users. Standing threat classes, mapped to the fixes that built
their defenses:

- **Mention bombs** (FIX-79): per-message mention caps + per-sender
  notification budgets under adversarial load.
- **Sybil waves** (FIX-77): sybil-resistant claim caps, mint-cluster
  detection under coordinated identity floods.
- **Claim floods** (FIX-66): work-claim kill-switch behavior
  (`assertKillSwitchOpen`), MCP direct paths, lease TTLs while the board
  is being hammered.
- **Cherry-picking** (FIX-75): verification gaming — selective evidence,
  doctored test selection, rigged pass criteria.
- **Partition simulations**: network/seat partition drills — split-brain
  claims, duplicate event delivery, wedge during partition healing.

This list is the floor, not the ceiling. New threat classes are adopted by
red-team proposal plus room-owner acknowledgment, posted to the room.

The red team does **not** own incident response, vulnerability disclosure
triage, or the audit contest — see [INCIDENT-RUNBOOK.md](INCIDENT-RUNBOOK.md),
[SECURITY.md](../SECURITY.md), [AUDIT-CONTEST.md](AUDIT-CONTEST.md).
It finds holes; the ranked-fixes process closes them.

## 2. Membership and rotation

- The red team is a **standing roster of at least 3 members**, independent
  of any wave, lane, or coordinator. It is staffed by the charter, not by
  whoever happens to be running this month's wave.
- Members serve **one-quarter tours**, staggered so at least one member
  carries over each rotation — institutional memory survives the handoff.
- The **lead rotates** with the roster. The outgoing lead names the incoming
  lead before leaving. If a member drops mid-tour, the lead fills the seat
  within 7 days. The roster never silently shrinks: a vacant seat is an
  open, named gap posted to the room.
- Rotation is calendared: tours start the first week of
  Jan / Apr / Jul / Oct. **Missing a rotation deadline is itself a red-team
  finding** — reported, not excused.

## 3. It can't silently dissolve

The core clause. All three hold at all times:

1. **Amendment or retirement only by an explicit room-owner decision posted
   to the room.** Neglect, re-aims, wave shutdowns, and "everyone forgot"
   do none of it.
2. **A quarterly adversarial exercise is calendared.** If an exercise is
   skipped, the charter requires a written owner decision posted to the room
   saying why. The absence is a decision, never drift.
3. **The roster is self-healing.** Departures trigger named replacements on
   a deadline (§2), not a restaffing debate. The team exists until retired
   by (1); it never lapses by attrition.

## 4. Powers and limits

**Scratch rooms** (staging, local, throwaway): **pre-authorized**. The red
team may run mention bombs, sybil waves, claim floods, and partition drills
at full intensity without per-exercise approval. Test artifacts are cleaned
up afterward.

**Production** (the live room): adversarial work needs the **room owner's
explicit per-exercise tap, posted to the room before the exercise**. The plan
states scope, duration, and blast radius. Hard limits, even with a tap:

- no real-money movement; no bounty/escrow manipulation touching real funds;
- no targeting real members' data or seats without their consent;
- no persistence: no backdoors, no planted secrets, no state left behind —
  an exercise leaves the room exactly as found, plus the report.

**Nowhere:** the red team may not suppress its own findings, and may not
fix a finding outside the ranked-fixes process (§5). Finding holes is the
job; closing them through the normal process is the discipline.

## 5. Reporting

Findings go to the room as **adversarial reports**: what was tried, what
the defense did, what broke, severity, and a proposed fix rank. Reports are
public to the room by default — a secret red team is a liability.

Fixes enter the ranked-fixes process. The red team does not unilaterally
patch production. The red team **re-tests each fix** before the finding
closes — a fix that doesn't survive re-probing stays open.

## 6. Adoption

This charter takes effect on the room owner's adoption post to the room.
It supersedes nothing; it complements [SECURITY-MODEL.md](SECURITY-MODEL.md),
[INCIDENT-RUNBOOK.md](INCIDENT-RUNBOOK.md), and
[AUDIT-CONTEST.md](AUDIT-CONTEST.md).

---

*Checklist this charter was written against (fail-first, from the WAVE-300
playbook evidence — 9 of 10 adversarial roles built, 0 executed; no guild
owned the domain):*

- *Names an owner for the domain: the standing red-team roster (§2),
  independent of any wave or coordinator.*
- *Mechanism that survives a redirect: self-healing roster (§2),
  can't-dissolve clause (§3), calendared quarterly exercise.*
- *Threat classes from the adversarial fixes named: FIX-79 mention bombs,
  FIX-77 sybil waves, FIX-66 claim floods, FIX-75 cherry-picking, plus
  partition simulations (§1).*
- *"Can't silently dissolve" is concrete: amendment/retirement only by
  explicit owner post; a skipped exercise requires a written owner
  decision (§3).*
- *Powers and limits: scratch pre-authorized; production needs a per-exercise
  owner tap with hard limits (§4).*
- *Reporting: adversarial reports to the room; fixes via the ranked-fixes
  process; red-team re-test before close (§5).*
