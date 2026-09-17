# 200+ useful tasks — plan (2026-09-15)

Live snapshot when this was written:

- Room Worker `c569027`, GitHub `production` README `81e2e7a`, `/api/open` `ship: false`, Google PKCE on.
- Dasha Compute healthz `0.3.1`, package `0.3.0`, 1 provider online.
- Products stay split: Room ≠ Desk ≠ Dasha ≠ DIE Track Room. Do not merge `main` (Schema 34) onto this host. Do not edit Dasha `compute/` from this lane (report only). Skip occupied Room `.gitignore`, `.wrangler/`, `docs/*RESEARCH*`. Instinct #197 is off this lane.

**How to execute:** one user-visible sentence per slice. Test the real path. Deploy Room from a clean worktree. `node scripts/live-audit.mjs` must stay green. Stop a slice when one sentence is true.

**Do first (next 10, in order)**

1. Hard-refresh Google sign-in on `https://room.trydemigod.com` and confirm Welcome stays open (cookie interstitial).
2. Confirm a second Google account can sign in and does **not** get `manage_members`.
3. Point or document that `www.trydemigod.com/room` Join still hits staging (Demigod HTML Worker, not this repo).
4. Align GitHub About/homepage with `https://room.trydemigod.com` (REST; GraphQL flaked).
5. Leave `quill/specs-queue` unless Quill says delete.
6. Add `/compute/api/network` (not `/v1/network`) to any Room/Compute client docs that still 404.
7. Report Dasha package 0.3.0 vs live 0.3.1 to the compute contractor lane.
8. Keep `live-audit.mjs` in CI or a cron-like agent check.
9. Do **not** `ship: true` until abuse controls exist.
10. Do **not** cut over Schema 34 onto the live Durable Object.

---

## A. Room — Google / session / launch (11–45)

11. Watch Google callback HTML still sets `__Host-account_session`.
12. Add a test that a Strict cookie is not required on the callback GET itself.
13. Expire Google PKCE pending after 10 minutes (already) and log `google=error` without leaking tokens.
14. Show a clearer `/?google=error` line when consent is denied vs token failure.
15. Rate-limit `/api/auth/google/start` per IP (already 10) and document it.
16. Rate-limit callback (already 20) and test burst 429.
17. Prevent two overlapping Google starts from the same slot (already supersedes).
18. After login, strip `google=error` from history (already) and also strip leftover `state`.
19. Focus **Continue with Google** when the auth panel opens (already if join unhidden).
20. If `/api/auth-config` is `provider: null`, keep Google hidden and keys primary.
21. If Google secrets vanish, fail closed and still allow keys.
22. Privacy page remains origin-open (`Origin: accounts.google.com` → 200).
23. Privacy copy stays “email is not the account key”.
24. Add a one-line terms section or keep privacy URL as terms (Google branding).
25. Square 120px app logo only if you accept Google verification later (logo triggers verification).
26. Stay **In production / External** without requesting Gmail mailbox scopes.
27. Document the unverified-app warning for first-time Google users.
28. Add potter@trydemigod.com as developer contact (already).
29. Authorized domain stays `trydemigod.com` only.
30. Redirect URI stays exactly `/api/auth/google/callback`.
31. JS origin stays `https://room.trydemigod.com` (no www).
32. First Google human in empty Welcome keeps invite power.
33. Third Google user in Welcome must not become operator.
34. Named local operator `c6a94a` still matches key-login members.
35. After first Google operator, consider setting `ROOM_OPERATOR_ACCOUNT_ID` to the `idp-` hash.
36. Session restore after interstitial must call `ensureAccountSession` with the new cookie.
37. `/api/session?room=welcome` must not 401 after a good Google login.
38. Sign-out must clear account cookie and Google intent.
39. Sign-out must not revoke Google at Google (we don’t persist refresh tokens — confirm).
40. Access_type=online stays (no offline Gmail grant).
41. Prompt=select_account stays so a second Gmail can be chosen.
42. Add a “Use a key instead” visible path when Google is slow.
43. Timeout copy if Google consent tab is closed.
44. Do not load any identity-provider browser SDK.
45. `live-audit` fails if `gmail.readonly` appears on the start URL.

## B. Room — GitHub hygiene (46–70)

