# Email excerpt → room work → private draft

September 8, 2026. Local fixture-backed implementation. No mailbox connection, real sending, paid execution or deployment.

## Implemented journey

In the existing Inbox, Ask room opens the existing audience preview. A person selects the relevant passage, inspects the exact excerpt and shares it. The passage becomes an ordinary room message. It can remain a conversation or be deliberately promoted into existing work; sharing itself creates no task and starts no agent.

Work linked to that excerpt uses the existing contribution, independent verification and human decision lifecycle. An approved exact text result appears in the source's private Inbox. The owner reviews both the returned text and any draft it would replace, then adopts it as a private draft. Subsequent edits keep honest historical provenance. Adoption does not send anything.

There is no additional navigation, assignment system, transport or dependency.

## Exact selection contract

The browser negotiates `view=email-excerpt-v1`. The older `email-text-v1` view retains its read/draft-only capability declaration and original body representation. The no-view list remains synthetic-only. Unsupported/duplicate view values are refused.

The new projection normalizes CRLF and CR to LF for plain-text selection, matching textarea line endings. Everything else remains unchanged. HTML has no selectable projection and no share capability. Empty/whitespace-only text has no share capability. Disconnect leaves an account-owned saved copy available for deliberate sharing; it does not supply a new provider grant.

The new private journal action is `source.excerpt`. It binds:

- the authenticated account/session and private source ID;
- the exact source revision;
- destination room and current audience digest;
- a half-open `{start,end}` selection in UTF-16 offsets into that normalized text;
- a stable request ID for exact retry.

The request contains no supplied excerpt body, recipient addresses, credentials or provider headers. The service derives the text from the immutable source version. It rejects out-of-bounds/reversed/empty selections, split surrogate pairs, extra fields, whitespace-only excerpts and results over 4,000 characters including the fixed label. Selecting text is not permission to import HTML, attachment bytes or metadata.

The room receives only `Shared email excerpt`, a separator and the selected text. It receives no automatic subject, sender, recipients, Bcc, mailbox/provider IDs, reply headers, attachment names, private draft or later message content. These can still occur inside text a person deliberately selects; the system does not pretend to recognize or remove secrets from arbitrary prose. The preview and audience are therefore necessary, not decorative.

Sharing writes the canonical room message and private receipt atomically. A journal failure leaves neither half committed. A changed source/audience requires a new preview for an uncommitted operation. A previously committed operation can return its original receipt after a source change, under current account/room authority; it cannot manufacture a second excerpt or substitute newly selected text.

## Interaction and recovery

The selection control starts without a selection; Share is disabled until bounded text is selected. It shows the exact room-message preview. Ordinary typing cannot rewrite the source. Native readonly textareas on the tested macOS Chromium did not respond to arrow-key selection, so the control retains native editable-text selection behavior while cancelling edits and restoring the immutable value if an input event still occurs. The control declares its read-only purpose. Keyboard selection is exercised in desktop and mobile-sized browser tests; that is not qualification of physical mobile selection handles or all mobile keyboards.

Only operation metadata and offsets are retained in per-tab pending-share storage, not source bodies or addresses. After a lost acknowledgment, reload exposes Confirm share and retries the same request. Even if the source has become unsupported HTML, the pending retry remains reachable. That retry does not offer new HTML sharing. Source-selection callbacks are tied to their dialog instance and owning session.

Real source changes leave the private draft untouched, refuse the stale share, and require a fresh selection. Browser room access and private Inbox access remain distinct. A room agent can see the intentionally shared message; its bearer credential cannot read the private source or mint an excerpt from it.

## Storage compatibility

Schema 20 fences older writers before admitting `source.excerpt` records. No new application table is required. Existing source, draft, receipt and result records are reused; historical `source.share` replay remains unchanged. Result lookup now recognizes both share operations.

The genuine schema-19 baseline is commit `9b81c2cafac1901013a251ff058a286c8f78b7cc`, not a current database with a lowered version marker. Tests open populated historical stores, inject migration failure, compare the unchanged catalog/data after rollback, migrate successfully, reject already-open old writers and reopen the current store. Local Workers uses the same version inventory when recognizing historical guards and replacing its write permit. This removes duplicated version lists that caused an initial v19 upgrade check to fail.

Cold-package and backup/reopen checks include actual excerpt receipts; normal startup independently verifies their exact room events against their private source versions. Current Workers restart also replays the same excerpt receipt. Historical recovery-switch tests retain their historical scope; they do not prove a current production rollback or provider disaster recovery.

## Evidence and limitations

The final edited runtime passed syntax checks and all 797 core tests, all 240 root browser tests, all 21 local Workers tests, and the separate two-browser local Workers invitation/chat/reconnect/restart test. All final suites had zero failures, cancellations or skips. These runs tested the runtime before the documentation checkpoint commit; only documentation changed afterward. `git diff --check` passed. The two-browser Workers log retains a local self-signed TLS diagnostic; it is not a production certificate test.

Evidence is retained in the ignored local `test-results/email-excerpt-20260908/` directory: final core, all-browser, all-Workers and Workers-browser logs; earlier failed selection/upgrade runs; the 54-test targeted run; four email selection/return screenshots and three Workers conversation screenshots. Email selection and return screenshots on both viewport sizes, plus the Workers return screenshot, were inspected. Reproduce with the configured Node 24 runtime: `node scripts/check.mjs`, the root `test:browser` script, the `cloudflare/` `test` script and `node --test browser.check.mjs` inside `cloudflare/`. Local loopback/browser permission is required. These commands do not deploy.

Failures found during development were retained in the local logs: initial keyboard selection included the whole fixture message; initial Workers v19 migration omitted that version from its known historical-guard list. The former prompted the selection correction and the latter prompted a shared version inventory. Two first-pass domain assertions also required fixture corrections (the existing send-refusal code and matching attachment observation revision).

Screenshots show the exact selected passage and reviewed private return on desktop and mobile-sized screens. People are simulated browser users; producer/reviewer actions are scripted service participants. These checks do not establish human delight, physical-device behavior, native vendor-agent compatibility, live email delivery or retention.

## What remains

Real provider account setup, durable secret storage, scope/consent review, remote synchronization, provider-created reply drafts, exact recipient/attachment review, external send authorization and reconciliation remain separate unfinished work. HTML, attachments and broader messaging channels also remain unqualified. The next messaging implementation should qualify provider-specific reply drafting and reconciliation with recorded/invented fixtures before a separately authorized test mailbox. It must not silently turn draft adoption into a send.

The larger Project Room objective remains active and incomplete.
