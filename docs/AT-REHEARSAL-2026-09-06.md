# AT rehearsal dry-run evidence pack

- **Date:** 2026-09-06 (written 2026-09-06 09:15 PT)
- **Task:** Project Room backlog #25 - AT rehearsal on integrated Phase 0 build
- **Repo:** Uuriko/project-room
- **Frozen tip head:** `1d18471974243b3ffcd77c77124171f1351a4e25`
- **Frozen tip tree:** `e6cd77ebbdbe5f315d9ebb0326da68ffb352d069`
- **Branch (untouched):** `instinct/integration-2026-09-06` (no merge, no source patches)
- **Source procedure:** `docs/MANUAL-AT.md` (present on tip)
- **Runtime:** Node `v24.19.0` (engines: `>=24.19.0`)
- **Local notes:** local rehearsal logs retained privately. Phase 0 working tree left clean.

This is a **dry-run / rehearsal** pack. Automatable setup checks ran against the local pilot.
Rows that require screen-reader speech/caret/focus stay **UNVERIFIED**. No PR #8 changes.

---

## 1. Automated suite results

| Suite | Pass | Fail | Tests | RC | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| node tests (`node --test`) | 67 | 0 | 67 | 0 | **PASS** |
| contract check (`scripts/check.mjs`) | 67 | 0 | 67 | 0 | **PASS** |
| browser-check | 4 | 0 | 4 | 0 | **PASS** |
| disclosure-check | 1 | 0 | 1 | 0 | **PASS** |
| quiet-focus-a34-check | 2 | 0 | 2 | 0 | **PASS** |
| quiet-focus-final-check | 3 | 0 | 3 | 0 | **PASS** |

**Combined browser/a11y-adjacent scripts:** 10/10 pass. Domain/contract: 67/0.

Logs: local rehearsal logs retained privately.

No FAIL in automated suites. No source bugs found that block this tip; none patched.

---

## 2. MANUAL-AT.md - every procedure / row

| ID | MANUAL-AT procedure | Class | Status this rehearsal |
| --- | --- | --- | --- |
| M1 | Environment: Node >= 24.19 | Automatable setup | **PASS** |
| M2 | Environment: exact origin http://127.0.0.1:4173 (not localhost) | Automatable setup | **PASS** |
| M3 | Environment: Host/Origin checks intact | Automatable setup | **PASS** |
| M4 | Session isolation: separate browser profiles for owner + Maya | Partial + human | Cookie/API **PASS**; identity speech **UNVERIFIED** |
| M5 | Confirm Maya displayed identity before two-person rows | Human AT | **UNVERIFIED** |
| M6 | One live-announcement owner (composer-local vs page-level) | DOM automatable + speech human | DOM **PASS**; speech **UNVERIFIED** |
| M7 | Send/retry via Ctrl+Enter with composer focused (Codex) | Partial + human | DOM suites **PASS**; speech **UNVERIFIED** |
| M8 | Loss-before-restart: window starts at server stop; exactly one loss + one connected (Codex) | Human AT | **UNVERIFIED** |
| M9 | Measure speech, caret, focus on this exact SHA | Human AT | **UNVERIFIED** |

### Codex procedure corrections (binding for the human pass)

1. **Ctrl+Enter for failed send / retry** - With the composer focused, use Ctrl+Enter (Cmd+Enter on macOS) to send and to retry after a failed send. Enter alone inserts a newline.
2. **Loss-before-restart** - Stop the room service first; observation window starts then. Pass = exactly one loss/interrupted/reconnecting announcement and, after restart, exactly one connected announcement.
3. **Separate browser profiles for owner / Maya** - Two windows in one profile share `room_session`. Use separate profiles or isolated contexts. Confirm Maya identity before two-person rows. Keep keys private.

---

## 3. Automatable setup checks (live local server)

Server printed origin: `http://127.0.0.1:4173`. Evidence retained in local rehearsal logs.

| Check | Status | Command / method | Detail |
| --- | --- | --- | --- |
| Node >= 24.19 | **PASS** | `node -v` (Node 24.19 toolchain) | runtime v24.19.0; engines require >=24.19.0 |
| origin 127.0.0.1:4173 health | **PASS** | `curl -sS http://127.0.0.1:4173/api/health` | GET http://127.0.0.1:4173/api/health -> 200 `{"status":"ok","mode":"single-node-pilot"}` |
| Host mismatch denied | **PASS** | `curl -sS -H 'Host: localhost:4173' http://127.0.0.1:4173/api/health` | GET http://127.0.0.1:4173/api/health Host=localhost:4173 -> 403 `{"error":{"code":"host_denied","message":"Unexpected host"}}` |
| Origin mismatch denied | **PASS** | `curl -sS -H 'Origin: http://localhost:4173' -H 'Content-Type: application/json' -d '{accessKey:...}' http://127.0.0.1:4173/api/session` | POST /api/session Origin=http://localhost:4173 -> 403 `{"error":{"code":"origin_denied","message":"Request origin is not allowed"}}` |
| session create on exact origin | **PASS** | `curl -sS -c jar -H 'Origin: http://127.0.0.1:4173' -H 'Content-Type: application/json' -d '{accessKey:owner}' http://127.0.0.1:4173/api/session` | POST /api/session Origin=http://127.0.0.1:4173 -> 201 memberId=owner cookies=['room_session'] |
| session isolation separate contexts | **PASS** | `two CookieJars / browser profiles: POST /api/session each, then GET /api/session` | owner jar memberId=owner; maya jar memberId=maya; cookies distinct=True |
| shared profile overwrites room_session (expected hazard) | **PASS** | `single CookieJar sequential logins` | after owner then maya login in ONE jar, GET /api/session -> memberId=maya (confirms separate-profiles requirement) |
| one live-announcement owner (composer-local vs page-level) | **PASS** | `inspect index.html+src/app.js; curl http://127.0.0.1:4173/` | index has #composer-status+#status; app.js routes send failure to local form-status only; served / status=200 |
| localhost URL rejected by Host check | **PASS** | `curl -sS http://localhost:4173/api/health` | GET http://localhost:4173/api/health -> 403 `{"error":{"code":"host_denied","message":"Unexpected host"}}` |

