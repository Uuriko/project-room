# Resolution evidence link

`buildResolutionEvidenceLink` turns one real upstream terminal resolution hash into a deterministic downstream evidence reference. The immutable, domain-separated record names source and target lane/stage plus observation time. It rejects malformed hashes, invalid timestamps, self-links, unknown fields, identity PII and content; source payloads are never embedded.
