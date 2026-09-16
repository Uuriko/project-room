# Cross-lane lineage manifest

`buildCrossLaneLineageManifest` canonicalizes two or more real evidence, control or safeguard boundary links into an immutable ordered manifest. It stores only source/target lanes and resolution/link hashes, detects exact duplicate tuples, validates observation time, excludes payloads and emits a deterministic manifest hash.
