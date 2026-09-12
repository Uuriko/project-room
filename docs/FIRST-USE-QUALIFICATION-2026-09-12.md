# First-use qualification checkpoint

The unchanged integrated candidate `08868ebc3ba281cec3c52daf370f69b8555aedd3`
passed 1,178 automated checks, with zero failures or skips. Its HEAD and clean
working tree were verified before and after the run. This closes the earlier
exact-state rerun gap, not the broader release or product qualification gates.

## Journey evidence

Before this copy change, the first-use browser checks passed on desktop and
simulated touch. Six broader browser checks also passed: conversation, drafts,
retry, reactions, search, source work and revocation on both layouts; return
brief paging and acknowledgement on both layouts; and late success/failure
responses across replacement sessions.

Mobile screenshot inspection showed the default composer instruction wrapping.
The placeholder now reads **Message the room…**. Mention guidance is available
under Options alongside room visibility and agent-authority guidance. The
persistent accessible label, mention picker, keyboard behavior and contextual
thread/work placeholders are unchanged.

After the change: 22 conversation/roster tests and two first-use browser checks
passed. The browser checks now explicitly verify the default placeholder and
accessible textbox name. Mobile screenshot inspected after the final run.
The first roster check caught removed mention guidance; it was restored under
Options before the passing rerun. No full-suite claim is made for this later
copy-only change.

These are synthetic Chromium checks, not physical-device or participant
evidence. New users still need observed onboarding and mention-discoverability
testing. Layout density, agent connection, result review, attachments, knowledge
reuse, operational recovery and enterprise qualification remain open.

## Coordination

Canonical files were not edited. Grok's frozen MCP source hashes match the
selected integration snapshot for its implementation modules; its later test
and documentation edits were reviewed as a diff, not blindly copied. The later
documentation test and new walk-in tests still require independent integration
review. No publish, push or deployment occurred.
