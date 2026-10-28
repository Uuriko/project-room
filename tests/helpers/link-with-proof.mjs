// SECURITY-FIX C3 (#942): shared fixture helper for the identities.link()
// holder-proof gate. A direct link now consumes a link code the identity
// HOLDER minted for the room (or an approved access request on record).
// Fixtures that hold the identity's secret — the normal case: they minted
// the identity themselves — go through the real gate with this helper
// instead of calling link() bare:
//
//   import { linkWithProof } from "./helpers/link-with-proof.mjs";
//   linkWithProof(store, ownerToken, roomId, identity, { permissions: [] });
//
// `identity` is the object returned by store.identities.create(...) (or
// anything carrying { identityId, secret }). For HTTP-level fixtures that
// link through the API, mint the code here and pass it in the POST body
// as identityLinkCode:
//
//   const identityLinkCode = mintHolderLinkCode(store, identity, roomId);
//   await post(origin, `/api/rooms/${roomId}/identity-links`,
//     { identityId: identity.identityId, permissions: [], identityLinkCode }, ownerSecret);
//
// There is deliberately no bypass: the helper mints through the holder's
// secret and the link consumes through the production gate, so the suite
// exercises the proof path it ships.

export function mintHolderLinkCode(store, identity, roomId) {
  const { linkCode } = store.identities.mintLinkCode(identity.identityId, identity.secret, { roomId });
  return linkCode;
}

export function linkWithProof(store, token, roomId, identity, linkOptions = {}, expectedSessionBinding = null) {
  const identityLinkCode = mintHolderLinkCode(store, identity, roomId);
  return store.identities.link(token, roomId, {
    ...linkOptions,
    identityId: identity.identityId,
    identityLinkCode,
  }, expectedSessionBinding);
}
