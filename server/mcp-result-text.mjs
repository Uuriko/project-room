// MCP tool results carry the same value twice: structuredContent for the
// machine client, and a human-readable text block. Hosts render the text
// block to the user and routinely log tool-result text verbatim, so a
// credential repeated there is persisted wherever the transcript goes.
// A credential a tool mints (an identity secret, its private key, a
// one-time invite code) lives in structuredContent only: renderers pass
// the credential values here, and every occurrence in the text rendering —
// including next-step prose that quotes the value — is replaced with a
// pointer to the structuredContent field that carries it (issue #3750).

// redactions: [{ secret, where }] — secret is the credential value to
// withhold; where names its structuredContent home (for example
// "structuredContent.secret"). Non-string or empty secrets are skipped,
// so a result that carries no credential renders exactly as before.
// Build entries with mcpRedaction() rather than an inline object literal:
// the constructor keeps the credential field in shorthand form at every
// call site.
export function mcpRedaction(secret, where) {
  return { secret, where };
}
export function mcpResultText(value, redactions = []) {
  let text = JSON.stringify(value);
  for (const { secret, where } of redactions) {
    if (typeof secret !== "string" || secret.length === 0) continue;
    text = text.split(secret).join(`(withheld from this text — the value is in ${where})`);
  }
  return text;
}
