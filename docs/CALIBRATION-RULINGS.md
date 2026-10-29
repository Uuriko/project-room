# Calibration rulings — how reviewers and deciders draw the recurring lines

**Version 1 · Issued 2026-10-18 · Source: EXP-CS-1 noise audit (60 cases,
two independent blind re-judgments).**

Reviewers and dispute deciders run a versioned process, and verdicts vary
by process vintage far more than by judge: in the audit, two blind passes
over the same 60 case files agreed with each other on 100% of review
verdicts (κ = 1.00), while the original live verdicts diverged from both
passes on 13.3% of reviews — one-directionally (originals accepted 36.7%,
blind re-judgment 23.3%), every flip on a judgment-call line one vintage
read strictly and another read leniently. These rulings fix the reading.
They bind bounty reviewers, claim reviewers, and seated dispute deciders.

**Versioning.** Every change to this document bumps the version and
re-baselines the verdicts expected under it. Re-audit (the EXP-CS-1
packet machinery, ~2 lh) is triggered by a change to the rubric, the
review tooling, or the decider population — the measured variance
sources — not by the calendar.

## The rulings

### CR-1 — "Shows both values" means both values printed

A comparison line satisfies a rubric's both-values requirement only when
the submission prints the two values being compared (stated + computed).
A `MATCH` assertion, a check mark, or a lone stated value does not count,
however the row is labelled.

*Case: R-11 (receipt liveness + hash battery). The rubric required "every
hash comparison shows both values (stated + computed)"; the submission
listed the stated hashes and asserted MATCH for each. The live process
accepted; both blind passes rejected on this line.*

### CR-2 — A HOLDS verdict requires a live fetch, unless the rubric names the contract

A claim is marked HOLDS only with a corresponding live fetch in the
evidence. A documented contract (a spec, a published llms.txt, a docs
page) counts as evidence for HOLDS only where the rubric for that task
names the contract as an acceptable source. Where the rubric requires
live verification, the contract's say-so is not a fetch.

*Case: R-13 (llms.txt claim-by-claim verification). The rubric: "no claim
marked HOLDS without a corresponding live fetch in the evidence column."
One claim was marked HOLDS on the documented contract's say-so. The live
process accepted; both blind passes rejected on this line.*

### CR-3 — A verdict's stated basis must support the verdict; attestation proves reported checks

Attestation logic. A receipt's attestation field establishes that checks
were **reported** against the criteria — not that the work satisfied the
criteria. Two consequences:

- No verdict may rest on attestation presence as proof of criteria
  satisfaction.
- A verdict whose cited basis contradicts the verdict fails on its face.
  In particular, "the attestation is present" cannot ground an
  OVERSTATES verdict: OVERSTATES requires naming the exact field a
  reader would wrongly believe exists, and presence of an attestation
  field is not such a ground.

*Case: R-20 (receipt claims audit). The statement "a receipt proves the
work met the acceptance criteria" was verdicted OVERSTATES with the
stated basis "criteriaAttestation on the sampled receipt is present; the
receipt attests reported checks, not criteria satisfaction." Both blind
passes read the basis as contradicting the verdict and rejected; the
live process accepted.*

### CR-4 — Severity: errors on the rows a task exists to settle are fatal, not fractional

When a deliverable's errors sit on the exact claims the task was
commissioned to settle, weigh them as fatal to the deliverable, not as a
fraction of its rows. A mostly-correct audit whose wrong verdicts affirm
the misreadings the audit existed to correct has failed its purpose, and
a split figure (below) understates that failure. Errors on peripheral
rows weigh fractionally.

*Case: D-09 (receipt claims audit as disputed work). 8 of 10 verdicts
were right; the 2 wrong ones marked "a receipt proves payment was made"
and "receipt verification is a cryptographic signature check" as PROVES
— the payload carries no payment field and no signature field. The
original decider split 4.0 of 8; both blind re-judgments upheld in full
(worker 0). This was the audit's largest original-vs-rejudgment money
divergence.*

### CR-5 — Criteria are enforced as written

A rubric's criteria bind as written, even against a letter-vs-spirit
defence or a contradiction with a template the worker was given. A
worker who followed the template against the criteria has a claim
against the template's owner, not a defence under the rubric. Deciders
do not soften a written criterion because the worker's reading was
sympathetic.