46. Keep only `main` and `production` as blessed heads.
47. Ask Quill before deleting `quill/specs-queue`.
48. Never merge Schema 34 `main` onto live `production`.
49. Tag live Worker SHAs on `production` (annotated tags).
50. GitHub About description: shared room for people and agents.
51. Homepage URL: `https://room.trydemigod.com`.
52. Topics: `cloudflare-workers`, `durable-objects`, `collaboration` — no fake SOC2.
53. Open-PR list via REST when GraphQL resets.
54. Close stale PRs that target staging-as-live.
55. Issue #11 stays Instinct coordination, not this lane.
56. #197 stays off this lane.
57. README must not name `project-room-staging.getdasha.workers.dev` as live (fixed).
58. `hosted-check.mjs` may still pin staging — label it staging-only.
59. `cloudflare/README.md` still names staging — fix or label.
60. `hosted-denial-conformance` staging origin is OK if tests say staging.
61. Protect `production` branch (no force-push).
62. Require `live-audit` + unit tests on `production` pushes if Actions allows.
63. Default branch can stay `main` if README says it is not live.
64. Do not git-init `$HOME`.
65. Do not commit `.wrangler/` or occupied research docs.
66. Keep `ship: false` in `/api/open` tests on both branches.
67. Cherry-pick only copy/UX fixes from `main`, never schema 34 first-write.
68. Archive ChatGPT worktree clones under `src/project-room-integration-*` from the GitHub story.
69. One CODEOWNERS or lane note: Grok on live host, Instinct on #197.
70. Weekly: `git ls-remote --heads` vs `/api/version`.

## C. Room — auth panel / first-run UX (71–95)

71. Default HTML no longer says only “Connecting…” after JS loads (channels.js shipped).
72. If a future import 404s, `live-audit` fails (app.js import crawl).
73. Add a noscript line: “JavaScript required to open Project Room.”
74. Connecting status should swap to “Sign in required” within the 10s fetch abort.
75. Don’t show two primary buttons (Google primary, keys ghost — done).
76. “Sign in with a key” still opens `#access-key`.
77. Invite paste field works without opening key details.
78. Skip-link still lands on `#auth-title`.
79. Auth title remains focusable (`tabindex="-1"`).
80. Mobile 40rem: Google button full width, keys below.
81. Copy-agent-setup must not steal the Google CTA.
82. Help details must not mention “local pilot”.
83. Never paste account keys into agent chat (copy already).
84. File key upload still 256-byte cap.
85. Reveal/hide key still aria-pressed.
86. After failed Google, keys remain usable.
87. After success, hide auth panel and show Welcome.
88. Empty Welcome copy: “Say hello. Everyone starts here.”
89. New-room control only if the member can create rooms.
90. Account home `?account=1` still lists rooms.
91. Deep link `/?room=welcome` signed-out shows account sign-in, not a hang.
92. Deep link signed-in restores that room.
93. Invitation fragment still skips restore.
94. `google=error` must not look like a network outage.
95. Connection-details `<details>` should explain “signing in” vs “loading room”.

## D. Room — invitations, members, agents (96–125)

96. Invitation expiry uses `new Date()`, not `Date.parse` on numbers (shipped).
97. Invalid expiry shows `unknown`, not Invalid Date.
98. `<time datetime>` on invitation expiry.
99. Dialog title + `aria-atomic` for errors.
100. Agent Max access = full `PERMISSIONS` including invite/decide.
101. Lower presets reduce power; copy matches.
102. Add-agent hint follows selected access.
103. `validatePermissions` must not block agent `manage_members`/`decide` on Max.
104. No NEVER_GRANT list that contradicts Max.
105. Guest `ga1.` stays separate from unpublished `oa1.`.
106. Share-link expiry formatter shared with invitations.
107. Invitation unavailable message names whom to ask.
108. Capability limits string is honest for the selected access.
109. `agentMembershipLimits(access)` stays in sync with server.
110. Member list: humans vs agents visually distinct without mystical UI.
111. Address-on-click presence still sets To: member.
112. Removed members stay removed on restore.
113. Revoked Google account cannot rejoin via the same sub if revoked in-store.
114. Different Google subs never merge on email.
115. Invite links don’t leak in `/api/open`.
116. Owner can revoke a share link.
117. Expired invite cannot be accepted.
118. Accepted invite cannot be double-accepted as a second membership.
119. CSRF on accept.
120. Session binding on accept.
121. Agent invite mint is owner-only except Max agents.
122. Guest-agent links stay unpublished as launch mail.
123. Diagnostics export doesn’t include account keys.
124. Roster named Instinct/Muse/Grok doesn’t imply they’re logged in.
125. People rail empty-state: “Invite someone.”

## E. Room — work, receipts, conversation (126–155)

