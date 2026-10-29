# Instruction Pack — Notifications (client-notifications)

Notification surfaces and idempotency: the room-scoped notification
feed a member actually reads, the global notifications door a
returning user actually tries, and the keyed outbound plumbing that
must never deliver the same notification twice.

## 1. The piece

**Tree read (verified, not from memory):** main
`aaa749065a6451321a949ddcb923f3174504fe35`, materialised by
`git archive aaa749065a… | tar -x` into this lane's scratch and read
there. Production is a different build (`ca37fee4`, re-confirmed by
this lane's read-only probe of `GET /api/version` on
https://room.trydemigod.com on 2026-10-28). Every instruction below
targets **main `aaa749065a`** or a descendant, and is accepted only
after the relevant PRs land and deploy. This is not a redesign
typed-object piece, so the FOCUS-REVIEW pause does not gate it; it
is ordinary product work under Rules v2. Neither of John's two
pending decisions (verified-delivery vocabulary; sponsor human
surface) is touched — no fork.

There are **three distinct things** called "notifications" in this
repo. Conflating them is the defect this pack exists to prevent;
keep them separate in every commit, test, and sentence of copy.

**A. The room-scoped read feed (exists, works, is the client's door).**

| Surface | Location, verified at `aaa749065a` |
|---|---|
| Route | `GET /api/rooms/{roomId}/notifications` — legacy chain in `server/http.mjs` (~line 4813, `route === "notifications"`), behind the room-route regex at `server/http.mjs:3862`; query contract: optional single `limit` (positive int) and `before` (positive sequence), anything else → 422 `invalid_notification_selection` / `invalid_notification_limit` |
| Derivation | `server/notifications.mjs` (284 lines) — `store.notifications.list`; header states it plainly: per-member feed derived at read time from the event tail after the member's own room cursor; **read model only, writes nothing, enqueues no wake**; every read re-authenticates. `NOTIFICATION_KINDS = [mention, reply, assignment, work_update, access_request, access_decision, pair_request]`; `NOTIFICATION_TAIL = 500`, `NOTIFICATION_DEFAULT_LIMIT = 50`, `NOTIFICATION_MAX_LIMIT = 100`; edits/deletes/mutes/preferences honoured at read time; a member's own actions never notify them |
| Preferences | `notifications.preferences_set` event (`src/events.js:45`), `server/notify-prefs.mjs` (213 lines), `server/notify-policy.mjs` (301 lines), settings UI in `src/account-settings-ui.js:397` ("Notifications" section) |
| Sibling room routes | `GET /api/rooms/{roomId}/agent-inbox`, `GET /api/rooms/{roomId}/feedback/notifications` (feedback read empties after each read, per `docs/openapi.yaml:7445`) — same room-route family, same fail-closed auth |
| Client | `index.html:314-328` — `#notification-panel`, `#notification-count`, `#notification-list`, `#notification-newest` / `#notification-older`, "Mark read" button (`#notification-read-button`); `src/client.js:926` `notifications(before)` → `this.path("/notifications…")` where `path()` prefixes `/api/rooms/${roomId}` — **room-scoped only**; rendering + paging in `src/app.js` ~6753-6810. Mark-read goes through `POST /api/rooms/{id}/cursor` (+ `activity-read`, `activity-read-all`, `read-horizon`), never a notifications mark-read route |
| Spec | `docs/openapi.yaml:4843` documents the room-scoped GET (and :7445 the feedback GET) at this SHA |
| Tests that already pin it | `tests/notification-feed.test.js` (326 lines), `tests/notification-preferences.test.js` (71 lines) |
| Registrations at this SHA | `server/notifications.mjs` is already in both `scripts/runtime-package.mjs:398` and `scripts/candidate-runtime-fixture.mjs:129` |

**B. The global notifications door (does not exist, in any shape).**
There is no `GET /api/notifications`, `/count`, `/unread`,
`/unread-count`, and no `POST /api/notifications/mark-read` or
`/read-all` anywhere in `server/` or `docs/openapi.yaml` at
`aaa749065a` (grep-verified by this lane: zero non-room hits).
Same for the deferred global inbox family (`/api/inbox*`,
`/api/verdict-inbox`): the inbox routes are built
(`server/routes/inbox.mjs`) but deliberately gated off —
`enableDeferredInbox` defaults to false in `server/http.mjs:379`,
the gate rejects the family with 404 at `server/http.mjs:1335`, and
neither production entry passes the flag. The inbox family is
**out of this pack's scope** except where its 404 shape is shared
(§4 step 3); do not enable it, do not flip the flag as a drive-by.

**C. Outbound notification plumbing (the H5 piece; a service, not a
surface).** At `aaa749065a` there is **no**
`server/notification-service.mjs`, no caller of one, and no
idempotency key on any outbound send. What exists around it,
verified at this SHA: `server/notify-email.mjs` (127 lines) renders
notification email but its own header says *"Delivery is inert:
nothing in the server sends these messages"* (Resend transport
unconfigured → `unavailable`); `server/human-push.mjs` (432 lines)
+ `server/web-push.mjs` + `server/push-subscriptions.mjs` implement
human browser push, which stays off until VAPID keys are present
(`server/http.mjs:405-409`) and which, per `server/notifications.mjs`'s
header, does **not** read the §A feed. So today: no email/push
delivery pipeline, and every improvised send (fleet Gmail connector,
room posts) is a direct, unkeyed, at-least-once call — a retry or a
queue resubmission **is** a duplicate by construction.

**The one PR that already covers part of C — draft #5095 (read in
full by this lane via `gh pr view` + `gh pr diff`, 2026-10-28):**
"H5: notification plumbing with idempotency keys", OPEN, **draft**,
no labels, head `e3e0c784ae82a1a90470b1e5094d8fe498ca0881`,
+170/−0 in exactly 3 files:

- `server/notification-service.mjs` (+99, new): `createNotificationService({provider, maxAttempts = 5, baseDelayMs = 20, sleep})` — injected provider `{send()}`, per-notification `idempotencyKey` required, keys derived by `notificationShapes` via SHA-256 over `kind|identity` (truncated to 32 hex chars) for the three existing shapes: `deployAlarm({deploymentId, summary})`, `mentionWake({roomId, sequence, mentionId})`, `digest({date, recipientId})`; exponential backoff ×2; resubmission of a delivered key returns `duplicate-absorbed`; a concurrent resubmission joins the in-flight promise; exhausted budget appends to an in-process dead-letter list exposed via `deadLetters()` / `counts()`. Copy in the module correctly claims **effectively-once** (at-least-once transport + idempotent delivery), never exactly-once. Nodemailer licence noted in-header as checked (MIT); no live transport is wired.
- `tests/notification-idempotency.test.js` (+70, new): the H5 failure-injection workload (3 unique × 3 submissions at failure rates 0 / 0.3 / 0.6, deterministic LCG, duplicates = 0, delivered + dead-lettered = 3), dead-letter accounting, key-collision absorption, key-derivation stability.
- `scripts/runtime-package.mjs` (+1): `server/notification-service.mjs` added as an optional runtime-package entry.

**Status of #5095 — NOT bound, NOT priced, NOT landable as-is**
(all verified by this lane at the sources named):
- Bindings file `~/workspace/goals/uuriko-project-room-bug-fix-program/hidden_files/landing-watch-bindings.json`, read directly: **#5095 is absent** from `prs` and from `watched`. It has no bound head and no settle record in force.
- Settle pass 21 (`~/workspace/wave-2026-10-27-settle-pass-21/SYNTHESIS.md`, BLOCKED-named list) priced it at an earlier head `d4861de3` and named it **BLOCKED — merge conflict (409) vs the composition main; author/semantic reassembly owed**, in the seam cluster with #5105 (runtime-package allowlist seam vs #5095–#5098). The head has since moved to `e3e0c784`, so that blocked record does not describe the current head and no record binds it.
- Current checks at `e3e0c784` (`gh pr view` status rollup, run `40675072526` et al., 2026-10-28T10:48Z): `mergeable: MERGEABLE`, `mergeStateStatus: BLOCKED`; `safety-net` **FAILURE**; `review-mechanical` SUCCESS; every heavy job (unit, browser shards, lint, coverage, contract, pr-gates, schema-gate) **SKIPPED** — the designed skip for an unlabelled PR (no `ready-to-land` label; heavy CI does not run until the label is added once — a re-run does not cure it).

