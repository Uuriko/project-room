# Instruction pack — door-auth-entry: sign-in UI and the authenticated entry surface

## 1. The piece

**What it is.** Everything a signed-out human meets before they are inside a room:
the sign-in panel on `/`, its email/password, email-link (magic), password-reset,
passkey and OAuth methods, the history/Back behaviour around those methods, and
the same component reused inside the invitation and join-account flows. Agent
sign-in (`/agent-signin`, `src/agent-signin-ui.js`) is a neighbouring surface
that shares endpoints; it is a seam, not this piece (see Non-goals).

**Verified against source — tree read: main `aaa749065a6451321a949ddcb923f3174504fe35`.**
Read by `git archive aaa749065a…` of the named files below into lane scratch
(the shared clone `~/workspace/project-room` is stale and was not read as main).
Production is a different, older tree: build `ca37fee4` (pre-#5090), per
Cluster A lane A8 — see §2. **This pack targets main `aaa749065a`; it does not
describe what production serves today.**

| Surface / file | What lives there (verified at `aaa749065a`) |
|---|---|
| `index.html` `#auth-panel` (hidden section, `aria-labelledby="auth-title"`) | Static shell: `#google-signin` anchor → `/api/auth/google/start`; `#github-signin` anchor (statically `hidden`) → `/api/auth/github/start`; `#signin-controller > #auth-signin-ui` mount point; `#email-auth-step > #email-auth-panel` (auxiliary views are re-parented here); `#signin-entry-routes` with the `/agent-signin` link; `#auth-error` / `#auth-link-error` `role="alert"` nodes |
| `index.html` `#invitation-signin` / `#invitation-methods`, `#join-account-auth` / `#join-account-methods` | The invitation and join-dialog hosts of the same sign-in component (`#invitation-email` "Continue with email" opens it) |
| `src/auth-signin-ui.js` (600 lines) | The component: `createAuthSigninUI(...)`. State: `emailMethod` (`password`/`magic`/`forgot`/`reset`), `passwordMode` (`login`/`signup`), `passwordRecovery` (bool, see §2), `magicPhase`, `resetPhase`, `mailConfigured`, `pendingLink`, `pendingTerms`. Views: `password-login/signup`, `forgot`, `reset-request/sent/form`, `magic-sent`, `account-switch`, `welcome`, `terms`. Copy is not inline: it renders `uiText("signin.copy.*")` fragments from `strings/en.js` |
| `strings/en.js` | The actual markup: `signin.copy.011` (merged password form), `signin.copy.035` ("Email me a sign-in link", the post-401 offer), `signin.magic.action` / `signin.magic.instead`, `signin.login-options` ("Forgot password?"), `signin.passkey.action`, `signin.copy.007–.010` (forgot/reset) |
| `src/signin-entry.js` | Entry host: mounts the UI into `#auth-signin-ui`, wires `loadSigninOptions` (`GET /api/auth/signin-options`), `onProviderCapabilities` (hides unconfigured OAuth anchors), restore/enter-workspace, lazy agent UI |
| `src/signin-navigation.js` | History: pushes `roomSigninView` state for auxiliary views, re-parents `#auth-signin-ui` between `#signin-controller` and `#email-auth-panel`, `popstate` → `showView(...)`, provider-anchor painting |
| `src/password-auth.mjs`, `server/routes/auth.mjs`, `server/routes/signin-options.mjs` | Server doors the UI calls: `/api/auth/password/login|signup`, `/api/auth/magic/request|consume`, `/api/auth/password/reset/request|consume`, `/api/auth/passkey/authenticate/options|finish`, `/api/auth/signin-options`. **No server change is instructed in this pack** (see §4, step 0 fence) |
| `join.html` + `src/join.js` | The invite-redemption page; its "Log in" / "Back to sign-in" links land on this piece. In scope only as a *referrer*: do not redesign `join.html` here |
| Tests / gates | `tests/auth-signin-ui.test.js` (unit, incl. the post-401 offer matrix at ~L445); browser scripts `scripts/password-reset-browser-check.mjs`, `scripts/mobile-signin-history-browser-check.mjs`, `scripts/invitation-check.mjs`, `scripts/login-polish-browser-check.mjs`, `scripts/auth-journeys-browser-check.mjs`, `scripts/auth-return-browser-check.mjs`, `scripts/accountless-join-restore-browser-check.mjs`; visual baseline `scripts/visual-regression-baselines/login-auth-panel.png`; CI `.github/workflows/test.yml` shards 1–6 + `scripts/ci-changes.mjs` classifier |

**Not paused, no fork.** This piece does not touch the paused redesign
typed-object phase, and neither of John's two pending decisions (verified-delivery
vocabulary; sponsor human surface) is in this piece. No FORK.