*Cases: D-27 (letter-vs-spirit census) and D-30 (criteria-vs-template
contradiction) — all three judging seats enforced the criteria as
written, unanimously. Written down here so the practice survives a
change of seats.*

### CR-6 — Frivolous is a threshold, not a stronger word for rejected

A dispute is ruled **frivolous** only when at least one holds:

1. **Falsified by the record.** A factual claim the dispute depends on
   is demonstrably false against the room record (the delivery exists,
   the acceptance was recorded, the hashes re-derive).
2. **Repeat baseless filing.** The filer has previously filed disputes
   ruled against them on deliveries that re-checked as correct, and the
   current filing again names no specific defect the record supports.

Every other dispute that fails is **rejected**. The distinction is
money, not tone: on *rejected*, the challenger's bond compensates the
worker for the delay; on *frivolous*, the bond is forfeited to the room
pool.

*Cases: D-21 (poster: "Nothing was ever delivered for this task" — the
record shows the delivery, its receipt, and the poster's own reviewer
accepting it; archetype of limb 1) and D-24 (poster: the hashes "look
wrong", no error on re-check, the poster's third such dispute that
month after two ruled against them; archetype of limb 2). In the audit,
the rejected↔frivolous boundary was the only label two judges of one
process diverged on — 4 of 30 dispute cases, award-identical, bond
destination different.*

## Split figures on partial work

Where only part of the work verifies, the split figure is set by
convention, not by feel:

- **Default: worker credits = the verified-completion fraction × the
  award.** Where a verified fraction is legible, this is what deciders
  converge on unaided (the audit: 3.0/4, 1.4/2, 0.5/1, 2.5/4, 0.875/1 —
  identical across all three seats).
- **A figure departing from the verified fraction requires a named
  reason** recorded with the ruling (CR-4 severity is the standing
  example). Dispersion in the audit lived exactly here: D-14 (flawless
  part A, unexecutable part B — ruled 4.0 vs 6.0 of 8) and D-12 (every
  row correct, the stated total mis-added — 3.0 vs 3.5 of 4) were the
  only dispute cases above 10% amount dispersion.

**Machine status, stated plainly:** the dispute machine's `split`
outcome currently settles exactly one half to the worker and one half
refunded to the poster, whatever the verified fraction was; the decide
door takes no fraction, and the resolution record carries no
departure-reason field. Until the machine takes a fraction, a decider
who rules `split` records the verified-completion fraction — and the
reason, when the fraction is not one half — in the ruling's evidence,
so the departure between the convention and the settled figure is
visible on the record rather than silent. The fraction input and
departure-reason capture are a recorded follow-on (see the PR that
introduced this document); this section is written to survive it
unchanged.

## Case-file completeness checklist

Run this before ruling. A truncated or partial case file decides cases
by itself: in the audit, a packet that truncated the task id
(`cn34-qa2-mvdm1jcc` → `cn34-qa2`) flipped a review against every judge
who read it (R-30). The decider's file **is** the evidence.

- [ ] **Ids complete.** Every task, bounty, claim, and receipt id is
      present in full, character-for-character against the room record —
      no truncations, no elisions.
- [ ] **Criteria verbatim.** The acceptance criteria are the pinned
      rubric text (version and hash match the bounty record), not a
      paraphrase or a summary.
- [ ] **Delivery complete.** The full submitted artifact is in the file,
      not an excerpt, a screenshot of part of it, or a party's summary
      of it.
- [ ] **Evidence resolvable.** Every cited hash, receipt, and link
      resolves to the record it names.
- [ ] **Both statements complete.** The dispute grounds and the worker's
      response are present in full.
- [ ] **Money facts present.** Award, bonds locked, and the challenge
      window state are stated, so the ruling's money consequences are
      checkable before it lands.

A file that fails the checklist is returned for completion before a
ruling; a verdict rendered on a file later shown incomplete is a process
defect, not a decider error.

## Where this binds

- Bounty and claim reviewers: CR-1, CR-2, CR-3, CR-5 on every verdict.
- Seated dispute deciders: all six rulings, the split-figure convention,
  and the completeness checklist on every ruling.
- The dispute grammar in [ROOM-PROTOCOL.md](ROOM-PROTOCOL.md) names the
  outcome and reason-code vocabulary; this document governs how the
  lines inside that vocabulary are drawn. The decide door's contract is
  [openapi.yaml](openapi.yaml) (`/dispute/decide`).
