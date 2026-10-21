// "aside:" messages: a human can talk in the room without pulling agents in.
// A human message whose body starts with "aside:" (any case, leading space
// allowed) wakes no agent, creates no mention or reply row, and does not
// count as needs-me. It still lands in the room and stays readable.
export const ASIDE_RE = /^\s*aside:/i;

export const isAsideBody = body => typeof body === "string" && ASIDE_RE.test(body);

// True only for a human sender; agents cannot use aside to go quiet.
export function isHumanAside(members, senderMemberId, body) {
  const sender = members?.[senderMemberId];
  return sender?.kind === "human" && isAsideBody(body);
}