## 2. Current state

### 2.1 The {browser} failure class — what happened, exactly (executed evidence)

Source: `~/workspace/wave-2026-10-27-keep-going/SYNTHESIS.md` §Cluster A and
`lanes/A/A-SUMMARY.md`, `A1.md`–`A7.md`, `A-STATE.md` (executed local Playwright
brackets at pinned SHAs + one direct-get-verified hosted CI generation).

- PR **#5090**, merge `cda3ccf369` (2026-10-27T23:11Z), breaking commit
  `4be5fac19a` "Simplify sign-in and offer email recovery after invalid
  credentials", changed **product behaviour** in `src/auth-signin-ui.js`:
  email/magic recovery is offered only after a `401 invalid_credentials`
  (new `passwordRecovery` flag), the blank-password link request was removed,
  password became required, and the panel's initial render shrank.
- The browser fixtures and the visual baseline on that main still encoded the
  **ungated** flow, so four of six browser shards failed deterministically on
  every settle-pass-20 composed generation (bases `cda3ccf369`/`c802a361df`):
  shard 3/6 password-reset — both "quieter secondary magic-link action" tests,
  magic-link locator timeouts at 390px and 1280px (pre-#5090 tree `31fad263`
  passes 12/12; post-#5090 10/12); shard 4/6 mobile-signin —
  `locator.tap` timeout on `[data-email-method="magic"]` after Back navigation;
  shard 5/6 visual — `login-auth-panel` 29,044 px = 2.84% vs the 1.00% budget in
  CI (24,576 px local), bit-identical across unrelated PR diffs because both
  the capture and the stale baseline live in the shared base tree (A5);
  shard 6/6 invitation — 2 pass / 7 fail / 1 cancelled, magic-code locator
  timeouts in `#invitation-methods [data-signin-form="magic-code"]`.
- Ten unrelated bound PRs were parked `REBIND-WITH-NAMED-RED {browser}`
  (bindings file, e.g. #5061/#5055/#5060/#5063/#5067/#5069/#5070/#5072/#5091/#5071)
  purely because they composed on that base. Main's own push runs at the time
  never executed the shards (A5: empty matrix), so nothing on main flagged it.
- **Cure #5092 was fixtures-only.** Merge `5c1a88599a` (2026-10-28T01:08Z, inside
  an alarm-titled release PR) carried `2daf61f1a0` (login baseline re-shot),
  `f088502853` and `1220fdef94` (fixtures taught to *earn* recovery
  contextually): `scripts/password-reset-browser-check.mjs` (+5/−9, the two
  tests inverted to "direct reset form **hides unearned** magic-link recovery"),
  `scripts/mobile-signin-history-browser-check.mjs` (+8), `scripts/invitation-check.mjs`
  (+27/−9), `scripts/login-polish-browser-check.mjs` (+3), and the baseline PNG.
  **Zero product-code changes** (A7 seam table). Discharge was then verified:
  local shards 3/6 12/12, 4/6 1/1, 6/6 12/12 at main `5458e405`, and hosted run
  **40618878289** (head `94f275e659`, tree contains #5092) all six shards +
  aggregator SUCCESS (A9).

**Therefore: the red is cured and must not be re-cured. What remains — and what
this pack commissions — is the product-side hardening #5092 deliberately did
not do (§2.2). Do not file a duplicate fixture PR.**

### 2.2 The product-side hardening that remains (verified at `aaa749065a`)

Each item is read from the archived tree above, not inferred:

1. **Recovery is undiscoverable until you have already failed.** In
   `panelHtml()` the merged password form (`signin.copy.011`) includes the
   "Email me a sign-in link" button (`signin.copy.035`, fragmentD) only when
   `!signup && mailConfigured && passwordRecovery`; the password input is
   `required` unless `mailConfigured && passwordRecovery`. `passwordRecovery`
   is set in exactly one place: the `/api/auth/password/login` catch, on
   `error.status === 401 && error.code === "invalid_credentials"` for the
   *same* generation/session. A user who has no password (passwordless or
   invited account), cannot remember it, or simply prefers a link must first
   submit a wrong/blank credential and absorb an error before the link path
   exists in the DOM. The only pre-failure recovery affordance is
   "Forgot password?" (`signin.login-options`), which goes to password
   *reset* — a heavier, different journey.
2. **The gating buys no enumeration protection, on the code's own account.**
   `requestEmailLink()`'s comment states the `/api/auth/magic/request`
   endpoint "answers uniformly whether or not the address has an account, so
   nothing leaks about which addresses are registered", and the login error
   itself is already uniform ("Unknown email and wrong password have the same
   uniform response"). Hiding the *button* until after a 401 therefore protects
   nothing the endpoints do not already protect; it only taxes the honest user.
   (If the implementer finds a server-side reason this is wrong, that is a
   stop-and-report event — §4 step 0 — not a licence to keep the gate silently.)
3. **The invitation path inherits the dead end.** An invitee who clicks
   "Continue with email" (`#invitation-email` → `#invitation-methods`, same
   component) and has no password yet faces the same earned-recovery state
   machine. #5092 fixed this only in the *fixture*, which now "drives
   contextual email recovery" (A4/A7) — i.e. the test performs a credential
   failure on behalf of a user who may have no credential to fail with. No
   product path was added.
4. **Earned recovery is destroyed by an email edit, by direct DOM surgery.**
   `onInput`: if the email field's value differs from `passwordEmail` while
   `passwordRecovery` is set, the handler sets `passwordRecovery = false` and
   then *imperatively removes* the offer nodes
   (`[name="method"][value="email"], [data-email-method="magic"]`) and sets
   `passwordField.required = true` — bypassing `render()`. Any later repaint,
   host re-parenting (`signin-navigation.js` moves `#auth-signin-ui` between
   containers on every view change), or capability reload
   (`loadSigninCapabilities()` re-renders and restores values/focus by hand)
   is a second, divergent source of truth for the same state. This is the
   exact shape that made shard 4/6 fail after Back navigation, and it is still
   in the product.
5. **History does not carry recovery context.** `signin-navigation.js`
   persists only `roomSigninView` in `history.state`; `popstate` replays
   `showView(view)`. Nothing records that recovery was earned for a given
   email, so Back/Forward across `forgot`/`reset-*`/`password-login` depends
   on the in-memory flag surviving untouched — the fragile leg #5092's
   mobile-signin fixture had to be taught to re-earn (+8 lines).
6. **Capability honesty has a race.** `mailConfigured` defaults to `true`
   ("fail-open to the historical behavior") and is only corrected when
   `loadSigninCapabilities()` resolves with `providers.mail.configured === false`.
   The forgot/reset renders (`signin.copy.007`, `signin.copy.010`) consult
   `mailConfigured && passwordRecovery` at render time, so a slow
   `/api/auth/signin-options` can paint offers the deployment cannot serve,
   then remove them — a layout/visual-baseline hazard of the same family as
   shard 5/6. (§8.1 rule already in the code's comments: never offer a method
   the deployment cannot serve.)
7. **Accessibility defects on this surface, executed.** UT2 lane 10-04
   (screen-reader, `~/workspace/wave-2026-10-27-user-testing-2/lanes/10-04-hostile-screen-reader/REPORT.md` §`/`):
   the password textbox's accessible name is **"Password Show password"**
   because the visibility toggle sits inside the wrapping `<label>` in
   `signin.copy.011`; the signed-out landing exposes no `main`/`banner`/
   `navigation` landmarks in the AX tree (only region "PROJECT ROOM" + form);
   the skip link targets `#connection-status`, a `role="status"` paragraph.
   UT2 lane 10-01 (rendered mobile): sign-in panel itself is healthy
   (rect y=37 at 360px — wave-1's displaced-panel suspicion M4 is REFUTED,
   do not re-chase it); primary targets ≥44px on this surface.

### 2.3 What UT1/UT2 say about the door around this piece (context, not scope creep)

- UT2 Pod 1 replication (`wave-2026-10-27-user-testing-2/SYNTHESIS.md` §1):
  door composition **5 BROKEN / 2 DEGRADED / 4 WORKS**, identical to UT1.
  This piece's rows: row 2 sign-in thresholds **WORKS** (lane 01-01: Google
  reaches the provider threshold, fresh S256 PKCE + state, correct scopes);
  row 4 passkey **WORKS to threshold** and row 3 GitHub **BROKEN-as-unconfigured**
  (lane 01-02: `signin-options` reports `github.configured:false`; `/api/auth/github/start`
  honestly 503s in both JSON and HTML shapes and the served page carries no
  dead anchor — the *method* is absent, its presentation is already cured;
  configuring GitHub OAuth is an operator credential act, not this pack);
  row 5 email/magic **DEGRADED (S2)** — delivery and redemption "remain
  unprovable by a public walk", unchanged across both waves. Note those UT2
  walks ran on production builds `e8ce094d`/`b4fe1f98`, i.e. **pre-#5090**:
  the initial render they saw still had the ungated offer (10-04 lists
  "Email me a sign-in link" among the landing's 11 controls). No UT walk has
  ever graded the post-#5090 gated flow. UNVERIFIED: how the gated flow
  grades for a real stranger — the acceptance walk in §5 closes this.
- Production entry instability is real but is not this piece's code defect:
  Cluster A lane A8 (~19:31–19:45 PT 2026-10-27, build `ca37fee4`): app-door
  `/join` 200 in 15.0s with `/api/ready` 503; entry door `/join` and
  `/api/ready` timed out >20s; `/api/version` flapped 404→200; re-probes
  minutes later answered in ~2–4s. Production still runs that pre-#5090
  build; deploying current main is the seat/operator's act (§5, post-deploy leg).

## 3. What fantastic means

A stranger (or a returning user who has forgotten everything) can get in
**without first being punished by an error**, on every host of the component,
and the test suite can never again drift a full release behind the product
on this surface. Concrete end state:

- **Zero failed attempts required.** On the initial `password-login` render,
  with mail configured, a visible secondary affordance — "Email me a sign-in
  link" — is present in the DOM, reachable in 1 click, at 390px and 1280px,
  in the landing panel, the invitation flow, and the join-account dialog.
  Requesting a link is: enter email (1 field) → 1 click → `magic-sent` view.
  No password field interaction, no 401, no error text seen.
- **Uniformity preserved.** The link request, the post-401 prominence, and all
  error copy stay enumeration-uniform: same response shape/text/timing class
  for registered and unregistered addresses, exactly as
  `/api/auth/magic/request` and the uniform `invalid_credentials` response
  already behave. The post-401 state may *emphasise* the link option; it may
  no longer *create* it.
- **One state machine, rendered.** Recovery/link state is ordinary component
  state consumed by `render()`; no handler mutates another view's DOM nodes
  directly. Editing the email, switching login↔signup, Back/Forward, a
  capability reload, and a host re-parent all produce the same DOM a fresh
  `render()` of that state would produce — asserted, not hoped.
- **Invitation parity.** An invitee with no password completes
  email → link/code → intended room, in a fresh tab and in place, without a
  credential-failure detour (the journey `invitation-check.mjs` already names:
  "delivered email link opens its intended invitation in a fresh browser tab").
- **No phantom offers.** With mail unconfigured, no email-link or reset-by-email
  offer is ever painted — including during the window before
  `/api/auth/signin-options` resolves (verified with a deliberately delayed
  options response). With mail configured, no offer appears-then-vanishes.
- **Numbers that prove it:** browser shards 3/6, 4/6, 5/6, 6/6 green in one
  hosted generation at the PR's exact head, with password-reset 12/12,
  mobile-signin-history passing, invitation-check 12/12; visual
  `login-auth-panel` diff ≤1.00% budget against a baseline shipped *in the
  same PR*; unit suite `tests/auth-signin-ui.test.js` green including the new
  pre-401 cases; primary tap targets ≥44px, inline text actions ≥24px;
  password field's accessible name is exactly "Password"; time from panel
  paint to link-request submit adds **zero** network round-trips beyond the
  existing single `GET /api/auth/signin-options`.
- **Exemplars worth matching (shape, not pixels):** Slack's magic-link
  sign-in (email first, link offered as a primary alternative, not a reward
  for failing); GitHub's pre-auth "Forgot password?" recovery entry (visible
  before any attempt); Linear's email-link door (one field, one action, no
  password wall). In-product exemplar: this repo's own reset path — already
  reachable pre-401 via "Forgot password?" — proves the house accepts
  pre-failure recovery for reset; magic gets the same courtesy.

## 4. The instruction

Target tree: **main `aaa749065a`** (branch from it; production deploys later —
§5). Client stays vanilla JS; this is convergence work on the existing
component, not the T3 door rebuild. Estimated shape: one client PR, no server
PR (step 0 fence), plus its same-PR test/baseline companions.

**Step 0 — Fences and pre-reads (do not skip).**
Re-read `src/auth-signin-ui.js` at your base, `tests/auth-signin-ui.test.js`
(the ~L445 matrix pinning exactly which statuses/codes earn the offer), and
Cluster A lanes A1–A7. Confirm no bound PR already covers this hardening:
checked in the bindings file
(`~/workspace/goals/uuriko-project-room-bug-fix-program/hidden_files/landing-watch-bindings.json`)
— #5090/#5092 are merged and unbound; the ten `{browser}` victims (#5061 et al.)
are other pieces' PRs whose red this pack's predecessor caused; bound #5024
(Enter-key activation) is a different a11y leg and must not be duplicated.
If you find a server-side, non-uniformity reason the magic offer must stay
gated, **stop, file that evidence, and do not proceed past this step** — the
rest of the pack rests on §2.2 item 2's code-verified uniformity.

**Step 1 — Restore the pre-failure link affordance (product).**
In `src/auth-signin-ui.js` `panelHtml()` (password branch) and
`strings/en.js` (`signin.copy.011` fragment slots / `signin.copy.035`):
when `!signup && mailConfigured`, render "Email me a sign-in link" in the
initial `password-login` view, styled as the quieter secondary action it was
pre-#5090 (the old test name is the spec: "a quieter secondary magic-link
action"), below/secondary to the primary Log in button, alongside
"Forgot password?". Keep the post-401 rendering at equal or greater
prominence. Signup view: no link offer (unchanged).

**Step 2 — Make blank-password submit a link request again, honestly.**
With mail configured and the email field valid, submitting the merged form
with an empty password performs the link request (`requestEmailLink()`),
exactly as the post-401 `linkRequest` branch already does — i.e. delete the
`passwordRecovery` precondition from `linkRequest`, and drop the password
input's `required` in login mode when mail is configured (keep it in signup
mode, and keep the ≥10-char signup rule). Preserve the existing comment's
contract: a link request does **not** consult `beforeSignIn`. With mail
unconfigured, an empty password keeps today's explicit status
(`signin.copy.037`-class), never a silent no-op. A non-empty wrong password
still produces the uniform `invalid_credentials` error and now additionally
emphasises (does not create) the link/reset options.

