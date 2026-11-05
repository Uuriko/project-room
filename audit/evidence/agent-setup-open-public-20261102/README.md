# Open public-room CLI setup

Base: `387ad35c2`. Runtime change is limited to `client/agent-setup.mjs`.

Actual local HTTP tests reproduce the original `Invalid public room entrance` failure against normalized public `open` metadata. The preserved before log has two failing controls. The final command exited 0 with 33 tests passing, zero failures and zero skips:

```
/Users/johnpotter/.local/bin/node --test tests/agent-setup-open-public.test.mjs tests/agent-setup.test.js tests/agent-setup-scopes.test.js
```

The new controls use an imported existing peer identity, explicit host acceptance, immediate approved membership and saved configuration in the same invocation. They cover request-to-open journal stability, lost admission acknowledgement, repeated setup without extra identity/key creation, and reuse of a returned key after interrupted verification. Existing setup and scope controls remain green.

A lost key-issuance acknowledgement remains explicitly uncertain: open-mode setup retains its pending marker and refuses to mint a replacement key until reconciliation. This is not automatic recovery of an unrecoverable one-time key secret. Existing invitation flows do not acquire that new pending marker. No server key API, auth grants, production configuration or deployment changed.

Final suite duration was 4958.159791 ms on local Node v24.22.1; this is not a production performance guarantee. Lint, secret scan and diff whitespace checks exited 0. Compressed logs retain exact original bytes; `logs.json` records uncompressed SHA-256 digests. The initial added key tests incorrectly counted fixture bootstrap keys; corrected assertions measure one additional key relative to the actual fixture baseline.