What #5095 deliberately does **not** do (the remainder this pack
instructs, §4 steps 2-4): it wires the service to **no caller** (no
route, no send path, no deploy alarm, wake, digest, email, or push
call site imports it); its dedupe state (`deliveredKeys` Set,
`inFlight` Map, `dead` array) is **in-process memory only** — a
restart forgets every delivered key and every dead letter; its
dead-letter surface is a function return, not anything an operator
can read; and it does not add `server/notification-service.mjs` to
`scripts/candidate-runtime-fixture.mjs` (the runtime-package line
alone may not satisfy the sweep — §5 check 6 makes the implementer
prove it).

## 2. Current state

1. **Global notifications 404, byte-identical to a bogus path, with
   no pointer to the door that works — EXECUTED, twice, still live.**
   UT2 lane 06-02 (`~/workspace/wave-2026-10-27-user-testing-2/lanes/06-02-return-inbox-404s/REPORT.md`, F1/F2, S2, KNOWN-STILL; 73 executed probes against production build `e8ce094d`): every global notifications shape (`GET /api/notifications`, `?limit=10`, `/count`, `/unread`, `/unread-count`, `POST /mark-read`, `POST /read-all`) → 404 with the generic `not_found` body, anon and with an auth header present; the bogus-path control returned the byte-identical template; the body's `next` steps point at `/api/public-work/tasks` and `room_check_access`, **never** at `/api/rooms/{roomId}/notifications`. The three room-scoped GETs in the same run → 401 anon (route matched, fail-closed — F4, Works). **This lane re-probed production read-only on 2026-10-28** (build now `ca37fee4`): `GET /api/notifications` → 404 with the same generic body and the same non-pointer `next`; `GET /api/rooms/nope/notifications` → 401. No delta.
2. **The decision behind the 404 was never taken, and the docs
   disagree in both directions — EXECUTED / source-read.** The
   UT-conversion charter (`~/workspace/wave-2026-10-27-ut-conversion/charters/deferred-inbox-notifications.md`, diagnosis at main `927a6420`) established that no global route ever existed and named the open choice — global-read vs pointer-404 vs spec-fix — plus the acceptance rule that whichever way it goes, the OpenAPI/llms text must match production. UT2 06-02 §"Docs-vs-reality grading" (F3, S3, NEW nuance): repo spec promised the 39-op inbox/notifications family of which 36 global ops 404; prod-served `GET /openapi.json` (200, 67 paths) contained **zero** `inbox`/`notif`/`gmail` paths — including zero rows for the 3 room-scoped routes production actually serves; `/llms.txt` is silent on the whole family and `/llms-full.txt` never mentions `/api/notifications` in either shape. At `aaa749065a` the repo spec leg has partly healed (the room-scoped GET is documented, §1A) — the prod-served-spec and llms legs are **UNVERIFIED at the current production build**; §4 step 3 re-checks them by executed fetch, not by citation.
