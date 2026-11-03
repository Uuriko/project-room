# Temporary normalized message mitigation (#5759)

Base: `6dca37dad` (PR #5818). Root owns source review; Member2 owns release.
Synthetic local Node/Native only; no production messages or history were changed.

The old dependency reader sums the full proof row, including the duplicate body
in `record_json`, and refuses above 131072 bytes. Plain producer rows measure
131256 bytes for max ASCII, 393400 for max CJK, and 458936 for max control text.
The unchanged historical body ceiling is 65536 UTF-16 units; new live commands
could previously persist these rows and then fail to read/edit/delete them.

Independent mitigation:

- New normalized `message.posted`/`message.edited` bodies are temporarily limited
  to **8192 UTF-16 units**, after the exact committed-command lookup. Existing
  history/replay and larger commands' exact retries remain unchanged.
- Before canonical persistence, every prepared message proof row must fit the
  existing **131072-byte** entity reader limit. This includes body duplication,
  metadata and retained edit history. An oversized candidate refuses with its
  byte count/maximum and rolls back the whole command. No history is truncated.
- Historical candidate replay is not a new live command and keeps its existing
  admission. Storage format, writer witnesses/hashes and shared reader caps are
  unchanged. Existing oversized/unreadable rows still require the full fix.

The body cap alone is insufficient: repeated 8192-unit control edits eventually
exceed the old proof-row limit through retained edit history. The pre-persistence
guard is required to prevent that new unreadable state. It may refuse further
edits until the full fix; the last accepted row remains readable and deletable.

Six Node controls: four at-cap families (ASCII, CJK, controls, astral) survive
cold full reads, reply dependencies, short edits, deletion and another cold
reopen; 8193 units refuses clearly. Repeated edits preserve exact sequence/row on
refusal. A larger legacy command's exact retry survives normalized adoption.
On the base these controls produce **1 pass / 5 failures**; mitigation **6 pass**.
Catalog/manifest composition totals **25 pass**, zero skipped.

Actual production Native constructor/HTTP: all four body families pass the same
at-cap/one-unit-over/cold read/reply/edit/delete/cold sequence (**1 check pass**).
These are local correctness checks, not production latency or CPU measurements.
The full fix must restore 65536 only after bounded canonical admission is
qualified. Existing max-body new-write fixtures intentionally encounter the
temporary cap; their original historical acceptance has not been relabeled.

Logs: `/tmp/message-mitigation-{before,after,composed,native}-1103.log`.