126. Receipt sentence on result rows (shipped).
127. Receipt sentence on work cards (shipped).
128. Receipt sentence on linked work in the thread (shipped).
129. Prefix is work **title**, not long summary (shipped).
130. Revisit “waiting on you” so non-accountable viewers see “waiting” (product call).
131. Copy-receipt control optional; selectable text may be enough.
132. Done chip + sentence together must not duplicate loudly.
133. Failed work: `Title: failed.`
134. Waiting: `Title: waiting on you.` until copy changes.
135. Terminal work with verification flags still “done” only when `terminalWork` says so.
136. Superseded work: don’t show a live receipt as current.
137. Work card next-step line still uses `nextWorkStep`.
138. Conversation work-link opens the work panel.
139. Incremental DOM patch includes `.message-links` / `.message-work-receipt`.
140. CSS wrap: sentence on its own row under the link.
141. Return brief attention items could cite the same sentence (later).
142. Search work still finds titles.
143. Search messages doesn’t require the receipt line.
144. Reactions still independent of receipts.
145. Draft recovery after Google login uses account identity `idp-…`.
146. Composer Enter-to-send vs newline stays.
147. Mention picker still works for Google members.
148. Thread receipts are not chat spam (one line).
149. Portable work export doesn’t include secrets.
150. Result copy button still copies native result text.
151. Reminders still owner-scoped.
152. Automations stay off unless the member can manage them.
153. Work proposal confirmations still require the right actor.
154. Independent verification flag still blocks fake “done”.
155. Owner decision required still blocks close.

## F. Room — Channels / DMs / sidebar (156–175)

156. A2: DMs as **projection only** — `directConversation` + sidebar section.
157. No new auth for DMs.
158. Stop when two members open a DM label that maps to a room they already can access.
159. Do not create a second conversation store.
160. Account rooms list currently renders Channels section only — render Direct when we have pairs.
161. `accountRooms` payload has no co-members — don’t invent them.
162. Room-local DMs from `state.members` without a new API.
163. Clicking a DM sets To: (existing address path).
164. Empty Direct messages section should not show if there are no pairs.
165. Sidebar sort stays in `roomsToChannelEntries`.
166. Selected room id still highlights.
167. Workspace id still filters.
168. Don’t merge Tag sandbox Channels into Room source.
169. Don’t build Tree-of-Life navigation.
170. Rooms → New room still account-permissioned.
171. Account home after Google lists Welcome.
172. Switching rooms doesn’t leak drafts across accounts.
173. Presence click vs DM click shouldn’t double-send.
174. Search channels doesn’t search other tenants.
175. CSS for Direct section matches Channels, no extra mythology.

## G. Room — Worker / schema / ops (176–200)

176. One live Durable Object name: `invite-only-pilot`.
177. Never first-write Schema 33/34 onto schema-26 live SQLite.
178. Copy-first 26→33 on a **new** object, then cut DNS if ever.
179. PITR is in-place last-30-days, not a clone — don’t plan PITR as fork.
180. `a5f2dca` is a **staging git SHA**, not a DO hex id.
181. Staging export to a new object before any cutover.
182. Confirm before **cut over main**.
183. `ROOM_PRODUCTION=1` + `ROOM_OPERATOR_ACCOUNT_ID` required.
184. Wrangler secrets: operator + two Google secrets only.
185. `wrangler deploy` “No targets deployed” → `versions deploy @100`.
186. Stamp-version from a **clean** worktree (occupied research breaks stamp).
187. CPU 50ms limit: Google JWKS fetch is wall time, not CPU — still cache keys.
188. JWKS cache TTL 1h; rotate kid.
189. DO in-memory PKCE map is OK (one object).
190. `/api/ready` 200 only after a room exists.
191. First Google login bootstraps Welcome if missing.
192. `provider_room_conflict` if Welcome isn’t the bootstrap room.
193. Observability off unless John turns it on.
194. No CORS `*` on Room APIs.
195. MCP Origin 403 when Origin present (2025-11-25).
196. Unpublished MCP stays `oa1.` non-persist.
197. Edge doors rewrite to `ROOM_ORIGIN` before Host guard.
198. Unexpected Host → 403.
199. CF-Connecting-IP required.
200. Align GitHub `production` SHA with Worker after README-only commits (optional deploy).

## H. Room — tests / bug-hunt system (201–220)