3. **Outbound duplicates are structural, and the fix is measured —
   EXECUTED spike, no production build yet at `aaa749065a`.**
   Discovery-50 lane H5 (`~/workspace/wave-2026-10-27-discovery-50/lanes/H5/REPORT.md`; SYNTHESIS §3 "H5 notification idempotency: duplicates 200%→0% under failure injection → RECOMMENDED", §4 price ~4–8 lh): baseline 9 submissions of 3 unique notifications → **9 deliveries (200% over-delivery)**; with a per-notification idempotency key + backoff (20 ms ×2, 5 attempts), duplicates delivered = **0 at failure rates 0, 0.3, and 0.6**, with the honest cost that at a sustained 0.6 rate one notification dead-letters after 5 retries — counted, not silently dropped. Discovery-adopt converted this to a build charter (`~/workspace/wave-2026-10-27-discovery-adopt/charters/H5-notification-idempotency.md`: BUILD, ADOPT-NOW, falsifier pre-registered, boundary vs wake #5008/#4994 stated, no bound collision found at its read time) and #5095 is that charter's build — in draft, unbound, with the §1 status above. The wave-level convergence (SYNTHESIS §3: C2 orchestration + H5 notifications + C1 wake dedupe — "idempotency as a pattern") is context, not licence to touch wake or orchestration from this pack.
4. **Notifications that never arrive at all, on the surfaces that
   do exist — EXECUTED, owned by a sibling charter, boundary only.**
   UT2 SYNTHESIS (`~/workspace/wave-2026-10-27-user-testing-2/SYNTHESIS.md` §5, "Attention infrastructure is theatre at the edges") and the UT2-conversion attention-plumbing charter record: mentions queue no wake signals despite the product's own copy (06-07); credits materialise silently with no notification (02-02 F-5); withdrawing an offer with a live claim signals nobody on either side (02-03); needs-me is empty for deciders/posters in cases it should not be. Those are **attention/wake** defects, not this pack's build: this pack owns (a) the §A feed's correctness as a read surface, (b) the global door's answer, and (c) §C's keyed plumbing. Where the mention-wake *shape* is wired in §4 step 2, the boundary in §4 applies: key the notification at the notification-service boundary; never edit `server/wake-*`.
5. **The §A feed itself: no executed defect on file at this SHA.**
   UT2 06-02 F4 graded the room-scoped family Works/fail-closed;
   the client uses exactly that door and no shipped client code
   calls any 404 path (UT2 06-02, source-read of prod-served bytes;
   re-verified in structure at `aaa749065a` in §1A). The feed's known
   limits are by construction and must be preserved, not "fixed":
   bounded tail (500 events past the cursor; older unread reachable
   via the return brief, and the response says where it started),
   `before`-paging at default 50 / max 100, no wake granted by a
   read. UNVERIFIED: member-authed behaviour of the feed in a real
   room under the current production build (UT2's member leg was
   mint-429-blocked; wave 1 covered the headline paths on the same
   pin UT2 used). §5 check 5 closes this on the deployed build.

## 3. What fantastic means

A returning member can always find what needs them, in one step,
from any door they try; and no human or agent ever receives the
same notification twice, however often the queue retries. Exemplars
worth matching for behaviour (not code): Stripe's idempotency keys
(a resubmission with the same key returns the original result, never
a second effect); Linear's inbox (one cross-project attention list
whose every row deep-links to the thing itself); a mail pipeline
whose dead-letter queue is a list an operator reads, not a counter
nobody sees.

Concrete, measurable end state:

- **Zero duplicates, proven under failure, forever.** The §4
  failure-injection workload (3 unique notifications × 3
  submissions, provider failure rates 0 / 0.3 / 0.6) delivers
  duplicates = **0 at every rate** and unique = 3 at rates 0 and 0.3
  — the H5 lane numbers, reproduced against the shipped service,
  not the spike. Resubmitting an already-delivered notification
  returns the absorbed result with **no second delivery and no error
  surfaced as a new send**.
- **Nothing is ever silently dropped.** At every failure rate,
  submitted = delivered + dead-lettered, exactly, with no third
  category; every dead letter is readable after the fact (shape,
  key, attempts, time) by an operator surface named in the PR —
  after a process restart as well as before it (§4 step 2's
  durability bar).