**Step 3 — De-earn the state machine (the core hardening).**
Remove `passwordRecovery` as a *permission* for recovery. If a boolean is
still needed for post-401 emphasis, name it for what it is (e.g.
`recoveryEmphasised`) and make it affect styling/order only. Then:
(a) rewrite `onInput` so an email edit changes state and calls `render()`
    (preserving email value, password value, focus and selection the way
    `loadSigninCapabilities()` already does) — the imperative
    `offer.remove()` / `passwordField.required = true` surgery is deleted;
(b) apply the same state-driven treatment in the `forgot` and `reset-request`
    renders (`signin.copy.007`, `signin.copy.010` fragments
    `signin.magic.action`, `signin.magic.instead`): the magic alternative is
    present whenever `mailConfigured`, not only when earned;
(c) `clear()`, mode switches, and `showView()` transitions must leave the
    component in a state whose next `render()` is complete and correct —
    add no new module-level flags without a `clear()` entry.

**Step 4 — History/Back correctness.**
In `src/signin-navigation.js` + the component's `showView`/`back()`:
Back from `reset-request`/`forgot` and Forward again must land on a
`password-login` view that still shows the link affordance for the preserved
email, with the email (and any typed password, per the existing B-1 #3771
preservation rule) intact. Since recovery is no longer earned, no recovery
flag needs serialising into `history.state`; assert that in tests rather
than adding state. Do not change the `roomSigninView` history contract's
shape (other hosts consume it).