Browser suite also asserts failure text lands in `#composer-status` and not `#status`.

---

## 4. Human AT rows - UNVERIFIED (one clean VoiceOver or NVDA pass)

Record commit SHA on every table: `1d18471974243b3ffcd77c77124171f1351a4e25`.

### Prep (human)

1. Node >= 24.19. Install deps. Provision owner + Maya keys locally. Keep keys private.
2. Start service. Use **only** the printed origin (default `http://127.0.0.1:4173`). Do **not** open `http://localhost:4173`.
3. Create **two browser profiles**: Profile A = owner, Profile B = Maya.
4. Enable VoiceOver (macOS) or NVDA (Windows). Measure speech, caret, and focus.
5. Sign in both profiles. Before any two-person row: confirm Profile B shows identity **Maya** (M5).

### H1 - Single live announcement on failed send (M6 + speech)

**Status:** UNVERIFIED

Steps:
1. Profile A: open room, focus `#message-input`, type a draft; note caret.
2. Simulate send failure (DevTools block POST commands, or equivalent).
3. With composer focused, press **Ctrl+Enter**.
4. Pass (speech): failure announced **exactly once** from composer-local status (includes `Draft kept; press Send to retry.`). Page-level `#status` must stay silent for that event.
5. Draft + caret remain; Send is the retry. Restore network; **Ctrl+Enter** to retry; draft clears only after ack; no double-speak.

### H2 - Two-person identity + no shared cookie (M4/M5)

**Status:** UNVERIFIED (API isolation PASS in section 3; human display/speech pending)

Steps:
1. Separate profiles: A=owner, B=Maya.
2. Maya posts from B; A sees author Maya; B still shows self as Maya (speech + visible).
3. Fail if a shared-profile second sign-in switches the intended person.

### H3 - Loss-before-restart (M8) - Codex correction

**Status:** UNVERIFIED

Steps:
1. Profile A connected with Connected status; start listening.
2. **Stop the server** (observation window starts now).
3. Count loss / reconnecting / interrupted announcements.
4. Restart service on the same origin; wait for reconnect.
5. Count connected announcements.
6. Pass: exactly **one** loss (or equivalent) and exactly **one** connected. Fail on silence, duplicates, or silent return to Connected.

### H4 - Background update: caret + focus (M9)

**Status:** UNVERIFIED

Steps:
1. Profile A: known selection in composer draft; optionally focus an open presence disclosure summary.
2. Profile B (Maya) sends a message (background snapshot).
3. Pass: AT does not claim focus jumped; caret/selection and disclosure focus remain (match disclosure-check, measured with AT).

### H5 - Narrow / keyboard composer (Ctrl+Enter vs Enter)

**Status:** UNVERIFIED for speech; DOM covered by a34-check

Steps:
1. Narrow viewport (~390px) or zoomed UI; focus composer.
2. Enter inserts newline; Ctrl+Enter sends.
3. Confirm AT announces send outcome once; focus remains usable.

---

## 5. Related automated coverage (not a substitute for H1-H5)

| Concern | Automated witness | Human still needed? |
| --- | --- | --- |
| Composer-local failure, no `#status` duplicate | `scripts/browser-check.mjs` | Yes - speech |
| Ctrl+Enter send / retry | `scripts/quiet-focus-a34-check.mjs`, browser-check | Yes - speech |
| Disclosure open + focus across snapshot | `scripts/disclosure-check.mjs` | Yes - speech/focus |
| Post-connect stream loss label | `scripts/quiet-focus-final-check.mjs` | Yes - H3 announcement count |
| Reflow at 390px / 200%-zoom-equivalent | quiet-focus-final-check | Optional device/AT zoom |

---

## 6. Bugs / blockers found during rehearsal

| Item | Severity | Notes |
| --- | --- | --- |
| None on frozen tip | - | All listed suites green; setup checks PASS |
| node --test tests without slash | Tooling footgun only | Prefer node --test or tests/. check.mjs already correct. Not a product bug; leave Phase 0 branch untouched. |

No FAIL blockers for starting the human screen-reader pass once profiles and keys are ready.

---

## 7. Integrity

- Tip verified: `1d18471974243b3ffcd77c77124171f1351a4e25`
- Tree verified: `e6cd77ebbdbe5f315d9ebb0326da68ffb352d069`
- git status on Phase 0 checkout: **clean** after rehearsal
- Access keys used for live checks stayed in local scratch only; not reproduced here

---

## 8. Artifacts

| Path | Purpose |
| --- | --- |
| `docs/AT-REHEARSAL-2026-09-06.md` | This pack (published) |
| local rehearsal logs retained privately | Suite pass/fail counts, raw suite output, setup-check results, Playwright screenshots |
