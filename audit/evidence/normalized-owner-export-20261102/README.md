# Normalized owner export qualification

Frozen executable source: `60d5b9b0a88e7c246618e69e72a3d4660cf52331`.

Original causal red: `d35f30008` on `9b174d5e7`: explicit full-room hydration trap turns normalized non-owner export into HTTP 500 instead of the required 403. Runtime cure: `2021f2bec`.

The export owner check now uses protected addressed authority. Current exports walk the existing current event pages, including their privacy/redaction predicates and page-bound record proofs; HTTP does not apply legacy whole-map filtering to those already-filtered pages. Live exports still append the original owner/format-validated room.exported event before returning success. Archived status reads only protected room metadata; repeated archived exports append nothing.

Composition retains helper ae535 default-room source (adopted c6460644b) and helper 513ec4ba8 tombstone materialization (adopted e7a045e8c). The latter was discovered by the rich export test: deleted legacy records had NULL reducer extras and were rejected by the existing current entity decoder. Decoder validation was not relaxed.

Node covers multi-page public history, edited-current text, deletion tombstones, intermember private DM and edit suppression even for owner, non-owner refusal, content framing, source-page failure, audit-save failure, retry after failure, final full recovery oracle, existing legacy exports/imports and actual HTTP-created normalized room archived export. Native uses the actual production ProjectRoom constructor and Durable SQLite, new account-created native room with canonical starter, JSONL/HTML, current deletion, two cold restarts, room archive, and byte-exact repeated archived export. Native HTTP bridge does not retain Content-Length; Node framing is tested separately. Test provisioning doors are local fixture-only.

This is explicit full-export functionality. Materialization remains O(visible history) in total time/memory; no ordinary read fallback, bounded whole-export CPU/memory claim, provider installation, production verification, or deployment is claimed. Historical source authority is unchanged. All credentials/accounts are synthetic local fixtures.
