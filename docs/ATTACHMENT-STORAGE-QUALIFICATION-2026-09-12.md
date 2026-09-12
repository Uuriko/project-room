# Attachment storage primitive qualification

Status: measured foundation only; room attachment sharing is still unimplemented.

## Reproduction

From `cloudflare/`, install the existing pinned dependencies from `pnpm-lock.yaml`
with `pnpm install --frozen-lockfile --ignore-scripts`, then run:

```
node --test attachment-storage.check.mjs
```

The experiment uses disposable databases, random synthetic bytes and the local
Miniflare runtime. It does not deploy, call a paid service, change an application
schema or read existing room data. Temporary databases are cleaned up after
closing their runtime handles.

Observed: **2 tests passed, zero failures/skips**, 3,239 ms. Node SQLite and
Miniflare 4.20260730.0 both passed:

- Exact lengths and SHA-256 equality for 0, 1, 256, 65,536 and 1,048,576 bytes.
- Binary persistence across database/runtime restart.
- Rolled-back insertion leaves no row.
- Duplicate ID conflicts preserve the original bytes through restart.
- Logical deletion remains absent after restart.

The Worker experiment binds an ArrayBuffer; Node binds a Buffer. It exercises
each runtime's native SQLite interface, not the full RoomStore adapter or room
authorization boundary. Deletion tests establish logical absence, not secure
erasure of disk pages or backups. Empty-file support is a storage observation,
not yet a product policy.

## Decision enabled

A small, bounded in-database pilot is technically plausible without provisioning
an object store. Use this as the next implementation candidate, subject to the
shared adapter, quota and transaction checks in the build contract. Do not
extrapolate the measured 1 MiB case to large files, enterprise scale, simultaneous
uploads or production Worker memory/CPU limits.

Before product integration, establish per-file/room/member quotas and bounded
body reads; test the actual shared adapter and migration fences; add staged
ownership, immutable message references and audited deletion; update recovery
and packaging; and complete authenticated HTTP plus the composer journey.
No public capability should advertise attachments until that integrated evidence
exists. The full acceptance criteria remain in
[Attachment build contract](ATTACHMENT-BUILD-CONTRACT-2026-09-12.md).
