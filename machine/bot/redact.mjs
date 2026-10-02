// Room posts, local state, and logs must not carry a provider key or a
// bearer. The key stays in the secret store and in the provider request header.

export function redact(text, secrets) {
  let out = String(text ?? "");
  const list = Array.isArray(secrets) ? secrets : [];
  for (const secret of list) {
    if (typeof secret !== "string" || secret.length < 8) continue;
    if (!out.includes(secret)) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}
