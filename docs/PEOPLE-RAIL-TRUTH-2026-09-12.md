# People rail truthfulness checkpoint

Local isolated identity-scope branch; canonical UI edits untouched.

The People rail no longer renders inferred online/away dots or a data-presence
claim. Work ownership and recent chat cannot establish live presence. Existing
work titles remain, without claiming that the member is currently connected.

Completion chips now use the shared terminalWork predicate: an unqualified
receipt says “Result posted”; only terminal work says “Done.” Pending results use
neutral styling instead of the completion green. Removed the explanatory rail
sentence rather than adding more copy.

Final focused checks: 21 conversation/asset tests pass; the real Chromium local
HTTP test passes at desktop and mobile viewport sizes. Browser dependencies came
from the existing bundled runtime via an in-process module resolver; no install
or repository dependency change. The mobile screenshot was visually inspected:
the work card says Awaiting verification while the rail says Result posted,
without dots or explanatory copy. No browser page errors were observed.

The first browser attempt lacked Playwright; after using the bundled dependency,
one fixture expectation needed correction because the newly required verifier now
has assigned review work. These were not passing runs. Final browser result:
one passed, zero failed/skipped. `git diff --check` passed.

The broader `node scripts/check.mjs` run passed 1,165 tests, zero failures/skips,
but started before the final copy/style polish. The final-state evidence for those
changes is the 21 focused checks and Chromium run above; a fresh whole-tree gate
is still required before integration.

Remaining: remove now-unused inference helpers/imports/CSS after checking other
consumers; qualify real presence separately if needed; improve the broader mobile
layout and accessible interaction. Browser viewport emulation is not physical
device or assistive-technology evidence. No deployment or publication performed.
