# Composed browser reservation regression

Base `8c1c2bd451c278078e9cd3470ad344db83d28b4a`; runtime/tests `3a2290911`, `924821e53`, `4c64e3eaf`.

The original test with 100 small members and nine canonical proposals failed at 262,511 charged bytes / 674 records. This exceeded the unchanged 256 KiB input bound, not its explicit 1024-record metadata reservation. The full composition would charge 302,369 bytes / 770 records (diagnostic run with a temporary local ceiling only; that diagnostic ceiling is not in the patch). A complete roster census occurred once. Repeated overview/event-label protected work reads and addressed room/viewer/owner authority reads caused avoidable repeated transfer and parsing.

The browser window now enters one private synchronous read-transaction reuse scope: at most eight already protected viewer work summaries and at most three protected room/owner/viewer authority records. First reads retain all original independent proofs and privacy checks; returned data and cached values are cloned. No caller-supplied authority, cross-transaction cache, schema/index/format change, default budget expansion or new storage exists. The scope requires a current Store read transaction, rejects async callbacks, expires in finally, and verifies the exact same head, closed current writer permit, original independently admitted catalog tuples and unchanged SQLite total_changes before returning. Mutation counters must be safe integers. Exact catalog comparison uses one JSON bind within Native SQLite parameter limits; this is additional work, not a schema-cookie trust shortcut.

Existing cumulative source-admission accounting on the exact fixture falls to 260,278 bytes / 666 records; the 256 KiB cap and nested 200-record refusal remain unchanged. The final exact catalog verification also binds 33,444 bytes of already admitted schema tuples. These figures do not claim a corresponding total SQL traffic, physical row, memory, CPU or latency reduction. The fixture remains close to its bounded admission ceiling; arbitrarily large roster fields or composed inputs may still refuse.

## Qualification

- Exact original 100-member test red before source change; final full bootstrap file 6/6 green, 0 skips.
- Private current work title and source-event definition/title redaction stays viewer-bound; a new request party added between transactions becomes visible on the next read.
- Clone mutation does not poison reused values; escaped reads do not retain the scope; async reuse refuses.
- A supported command changing the head, a dropped owned index, and a privileged head-unchanged work-entity mutation all refuse and roll back. A subsequent fresh snapshot remains readable.
- Affected bootstrap/work-list/events neighborhood: 15/15 green. No broad unchanged suite repeated here.
- Actual production ProjectRoom Native SQLite fixture: 1/1 green with 100 members, first work window eight, next window one, and nested 200-record refusal. This proves the new exact catalog JSON query and total_changes control in the actual runtime. It is not live/browser UI qualification.
- Targeted ESLint 0 errors / three existing raw-member warnings. Whole-tree scanner 1911 files / 0 findings.

New Native explicit entrypoint for parent CI registration: `cloudflare/current-browser-reservation.check.mjs`. Root owns composition/publication. No production changes, push or deployment.
