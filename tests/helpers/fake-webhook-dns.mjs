// Test-only DNS seam for the webhook SSRF gate. The production gate in
// server/outbound-webhooks.mjs (assertAgentWebhookUrlPublic) is fully
// fail-closed for every name — there is deliberately no reserved-name
// exemption there (Instinct-3 review, PR #1590). Suites that register
// fixture webhook URLs (https://*.test etc.) through the HTTP or MCP
// subscription surface therefore install one of these fakes with
// store.agentPlugin.setWebhookLookup(...), or pass { lookup } straight to
// assertSubscriptionWebhookUrl. Production wiring never uses these.
export const fakePublicWebhookLookup = async host => {
  void host;
  return [{ address: "93.184.216.34", family: 4 }];
};

export const fakeThrowingWebhookLookup = (code = "ENOTFOUND") => async host => {
  const error = new Error(`${code} ${host}`);
  error.code = code;
  throw error;
};

export const fakeEmptyWebhookLookup = async () => [];

export function installFakeWebhookDns(store, lookup = fakePublicWebhookLookup) {
  store.agentPlugin.setWebhookLookup(lookup);
  return store;
}
