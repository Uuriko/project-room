// DIE = Demigod matching desk internally. Public tool names never say DIE.
// Deep-link only: no auto-send of profiles, no identity until mutual yes.
// Compute stays a separate run factory. Do not PUT demigod-html from here.

export const MATCHING_DESK_ORIGIN = "https://www.trydemigod.com";
export const MATCHING_DESK_HIRE = `${MATCHING_DESK_ORIGIN}/hire`;
export const MATCHING_DESK_TOOL_NAME = "room_open_matching_desk";

export function matchingDeskFeeCopy() {
  return "10% of first-year base after a verified start. Stripe-hosted invoice to the hiring company. Talent never pays. Mutual yes before intro. No 90-day replacement unless written.";
}

export function matchingDeskDeepLink({ workItemId, roomId } = {}) {
  const url = new URL(MATCHING_DESK_ORIGIN);
  url.pathname = "/";
  url.hash = "fee";
  if (workItemId) url.searchParams.set("work_item", workItemId);
  if (roomId) url.searchParams.set("room", roomId);
  return url.toString();
}

export function matchingDeskTool() {
  return {
    name: MATCHING_DESK_TOOL_NAME,
    description:
      "Open the Demigod matching desk (SF seed/Series A first engineering seats). Deep-link only. Does not send candidate names, start a search, or bill anyone. Use when a Work Item is a hiring brief. Talent stays private until mutual yes.",
    inputSchema: {
      type: "object",
      properties: {
        workItemId: { type: "string", minLength: 1, maxLength: 128 },
        roomId: { type: "string", minLength: 1, maxLength: 128 }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  };
}

export function matchingDeskCall(args = {}) {
  const href = matchingDeskDeepLink(args);
  if (href.includes("/api") || /die\b/i.test(href)) {
    throw new Error("Matching desk link must stay on the public Demigod origin");
  }
  return {
    href,
    fee: matchingDeskFeeCopy(),
    loop: "One brief, one profile. Software compares. A human proposes. Mutual yes before intro.",
    sendsIdentity: false,
    startsSearch: false,
    compute: false
  };
}
