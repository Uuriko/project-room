# Notes on the roadmap, offered for argument

16 September 2026. Claude (Cowork). A position to disagree with, not a decision.

## What I read

- **Issue #6**, "Consumer + enterprise readiness: one core, two experiences, 36
  acceptance tasks". Opened 6 September, **closed, zero comments**.
- **`docs/AGENT-WORKSPACE-ROADMAP-2026-09-08.md`**, which carries its own build
  order and release gates.
- Issue #11 points at "roadmap #6" as the roadmap.

First thing worth flagging before any opinion: **there are two roadmaps and they
sequence differently.** Issue #6 ends with "Instinct integration completion, Grok
adapter preparation with B1/A6 checklists, then a shared product slice". The
workspace roadmap ends with "native host acceptance, then versioned charters, then
isolated execution, then Dasha, then wakeups, then remote MCP". Neither references
the other. Whichever is live, the other should say so at the top, because right now
an agent picking up work can follow either and be defensibly wrong.

## What is strong, and I mean this

The product commitments are the best part and I would not touch them. "Home is the
conversation. Work and administration progressively appear." Consumer defaults
change presentation only, never server authorization. Personal and organizational
spaces never silently share history. Those are real constraints that kill whole
categories of bad feature, which is what a good principle is for.

The acceptance-journey discipline in the workspace roadmap is also unusually good:
every milestone needs a successful journey, an interrupted one, a denied or
stale-authority one, and a human-readable recovery path. Most teams ship the first
and discover the other three in production.

## Four disagreements, worst first

### 1. Thirty-six tasks in six buckets of six is a readiness checklist, not a roadmap

The symmetry is the tell. Real roadmaps are lumpy, because the world is. Six equal
lanes of six items comes from wanting completeness, and completeness is the wrong
goal when you do not yet know which half of the product matters. A roadmap should
be an ordered list of bets, each capable of being wrong, arranged so the cheapest
disproof comes first. This is a list of everything that would need to be true if
the plan already worked.

### 2. The enterprise half presumes a buyer who does not exist yet

Section D is PostgreSQL tenant isolation with row security, SAML/OIDC with
enforcement testing, SCIM lifecycle and offboarding reconciliation, exportable audit
trail. That is six tasks of serious work, weighted equally with consumer entry, for
a product with no buyer named anywhere in the plan.

SCIM offboarding reconciliation is not the next thing after "the room forgets
everything on restart". If an enterprise buyer appears, D becomes urgent and mostly
unavoidable. Until one does, it is the most expensive way to feel productive.

### 3. The one experiment that could invalidate the plan is scheduled 33rd of 36

F3 is "conduct unaided newcomer activation experiment". That single item tells you
whether anything in A, B or C actually lands, and it sits in the last bucket behind
Slack import and procurement documentation. The cheapest disproof is scheduled last.

It is also now much cheaper than when it was written, because Google sign-in is live
and any Google account can reach the room. The main input that experiment needed has
already arrived.

### 4. Nothing on the list names a number it would move

Thirty-six acceptance tasks, no metric attached to any of them. A6 is "create
welcoming first room without setup wizards". How would we know it worked? That was
a fair omission on 6 September because there was no instrumentation. There is now:
activation and time to first contribution, time to first agent, invite send-to-accept
with expiry loss, the witness-to-sponsor rate and open obligations, all in
`src/growth-metrics.js` and `server/invitation-funnel.mjs`. Every roadmap item should
name the number it moves, and items that cannot name one should be honest that they
are hygiene rather than progress. Plenty of hygiene is necessary. It should just be
labelled.

## What I would put in its place

Same material, reordered as bets. Each one can fail, and failing early saves the
items behind it.

| # | Bet | Disproved by | Cost if we skip it |
| --- | --- | --- | --- |
| 0 | **Enough real members to measure.** | Cohorts stay too small to read | Every bet below is arithmetic on two data points |
| 1 | People come back at all | Join-cohort retention flat by week two | A, B, C are all decoration |
| 2 | A person will plug in their own agent | Time to first agent never lands | Section C is wasted; the agent thesis is dead |
| 3 | Watching agent work makes someone bring theirs | Witness-to-sponsor rate near zero | Growth has to be bought rather than earned |
| 4 | Obligations bring people back better than unreads | Obligations pile up unresolved | The retention model is wrong, not the copy |
| 5 | A real organisation wants this enough to configure SSO | No design partner will start | Section D was premature, exactly as suspected |

**Correction, 16 September.** Bet 0 originally read "persistence: the room
remembers", on the belief that `persistence: none` meant the Room forgets. It does
not. That flag belongs to the anonymous self-join preview; the Room persists to
SQLite and the live Worker to a SQLite-backed Durable Object. The real bet 0 is
simply having enough real members for a cohort to mean anything, which is a
distribution problem rather than an engineering one, and it is still not on #6.

Bets 1 through 4 are all measurable today with instrumentation that already exists
and is tested. That is the argument for this shape: it is not more work, it is the
same work with an order that can be wrong out loud.

## Where I am probably wrong

Three honest ones, because a position with no failure modes is advocacy.

**If the path to money is a design partner, section D is the product, not premature.**
A single enterprise buyer with a procurement process will demand SSO and audit export
on day one and will not wait for a retention cohort. If that conversation is live and
I do not know about it, reorder around it and ignore disagreement two entirely. This
is the one that would most change my mind, and I do not have visibility into it.

**Consumer retention may be the wrong bar for a tool used by operators.** A
multi-agent operator might use this intensely for two weeks of a project and then not
at all for a month, and that is a healthy pattern, not churn. My cohort framing would
score it as failure. If the beachhead is project-shaped, retention should be measured
per project, not per week, and bet 1 above is mis-specified.

**Thirty-six tasks may be doing coordination work I am undervaluing.** With several
agents working in parallel, an exhaustive enumerated list is claimable and hard to
collide on, which is worth real money in this fleet. A six-bet roadmap is better
thinking and worse dispatch. The honest answer is probably both: bets on top for
order, the enumeration underneath as the backlog each bet draws from.

## Questions I would rather have answered than guess

1. Is issue #6 still live? It is closed with no comments, and closed usually means
   superseded. If the workspace roadmap replaced it, say so in #6 so nobody works
   from the wrong one.
2. Is there a design-partner conversation in flight? It changes the order more than
   anything else here.
3. Answered while writing this, and I had it wrong: nothing is blocking persistence.
   The Room already persists; only anonymous self-join does not, and that is gated on
   "abuse controls and owner decision" per the contract. The open question that
   remains is whether that owner decision is close, because persisted self-join is
   what turns the open Google door into members who can be measured.
