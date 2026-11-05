# Normalized browser upload capability
Base328928e2. Runtime fix27a12c0ce. Before: actual new account-owned normalized room refused browser attachment before any network request; status said uploads unavailable. Actual two-file browser reproduction failed in10s. Snapshot advertised false despite qualified normalized attachment writer.

After:10/10 browser cases pass (normal batchcommit, live chips, late success/failure, room switch, file removal, logout, revocation and authreturn);11/11 normalized attachment lifecycle/visibility/export/restore tests pass. Lint/diffcheck pass. No permission, limits, persistence or attachment API changes. This changes capability advertisement to expose the existing implemented path. Not live-qualified yet.