- **The global door answers in one step.** `GET /api/notifications`
  (and its count/unread/mark-read shapes) returns either the real
  cross-room read (§4 step 3, branch A) or a 404 whose `hint`/`next`
  names `/api/rooms/{roomId}/notifications` as the working door
  (branch B, the pack's default). Zero responses in the family are
  byte-identical to the bogus-path control. A returning user who
  follows the hint reaches their notifications in **1 additional
  request**, room by room.
- **Docs match production in both directions.** Repo
  `docs/openapi.yaml`, prod-served `/openapi.json`, `/llms.txt`, and
  `/llms-full.txt` each list exactly the notification routes that
  exist (room-scoped included) and no route that 404s; a grep for
  `notif` over the prod-served spec returns the same route set as a
  grep over the route table.
- **The room feed stays exactly as good as it is.** Unread badge
  (`#notification-count`) equals the feed's unread count for the
  member's cursor; paging with `before` reaches the start of the
  500-event tail with no gaps or repeats; "Mark read" advances the
  cursor and the badge clears; preferences (incl. `mentions_only`
  and `none`) suppress exactly the kinds they name; a removed
  member's next read is 401/403, never a stale list. Feed read
  remains a read: it grants no wake, writes nothing.
- **Vocabulary honesty.** No copy, doc, test, or PR text anywhere in
  the diff claims "exactly-once". The delivered property is named
  **effectively-once** everywhere it is named at all.

## 4. The instruction

Target tree: main `aaa749065a` or a descendant. Sequence matters:
step 1 lands #5095's service; step 2 is a **separate** PR built on
top of it; step 3 is independent of both and may go first if the
seat prefers. Client stays vanilla JS. No schema change is
authorised except step 2's conditional dead-letter/dedupe store,
which if needed lands **singly, green at exact head** (schema rule)
and is flagged as such in its PR. Fix lanes never merge.

**Step 0 — Re-price #5095 at its current head before touching it
(settle work, ~1 lh, Jill's fleet / settle pass, not the
implementer).** #5095's head moved after its BLOCKED-named record,
so nothing about `d4861de3` carries to `e3e0c784`. At the current
head: (a) read the `safety-net` FAILURE in run `40675072526` and
name its cause in the settle record — if the failure is in
#5095's own diff, it goes back to the author as a cure; if it is a
named red on main itself, record it as such, do not silently absorb
it; (b) resolve the runtime-package seam against #5105 and the
#5095–#5098 cluster named in settle pass 21 (second lander
regenerates the allowlist/candidate artifacts at its merge-up);
(c) add the `ready-to-land` label **once** so heavy CI runs, then
price the full generation at the composed head; (d) bind only on a
SETTLED-GREEN (or REBIND-WITH-NAMED-RED) record. Do not edit #5095's
code in the settle pass; settle does not author.

**Step 1 — Land #5095 as built (author cure only if step 0(a)
requires it).** The PR's scope is already correct and charter-exact:
`server/notification-service.mjs`, its test, the runtime-package
line. The implementer's only jobs: cure the named safety-net failure
if it is own-diff (smallest change; if the cure touches the key
derivation or the dedupe logic, the §5 failure-injection check
re-runs in full), keep the effectively-once wording verbatim in
spirit, and pass §5 checks 1, 2, and 6. **Do not** add wiring,
routes, durability, or a transport to this PR — that is step 2, and
bundling it re-opens the seam and the price.

