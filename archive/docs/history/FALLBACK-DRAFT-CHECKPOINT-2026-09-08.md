# Browser-compatible fallback — September 8, 2026

## What changed

Replace fallback135d824 with **4d22189ccdebc56db23397e6cc75b07eff0e3c2c** for the
retained candidate9745978. Both are schema12. The former fallback remains intact
as historical evidence, but is **not suitable for this release**.

Actual desktop and touch browser tests found three failures in135d824:

- Ordinary v3 drafts were invisible in its v2-only recovery UI.
- Ordinary edits saved on fallback were ignored on return to the candidate.
- Explicit fallback sign-out left newer draft storage behind in the same tab.

These were synthetic local observations, not evidence of a live incident or
cross-account access. The current app cleared stale data on later sign-in, but
that did not make the fallback's immediate sign-out promise correct.

The replacement backports the candidate's existing validated draft codec and
request-draft helpers: only `src/conversation.js` and `src/reply-requests.js` differ
from135d824. It preserves v3 entries, exact pending operations and sign-out clearing
without adopting the new request UI, service marker or agent observer.
Ordinary drafts are editable on fallback; request drafts remain separate and
return when the candidate UI is restored. Fallback does not execute request retries.

The two-file backport was committed on `codex/draft-compatible-fallback-20260908`
in the sibling `project-room-fallback-drafts-20260908` worktree, then merged into
canonical history. The merge changed no current runtime files: the candidate
already contains exactly these two files. This preserves the fallback commit as
a reachable ancestor, not an unreferenced temporary commit.

## Verified behavior

`node --test scripts/fallback-draft-browser-check.mjs` is a required explicit
release qualification in addition to the regular browser suite. It starts actual
exact-commit packaged Node services on the same origin/database and retains the
same browser page, cookies and sessionStorage through each switch. Both desktop
and touch cases check:

1. Opt-in ordinary/request drafts remain separate across reload and fallback.
2. An ordinary edit on fallback is present after returning to candidate.
3. A committed request with a lost response retains its exact pending operation
   across fallback and returns as a read-only original retry, saved only once.
4. A committed ordinary message with a lost response retries exactly on fallback,
   with the same command and no additional message/event.
5. No draft transition automatically posts anything.
6. Explicit fallback sign-out clears all v1/v2/v3 draft entries immediately.
7. Returning to candidate and signing in as the same or another identity restores
   no private drafts. No browser script errors occur.

The initial backport run hit the app's unsent-draft confirmation; the harness now
explicitly accepts the simulated reload/sign-out choices. The application prompt
was not bypassed or removed. Subsequent runs passed.

Qualification this checkpoint:

- 2 desktop/touch package-switch journeys passed.
- 510 core/API/package checks passed on the fallback's own source.
- 536 core/API/package checks passed on current source.
- 13 current Workers checks passed, including the **actual retained** candidate9745978
  and fallback4d22189 through pause/switch/return and20-table audits.
- The prior168 general browser and one Workers browser results were not rerun;
  this slice changes the fallback codec, not the current application UI/runtime.
- The current65 runtime files still match the retained candidate9745978 hashes.

## Retained artifacts

Root: `../project-room-runtime-packages-20260908/`.

- `candidate-9745978` remains unchanged:65 files,19 assets, schema12.
- `fallback-4d22189`:64 files,19 assets, schema12. Manifest SHA256:
  `01667e2de94d79bf2b67f102995696f8bf0e02b3e46777bc38a3a8cbdd9627e6`.
- `fallback-135d824` is retained but superseded; never silently replace its bytes.
- `evidence-fallback-4d22189` retains the browser, fallback core and Workers logs,
  inspected touch returned/sign-out screenshots, and a hash manifest.

The Worker switch test now requires the new fallback source when retained paths
are supplied. Its historical schema8 exercise is unchanged. The browser test
packages the exact commits afresh; it does not load the retained directories.
Matching verified manifests establish their byte-equivalence, not hosted readiness.

## Remaining work

This closes the tested browser format/retry/sign-out gap, not every possible
browser downgrade or recovery scenario. Requalify whenever either draft format
or candidate/fallback changes. The older fallback UI remains visibly older and
does not expose request actions; v3 agent inbox support is still unavailable there.

Next safe work: current-authority reconciliation after a historical restore and
quiet, unambiguous participant attribution. Hosted recovery/undo and independent
native-agent review still require their respective current approvals. No models,
provider changes, push or deployment occurred. Preview64985 remains untouched;
the broad goal is active and incomplete.