**Step 5 — Invitation and join hosts get the same door.**
Verify — by executed browser walk, not code reading — that the component as
mounted in `#invitation-methods` and `#join-account-methods` (`src/app.js`
hosts; the component itself is shared) exposes steps 1–2 identically, and
that an invitee can go email → request link/code → redeem → intended room
without ever submitting a password. Fix any host wiring (mount timing,
`onMagicLinkRequest` returnTo, re-parenting into `#invitation-methods`)
that prevents it; do not fork the component per host.

**Step 6 — Capability race.**
Gate the first paint of any mail-dependent offer on the signin-options
answer *without* delaying the password form: render the form immediately
with the mail-dependent secondary actions in a reserved, non-interactive
placeholder (or omitted), then `render()` once on resolution. The invariant
to meet is §3's "no phantom offers": with `configured:false` nothing is
ever painted; with `configured:true` nothing that was painted disappears.
Keep the fail-open default for a *failed* options load (existing comment's
contract) — the race fix governs the pending window, not the failure case.
Apply the same rule to the OAuth anchors' existing `onProviderCapabilities`
painting if your change touches it; do not redesign it.

**Step 7 — Accessibility micro-fixes on this surface only.**
In `signin.copy.011`: take the `data-password-visibility` toggle out of the
password `<label>`'s text (label the input, place the toggle as a sibling
control with its existing `aria-label="Show password"`), so the textbox's
accessible name is "Password". Confirm the rendered panel exposes a `main`
or named region landmark for the signed-out view and that all controls on
the initial render have non-empty accessible names (10-04's snapshot is the
baseline: 11 named controls, zero unnamed — keep it at zero while adding
the link action). Do not take on the wider template-family a11y batch
(bound #5024 and UT2 candidate 20 own neighbouring legs).

**Step 8 — Tests and baseline, in the SAME PR (this is the {browser} lesson).**
- `tests/auth-signin-ui.test.js`: invert the #5092-era expectations —
  initial render (mail configured) **contains** `[data-email-method="magic"]` /
  `name="method" value="email"` before any submit; no offer in signup view;
  no offer when mail is positively unconfigured (existing #3341 test stays);
  blank-password submit calls `/api/auth/magic/request` and lands on
  `magic-sent`; the ~L445 status/code matrix now asserts *emphasis*, and
  that 429/503/no-status failures neither create nor destroy the affordance;
  email-edit-during-recovery re-renders instead of node removal (assert the
  offer's presence/absence is a function of state after a forced `render()`).
- Browser scripts: restore/replace the pre-#5090 password-reset tests
  ("direct reset form retains a quieter secondary magic-link action",
  1280px + 390px) in `scripts/password-reset-browser-check.mjs`;
  simplify `scripts/mobile-signin-history-browser-check.mjs` and
  `scripts/invitation-check.mjs` to stop *earning* recovery contextually —
  the fixtures must drive the door the way a passwordless user does;
  keep `scripts/login-polish-browser-check.mjs` green (update its gated-offer
  assertions to the new initial-render contract).
- Visual: re-shoot `scripts/visual-regression-baselines/login-auth-panel.png`
  from CI-canonical rendering (never a local renderer — Cluster A A3/A7:
  local counts drift by ~11,078px on every tree) and include it in this PR.
  A PR that changes this panel without its baseline is incomplete by
  definition; say so in the PR body.
- Failing-first discipline: on the pristine base, your new unit + browser
  assertions must fail for the §2.2 reasons (no initial offer; blank submit
  blocked; invitation fixture needs a credential failure) and pass at your
  head. Record both runs in the PR body.

**Step 9 — Filing discipline.**
One PR, `ready-to-land` label added once before expecting heavy CI (unlabeled
PR CI reports designed `skipped`, per the CI label gate). Non-money,
non-schema, non-shared-core: ordinary Rules v2 queue, batchable; evidence
binds to the tree SHA (Ruling 41). The implementer never merges. PR body
must state: base `aaa749065a` (or the main tip at filing, named), the
failing-first evidence, and the registration-sweep result (§5).

**Explicit non-goals.** No server route, error-code, or auth-semantics change
(uniformity, rate limits, token lifetimes, `invalid_credentials` contract all
untouched). No configuring GitHub/Google OAuth (operator credential acts).
No `/join` or `/api/ready` latency work (A8 flapping is deploy/infrastructure;
§5 verifies it post-deploy, this PR does not chase it). No agent sign-in
redesign, no landing-hero/discovery work (mobile landing being sign-in-only
is the door/landing pack's piece), no T3 rebuild, no React. Do not re-file
#5092's fixture alignment, and do not re-chase the refuted M4 panel-displacement
suspicion.

## 5. Acceptance

Coordinator/Jill runs these at the PR's exact head; all must pass. Evidence
is read at the source (API/direct get), never from the PR body's claims alone.

**Executed checks**
1. Unit: `node --test tests/auth-signin-ui.test.js` — green, including the
   new pre-401, blank-submit, unconfigured-mail, and email-edit cases (§4 step 8).
   Plus `CI=1 npm run check` (the diff touches `src/**`; `verify:affected`
   alone does not select check's later stages) and `npm run verify:affected`.
2. Browser, hosted CI at the exact head (labelled generation; read the run by
   direct get): shards **3/6, 4/6, 5/6, 6/6 all SUCCESS** and the `browser`
   aggregator SUCCESS — password-reset 12/12, mobile-signin-history pass,
   invitation-check 12/12, visual `login-auth-panel` ≤1.00% vs the baseline
   shipped in the same PR. A generation whose `changes` job classified this
   diff `browser=false` does not count: at `aaa749065a`,
   `scripts/ci-changes.mjs` classifies any `src/**` file as browser-relevant —
   verify the run's `changes` output says `browser=true`, and verify one
   **main-push** generation after landing also executes the shards
   (`test.yml` at `aaa749065a` declares push-to-main full scope,
   `CI_BROWSER_SCOPE=full`; Cluster A's "main never runs the shards" was
   true of the #5090-era tree — if it has regressed, that is a named red
   against this acceptance, not a pass).
3. Stranger walk (the walk UT never ran on the gated flow), executed against
   a local/staging build of the head, at 390px and 1280px, in all three
   hosts (`/`, invitation, join dialog): (a) initial render shows
   "Email me a sign-in link" with zero submits; (b) email + blank-password
   submit → link requested, `magic-sent` shown, no error role=alert text;
   (c) wrong password → uniform error + link/reset still present;
   (d) edit the email after (c) → affordance follows the new state after a
   forced repaint, no orphan nodes; (e) Back from Forgot-password → link
   affordance and typed values intact; (f) with signin-options stubbed
   `mail.configured:false` and delayed 2s → no mail offer is painted at
   any sampled frame; (g) invited, passwordless account: email → code →
   intended room, no password ever submitted.
4. A11y spot-check (AX snapshot of `/`, signed out): password textbox
   accessible name == "Password"; zero unnamed controls; primary targets
   ≥44px, the link action ≥24px; exactly one `role="alert"` visible at rest (empty).
5. Post-deploy leg (seat/operator act, verified by John's Tab — not a merge
   blocker for this PR, but the pack is not "done" until read): after the
   next production deploy, `GET /api/version` on both doors names a
   sourceRevision containing this PR; the §5.3 walk (a)–(c) re-run against
   production; `/join` and `/api/ready` answer 200/ready on three
   consecutive probes ≥1 min apart (A8's flapping is the comparison point).

**Registration sweep** (`node ~/workspace/fleet-tools/registration-sweep.mjs --pr <n>`,
must exit clean; expected dispositions):
- Runtime-package closure — **SATISFIED, verify**: `src/auth-signin-ui.js`,
  `src/signin-entry.js`, `src/signin-navigation.js` are already in
  `scripts/runtime-package.mjs`'s allowlist at `aaa749065a` (auth-signin-ui
  also as an optional push). Applies only if the PR adds/imports a new
  `src/**` module — then allowlist + candidate-runtime fixture + closure
  test in the same diff, or MISSING blocks.
- Error-code catalogue, both copies — **n/a**: no new/removed error code;
  if the diff adds one, this flips to REQUIRED (catalogue row +
  `node scripts/skills-sync.mjs` byte-identical mirror).
- Route triple — **n/a**: no new route; `/api/auth/*` and
  `/api/auth/signin-options` are unchanged. Any route touch flips it to
  REQUIRED (table + OpenAPI operation + `x-room-permission` + parity note).
- Harness copy sets — **REQUIRED-review**: the browser scripts and
  `tests/auth-signin-ui.test.js` are themselves the harness; if the PR adds
  a helper imported by any browser check, it must be wired into that
  check's copy/re-point set in the same diff.
- Store registries — **n/a**: no new table or store.
- Generated/mirrored artifacts — **REQUIRED**: `strings/en.js` changes must
  regenerate/keep in sync its generated companions (`src/strings.js` /
  `strings/en.json` per `scripts/build-ui-strings.mjs` — run the builder,
  don't hand-edit a mirror); the visual baseline PNG (§4 step 8) is a
  generated artifact and ships in the same diff; no MCP-catalog or
  EVENT_TYPES growth (if any appears, its snapshot + count pins flip to REQUIRED).
- Diff hygiene — if >300 changed lines, the PR body carries
  `## Large diff justification:`.
- Refusal-shape step — **n/a** unless a refusal/error shape changes; the
  uniform `invalid_credentials` shape must not change.

## 6. Routing

- **Implementer: Claude** — this is a client surface (vanilla-JS component,
  strings, visual baseline, browser fixtures), which is his lane (client
  surfaces, design tokens, his own PR train), and the delicate part is
  render/state craftsmanship in `auth-signin-ui.js`, not server semantics.
  Fallback: a Jill-fleet cure lane if Claude's train is saturated; it then
  files under the same acceptance and also never merges.
- **Not Codex** for the build (his capacity is server/core and landings from
  John's Mac), but **Codex is the named reviewer** for the step-0 uniformity
  fence: one `room_request_reply` to Codex's room member with a concrete ask,
  the workItemId for this pack, and the expected result ("confirm or refute,
  from `server/routes/auth.mjs`, that `/api/auth/magic/request` is uniform
  for registered vs unregistered addresses") — all Codex utilisation inside
  Project Room, per the settled channel rule. A refutation stops the lane
  at step 0.
- **Landing: Grok Bot's seat**, ordinary batchable queue (non-money,
  non-schema), green at the composed head under Ruling 41 tree-binding;
  the ten `{browser}` victim bindings' discharge (citing hosted run
  40618878289) is a separate seat act and is not this PR's cargo.
- **Verification: Fo** owns the browser-shard evidence read (§5 item 2,
  responsive duty — 390px + 1280px legs), **John's Tab** owns the
  post-deploy production walk (§5 item 5), and **Jill** runs the acceptance
  in §5 and the registration sweep before citing the PR onward.
- **Handover channel:** file the PR, post its LAND-READY record (PR number,
  head SHA, failing-first + sweep summary) in the Project Room coordination
  room; the room record, not a chat relay, is the handover.