**Step 2 — Wire and harden the service (separate PR, ~4–6 lh of
the charter's 4–8 lh envelope, remainder after step 1).** On top of
landed #5095:
(a) **Call sites.** Route the three existing shapes through
`createNotificationService` at their existing emission points:
deploy alarm, mention wake, digest. Find the emission points by
grep (`deploy` alarm paths, the wake bridge's mention path, the
morning-brief/digest path through `server/notify-email.mjs`'s
callers) and wrap them — the service takes over retry/dedupe at
that boundary; the shapes' content, recipients, and timing do not
change. **Boundary (hard):** if wiring the mention-wake shape
appears to require editing `server/wake-transaction.mjs`,
`server/wake-metrics.mjs`, or any `server/wake-*` file, STOP and
report — wake execution/accounting is owned by bound #5008
(wake transaction runner, shared-core, lands singly) and #4994
(wake-accounting reader, stacked on #5008); keying happens at the
notification boundary or not at all in this PR.
(b) **Durability.** Dedupe and dead-letter state must survive a
process restart: persist delivered keys and dead letters in the
existing store the service's deployment already uses (follow the
store-registry pattern of neighbouring server modules; a bounded
retention — e.g. keys retained at least as long as the longest
queue-retry horizon, with the bound named in code and in the PR —
is required, since an unbounded key set is a slow leak and an
unbounded dead-letter list likewise). If persistence requires a
new table, that is a schema change: the PR lands singly, and §5
check 6's store-registry items become REQUIRED, not conditional.
If the existing store offers a no-new-table home, prefer it and say
so in the PR.
(c) **Operator surface for dead letters.** Expose the dead-letter
list where an operator already looks (an existing diagnostics /
operator read, or the service's `deadLetters()` surfaced through
the existing morning-brief/deploy-alarm path — implementer's choice,
named in the PR). It must show count plus per-letter kind, key,
attempts, and timestamp, and it must read the persisted state from
(b), not process memory. No new public route is authorised for
this; an operator/internal read only.
(d) **Transport stays inert unless already configured.** Do not
wire a live email/push transport, do not add VAPID or Resend
configuration, and do not make any external send in development or
tests (fake provider/sink only — the H5 lane ran zero external
sends; so does this build). If an emission point in (a) turns out
to have no live transport behind it today (e.g. the inert email
renderer), wiring it to the service still counts: submissions are
keyed and dead-letter honestly as `unavailable`/exhausted rather
than duplicating or vanishing when a transport is later configured.
The nodemailer licence check is already recorded in #5095's module
header (MIT, verified against the package licence field); do not
re-litigate it, and do not add the dependency in this step.

**Step 3 — Answer the global door (separate small PR, ~2–4 lh).
Default branch B; branch A only on Jill's recorded say-so.**
The UT-conversion charter left global-read vs pointer-404 vs
spec-fix open. This pack decides the executable default and the
implementer builds it without waiting for a further ruling:
- **Branch B (default) — pointer-404 + spec truth.** Keep the
  global route non-existent, but make the family's 404 answer
  honestly: for `GET /api/notifications` and its probed shapes
  (`/count`, `/unread`, `/unread-count`, `POST /mark-read`,
  `POST /read-all`), the `not_found` response's `hint` and `next`
  name the room-scoped door (`GET /api/rooms/{roomId}/notifications`)
  and state that notifications are per-room. Implement at the
  narrowest point that catches exactly this family (the 404 shaping
  in `server/http.mjs` / the error-catalogue path it already uses) —
  the bogus-path control and every other family's 404 must remain
  byte-identical to today. Reuse the existing `not_found` code; a
  new error code triggers §5 check 6's catalogue items in both
  copies. Then make the docs true: repo `docs/openapi.yaml` already
  documents the room-scoped GET at this SHA (verify, don't assume);
  fix whichever of prod-served `/openapi.json` generation,
  `/llms.txt`, `/llms-full.txt` still omit the room-scoped routes or
  imply a global one — find the generator/source for each surface
  and edit there, never the served bytes.
- **Branch A (only if Jill records it) — global cross-room read.**
  Build `GET /api/notifications` as an authenticated cross-room
  aggregation over the member's rooms, reusing
  `server/notifications.mjs`'s derivation per room (no second
  derivation, no second catch-up surface — the deferred-inbox
  charter's warning, and the returning-catchup charter owns the
  substrate if it has since built one; check
  `~/workspace/wave-2026-10-27-ut-conversion/charters/returning-catchup.md`
  before designing). This branch trips the full route triple (§5
  check 6) and needs its own price before building; the pointer-404
  work in branch B is then skipped, not stacked.
- **Either branch:** the deferred inbox family (`/api/inbox*`) is
  not enabled, renamed, or re-pointed by this step. If the 404
  shaping point is shared with the inbox gate at
  `server/http.mjs:1335`, the inbox family's responses stay exactly
  as they are unless Jill separately records the deferred-inbox
  decision — a shared-code change that alters inbox 404 copy is a
  scope escape; report it instead.

**Step 4 — Client leg (only if a gap is found; ~0–2 lh).** The
client is believed correct (§2 item 5). Verify, in the deployed
build of the target tree, the §3 feed bars (badge = unread count,
`before`-paging continuity, Mark read clearing the badge,
preference suppression, removed-member 401/403) via §5 check 5. Fix
only a gap that check actually demonstrates, in `src/client.js` /
`src/app.js` / `index.html`, vanilla JS, no panel redesign. If the
global door's branch-B pointer needs a client-visible touch (it
should not — the pointer is for API callers), stop and report
rather than improvising UI.

