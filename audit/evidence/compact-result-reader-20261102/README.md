# Compact selected result click

Exact base fd631a69d. Actual thinWorkForContext receipt is passed to the production readResult handler extracted with Acorn. Before: compact click returns without opening selected loader (2 pass, 1 fail). After: 3 pass, 0 fail, no skips. The handler now accepts compact receipts carrying exact completion event/evidence bindings, and nativeText.previousCompletionEventId is optional. Existing selected loader still validates returned completionEventId/evidenceVersion and session/view ownership unchanged.

Controls preserve full external receipt no-op (external link remains the card action), full native prior completion pointer, busy refusal and noncurrent result refusal. No hydration, auth/storage, server, app.js or loader response validation changes. ESLint and diff check exit0. Test mocks openResult/saveSelection to inspect exact pinned view; this is not a real-browser replay. Root owns publication/browser confirmation and manifest generation.

Captured logs have trailing whitespace normalized; assertions and outcomes are unchanged.
## Compact external correction

Independent review found thin external receipts also lack summary/nativeText, but retain evidenceUrl. Added actual thin external controls for card anchor and defensive reader guard: baseline5pass/2fail, after7pass/0fail/0skip. Existing safeUrl anchor retained; native receipt uses existing selected text loader. Corrected the earlier native fixture to evidenceUrl:null, matching code-owned work-reducers.js (nativeText ? null : evidenceUrl). Full native/external behavior stays unchanged. ESLint and diff check exit0. No actual-browser assertion added.
