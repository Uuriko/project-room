// Thin adapter: HTTP and MCP share document validation, authorization and writes.
import { getRoomDocs, getRoomDoc, postRoomDoc } from './routes/room-docs.mjs';
import { DOC_ID, MAX_TITLE, MAX_BODY } from './room-docs.mjs';
import { ServiceError } from './service-error.mjs';
export function validRoomDocArgs(name, args) {
  if (name === 'room_write_doc') return DOC_ID.test(args.docId ?? '') && typeof args.title === 'string' && args.title.trim().length > 0 && args.title.length <= MAX_TITLE
    && typeof args.body === 'string' && args.body.length <= MAX_BODY && Number.isSafeInteger(args.baseRev) && args.baseRev >= 0;
  if (args.docId !== undefined) return typeof args.docId === 'string' && DOC_ID.test(args.docId) && args.limit === undefined && args.after === undefined
    && (args.rev === undefined || Number.isSafeInteger(args.rev) && args.rev >= 1);
  return args.rev === undefined && (args.limit === undefined || Number.isSafeInteger(args.limit) && args.limit >= 1 && args.limit <= 500)
    && (args.after === undefined || typeof args.after === 'string' && (args.after === '' || DOC_ID.test(args.after)));
}
export async function runRoomDocTool(store, secret, name, args, enabled) {
  const url = new URL('https://room.invalid/docs');
  for (const key of ['rev', 'limit', 'after']) if (args[key] !== undefined) url.searchParams.set(key, String(args[key]));
  const ctx = {
    store, roomDocsEnabled: enabled === true, params: {roomId: args.roomId, docId: args.docId}, req: {}, res: {}, url,
    roomCredentials: () => ({mode: 'room', bearer: true}), expectedBinding: () => null,
    roomAuth: () => store.authenticate(secret, args.roomId, null, {allowAccountSession: false}),
    // The enclosing hosted tool funnel applies credential budgets and write standing;
    // bearer calls have no browser cookie/CSRF boundary.
    protectWrite: () => {}, rate: () => {},
    body: async () => ({title: args.title, body: args.body, baseRev: args.baseRev}),
    reject: (status, code, message) => { throw new ServiceError(status, code, message); },
    json: (_res, _status, value) => value,
  };
  return name === 'room_write_doc' ? postRoomDoc(ctx) : args.docId === undefined ? getRoomDocs(ctx) : getRoomDoc(ctx);
}
