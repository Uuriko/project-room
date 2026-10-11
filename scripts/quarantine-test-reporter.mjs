// Machine evidence is separate from test stdout: text printed by a test must
// never masquerade as proof that node:test executed the requested identity.
export default async function* quarantineEvents(source) {
  for await (const event of source) {
    if (["test:start", "test:pass", "test:summary"].includes(event.type)) yield `${JSON.stringify(event)}\n`;
  }
}