**Explicit non-goals:** a notification *product* surface (new
channels, templates, marketing sends, per-user channel matrices,
push-provider selection) — the H5 charter calls it "a separate,
unpriced question" and it stays separate; enabling the deferred
inbox/Gmail family or flipping `enableDeferredInbox`; rebuilding
wake delivery or wake dedupe (C1/wake ladder, #5008/#4994);
attention-plumbing cures (mention wake signals, silent credit
grants, claim-withdrawal signals — UT2-conversion
attention-plumbing charter owns them; this pack only keys what is
emitted); changing the §A feed's kinds, tail, limits, or
preferences semantics; any money, money-adjacent, or freeze-class
surface; "exactly-once" claims anywhere.

## 5. Acceptance

Jill (or her fleet) accepts from this section alone. Evidence binds
to the tree SHA (Ruling 41 — this piece is below the money line;
step 2's PR lands singly only if it carries a schema change, per
§4). Each PR (steps 1, 2, 3) is accepted separately against the
checks named for it.

1. **Failure-injection re-run (steps 1 and 2, the charter
   falsifier).** The H5 workload against the shipped service with a
   fake provider — 3 unique notifications (deploy alarm, mention
   wake, digest), each submitted 3×, at injected failure rates 0,
   0.3, 0.6 — asserting duplicates delivered = 0 at every rate and
   unique delivered = 3 at rates 0 and 0.3. Run by name:
   `node --test tests/notification-idempotency.test.js`, raw output
   filed with the acceptance record (lane reference:
   `~/workspace/wave-2026-10-27-discovery-50/lanes/H5/output/results.json`).
   One duplicate at any rate kills the idempotency claim — the
   charter is killed, not re-priced.
2. **Dead-letter accounting (steps 1 and 2).** At failure rate 0.6
   with the retry budget forced to exhaust: every undelivered
   notification appears on the dead-letter surface and the counts
   reconcile exactly (submitted = delivered + dead-lettered, no
   third category). Step 2 additionally: kill and restart the
   process between submission and read-back — delivered keys still
   absorb resubmission (no duplicate), and the dead letters are
   still readable on the §4 step 2(c) operator surface. A silent
   drop at any point fails acceptance until fixed and re-run clean.
3. **Key-collision check (steps 1 and 2).**
   `tests/notification-idempotency.test.js`'s collision and
   derivation tests pass by name: same shape + identity → same key
   → absorbed with no second delivery and no error; different
   identity → different key → delivered.
4. **Global-door probes (step 3, executed against the deployed
   build, read-only GETs + the two POST shapes with empty bodies).**
   Re-run UT2 06-02's notifications census: branch B — every global
   shape returns the pointer 404 whose `hint`/`next` names
   `/api/rooms/{roomId}/notifications`, none byte-identical to the
   bogus-path control, and the bogus control itself unchanged;
   branch A — `GET /api/notifications` returns 401 anon / 200
   member with only that member's rooms' items. Plus the docs
   check: fetch prod-served `/openapi.json`, `/llms.txt`,
   `/llms-full.txt` and grep `notif` — the route set matches the
   route table exactly, in both directions.
5. **Room-feed regression + the member leg UT2 could not run
   (steps 1-4, on the deployed build).** Named suites green at the
   exact head: `node --test tests/notification-feed.test.js tests/notification-preferences.test.js`
   (run by name; `verify:affected` does not guarantee selecting
   them). Executed member session (John's Tab or Fo, post-deploy):
   two identities in one room — mention, reply, assignment, and a
   work update each appear once in the other member's feed and
   badge; `before`-paging reaches the tail start with no repeats;
   Mark read clears the badge; a `mentions_only` preference
   suppresses the work update and keeps the mention; after removal,
   the ex-member's feed read is 401/403.
6. **Registration sweep** (per `~/AGENTS.md` "Pre-flight
   registration sweep"; implementer runs
   `node ~/workspace/fleet-tools/registration-sweep.mjs --pr <n>`
   per PR and the report must show no MISSING):
   - Runtime-package closure — **applies, all steps:** step 1 adds
     `server/notification-service.mjs` to
     `scripts/runtime-package.mjs` (already in #5095's diff — verify
     at the landing head, including its full import closure, which
     today is only `node:crypto`); **also prove the
     `scripts/candidate-runtime-fixture.mjs` leg** — #5095 does not
     touch it, so the sweep reading REQUIRED/MISSING there is the
     implementer's to satisfy (add the path, mirroring
     `server/notifications.mjs` at fixture line 129) or to evidence
     as NOT-APPLICABLE; an unexamined fixture leg is a bounce.
     Step 2's new/changed `server/**` modules re-trip this item in
     full.
   - Error-code catalogue, both copies — **applies only if** a new
     error code is introduced (branch B should reuse `not_found`:
     then n/a, one-word why — reused). If one is introduced: row in
     `skills/project-room/references/errors-catalog.md`, then
     `node scripts/skills-sync.mjs`, mirror byte-identical.
   - Route triple — **n/a for steps 1-2** (no route added; step 2(c)
     is an internal/operator read on an existing surface — if the
     implementer instead adds a route, this item flips to REQUIRED
     in full and the PR stops for a re-price). **REQUIRED for step
     3 branch A only:** `server/routes/table.mjs` row (+ legacy
     allowlist if on the legacy chain), `docs/openapi.yaml`
     operation + bare-path quickstart example, well-formed
     `x-room-permission` marker, parity note (`parity: "mcp:…"` or
     `exempt:<reason>`). Branch B changes no route: n/a, why —
     copy-only.
   - Harness copy sets — **applies if** step 2 imports the service
     from any module a test harness copies/transforms; the sweep
     item must read SATISFIED, with check 1's suite as proof.
   - Store registries — **conditional (step 2 only):** if dead-letter
     / dedupe persistence adds a table, writer-fence +
     purge-registry + recovery-audit registration are REQUIRED and
     the PR is schema-class (lands singly); if it reuses an existing
     store home, the PR body names that home and this item reads
     n/a with that evidence. Steps 1 and 3: n/a — no tables.
   - Generated/mirrored artifacts — **applies:** step 3's OpenAPI /
     llms changes go through their generators or check-pairs (run
     the CHECK, never hand-edit served artifacts); if any step's
     diff grows the MCP catalog or EVENT_TYPES, the standing
     instances in `~/AGENTS.md` (catalog snapshot regeneration +
     the two count-pin suites run by name) apply — none is expected
     in this piece, and an unexpected hit is reported, not absorbed.
   - Diff hygiene — any PR over 300 changed lines carries the
     `## Large diff justification:` section in its body at filing.
   - Close-out — `npm run verify:affected` green per PR, plus,
     because steps 1-2 touch `server/**`, `CI=1 npm run check`
     green at the exact landing head (or the batch's composed head);
     a suite that cannot run locally is NAMED in the PR body.
   - Refusal-shape step — **applies to step 3 branch B:** the diff
     remaps a refusal's copy (not its status/code); grep the test
     tree at head for pins on the old 404 body/hint for the
     notifications family and report them as REQUIRED-review
     evidence (exit contract unchanged). All other steps: n/a.
7. **Standard close-out per PR:** `ready-to-land` label added once
   before pricing (an unlabelled generation's SKIPPED jobs are by
   design and prove nothing); PR body carries the before/after
   evidence for its step (step 1: step-0 safety-net disposition;
   step 2: restart-durability output; step 3: probe table in UT2
   06-02's format). Fix lanes never merge; the seat lands steps 1
   and 3 in the ordinary queue (batched under Rules v2 is
   acceptable), step 2 singly only if schema-class per check 6.

## 6. Routing

**Step 0 + acceptance: Jill's fleet** — settle/re-price of #5095,
bindings, and §5 verification are fleet work; the fleet never
merges. Handover is the settle record itself, posted in Project
Room.

**Step 1: #5095's existing author** (cure-only, if step 0(a) names
an own-diff failure); if that seat is gone, **Codex** — server/core
is his lane, and this is a bounded cure on a server module, not a
rebuild. Handover: `room_request_reply` in Project Room to the
exact member, with a concrete `workItemId` and the expected result
named as "#5095 cured at a named head, §5 checks 1-3 and 6 green,
ready for settle pricing — no scope added".

**Steps 2 and 3: Codex** — both are server work (service wiring and
store persistence; route/error shaping in `server/http.mjs` plus
spec generation), squarely server/core, and all Codex utilisation
happens inside Project Room. Handover per step: `room_request_reply`
with its own `workItemId` and expected result ("one PR at a named
head per step; step 2 states its store home and schema class in the
body; step 3 states branch B and shows the probe table"). Claude is
not the implementer (no client build is expected; if §4 step 4
finds a real client gap, that gap is handed to Claude as its own
small item on his PR train). **Grok Bot / the landing seat** lands
all PRs in §5 check 7's order and classes, with John's Tab on the
merge-gate as usual. **John's Tab** does post-deploy verification:
§5 check 4's probes and check 5's member session on the deployed
build, naming that build's revision in the report. **Fo** is the
fallback for check 5's browser leg (responsive duty) if John's Tab
is unavailable. Jill accepts or bounces from §5 alone.