201. Run `node scripts/live-audit.mjs` after every production deploy.
202. Unit: `tests/live-audit.test.js` fail-closed on `ship: true`.
203. Unit: fail-closed on mailbox Gmail scope.
204. Asset allowlist includes every `app.js` import (`channels.js` lesson).
205. HTTP `assets` Map includes the same files as `build-assets.mjs`.
206. Add a test: missing asset → 404 listed by name.
207. Conversation tests cover title-not-summary receipts.
208. Google login HTTP: interstitial 200 + Set-Cookie.
209. Google login fail: 200 + `/?google=error`, zero accounts.
210. Provider-onboarding: Clerk-shaped tests still no extra perms.
211. First Google + operator suffix → `manage_members`.
212. Invitation expiry numeric timestamps.
213. Skip-link browser check still `#auth-title`.
214. Production-http: no `pk_live_` in wrangler.production.jsonc.
215. Do not weaken tests to go green.
216. Hosted-check against **staging** stays named staging.
217. Optional Playwright: Google interstitial then Welcome (needs test user).
218. Record hunt findings in `docs/ROOM-AUDIT-2026-09-15.md`.
219. Cron-like agent: live-audit every keep-working session.
220. If live-audit fails, do not start A2 DMs.

## I. Dasha Compute — report only (221–250)

221. Report package 0.3.0 vs live 0.3.1.
222. Clients must use `GET /compute/api/network` (not `/v1/network` 404).
223. Models: `GET /compute/api/v1/models` (308 from shorter path).
224. healthz `service: dasha-compute`.
225. One provider online as of this plan — expect `no_mac_online` if it drops.
226. skill.md `base_url https://lobby.getdasha.com/compute/api/v1`.
227. agent.json says **Not Room** — keep that split.
228. Guest mint `POST /compute/api/guest-keys` — do not paste keys into docs.
229. CORS `*` on guest mint is a threat-model item — report, don’t “fix” here.
230. Unauthenticated models list — confirm intended.
231. Hosted Ask is `POST /compute/api/chat`, not a silent v1 swap.
232. Community chat/completions fail-loud when no Mac advertises the model.
233. GitHub `Uuriko/dasha-desk` leftover `ocm-*` branches — close/delete via compute/OCM lane.
234. Leftover `cursor/*` and `quill/*` compute branches — same.
235. `Uuriko-patch-1` — inspect then delete or merge.
236. `docs/LIVE-STATUS.md` last verified 2026-09-02 — stale.
237. Local `node --test tests/*.test.mjs` 11/11 — re-run after contractor edits.
238. Do not wrangler `dasha-lobby` from Room lane.
239. Do not document fake API keys.
240. www `/compute` 308 to lobby is expected.
241. `/casino` `/lore` 404s are growth-lane, not Compute.
242. Mint in skill is `53uxQtB9pcjWvCHguz3JTTndvuKqGxhrD37EetnCpump` only.
243. No Telegram/wallet-connect copy in Compute skill.
244. Receipt chain vs account ledger — don’t turn Compute into Room.
245. OCM keys `ocm_live_` never used as Compute `dsk_`/`dgk_`.
246. Provider doctor fails if Ollama model missing — keep fail-loud.
247. Release tarball checksum identity tests exist — don’t break allowlist.
248. OpenRouter provider branch (`quill/openrouter-provider`) — review in compute lane.
249. Auth-boundary tests branch — review, don’t merge into Room.
250. Report Compute bugs on the compute issue, not Room #11.

## J. Demigod / Desk / coordination (251–270)

251. www `/room` Join → staging until Demigod HTML Worker redeploy (source not in Room overlay).
252. Do not print `DIE` in overlay copy.
253. Desk (`src/desk-chat`) is Slack replacement — don’t merge Room into it.
254. Track Room `die-pr100` ≠ Desk ≠ Room.
255. Bus: `dg-bus.py inbox grok --unread` at session start.
256. Channel packets stay secret-free.
257. Occupancy: dirty paths you didn’t write are occupied.
258. Codex wins contested paths.
259. No invented SOC2/SSO/ATS in copy.
260. No email Britton/Microsoft from agents.
261. Screenshot/Screen Recording may still be blocked for this TUI.
262. Chrome AppleScript JS may still be off — use CDP copy-profile if needed.
263. Chrome 152 refuses CDP on the default profile path.
264. Don’t `pkill -f` patterns that match the shell wrapper.
265. Don’t POST live guest-keys just to probe (already minted once — don’t paste it).
266. Keep Grok binary Screen Recording off the critical path.
267. Agent-board: append rows, never rewrite others.
268. Instinct W4-45 wake-queue stays off Grok’s Room lane.
269. Tag sandbox `demigod-labs/claude-tag-sandbox` not merged into Room.
270. Claude growth: new files only under `docs/growth/` if that claim still holds.

---

**Count:** items 1–270. First ten are the queue. Room GitHub README (staging URL) already corrected on `production`. Google cookie bounce already corrected on the Worker (`c569027`). Next user-visible Room slice after Google-login confirmation: **A2 DMs as projection** or **www `/room` door** (Demigod Worker, different tree).
