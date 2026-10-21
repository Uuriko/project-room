// Group review (Town-style "pressure-test this draft").
// The author posts one draft to several members; each answers with its top
// objections (at most three) or "none". Everything lands on one review
// record, so the author reads one list instead of chasing N threads.
//
// POST /api/rooms/{roomId}/reviews                    { requestId, draft, reviewers } reviewers: member ids, or ["*"] for everyone else
// GET  /api/rooms/{roomId}/reviews/{reviewId}         draft, objections so far, waitingOn, complete
// GET  /api/rooms/{roomId}/reviews?mine=asked         reviews still waiting on the caller
// POST /api/rooms/{roomId}/reviews/{reviewId}/objections  { objections: [..] } or { none: true } named reviewers only
import { ownMember } from "../../src/events.js";
import { randomUUID } from "node:crypto";

const SCHEMA = `CREATE TABLE IF NOT EXISTS group_reviews (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL, author_id TEXT NOT NULL, request_id TEXT NOT NULL,
  draft TEXT NOT NULL, reviewers TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(room_id, author_id, request_id));
CREATE TABLE IF NOT EXISTS group_review_answers (
  review_id TEXT NOT NULL, member_id TEXT NOT NULL, objections TEXT NOT NULL, answered_at INTEGER NOT NULL,
  PRIMARY KEY(review_id, member_id))`;
const ready = new WeakSet();
export function ensureGroupReviews(db) { if (!ready.has(db)) { db.exec(SCHEMA); ready.add(db); } return db; }
export const MAX_REVIEWERS = 12, MAX_OBJECTIONS = 3;

function access(ctx, write) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const auth = ctx.roomAuth(selected, roomId, fence);
  if (!auth?.member?.id) ctx.reject(401, "unauthenticated", "Room membership required");
  if (selected.bearer && auth.credentialScope !== "room") ctx.reject(403, "access_denied", "Bearer account sessions are not accepted");
  if (write) {
    ctx.protectWrite(ctx.req, auth, selected.bearer);
    if (auth.kind === "api-key" && !(auth.apiKeyScopes ?? []).some(s => s === "rooms:write" || s === "rooms:*")) ctx.reject(403, "insufficient_scope", "API key lacks rooms:write");
    ctx.rate(`write:${auth.credentialHash}`, 60);
  } else ctx.rate(`read:${auth.credentialHash}`, 600);
  return { roomId, auth };
}

// Resolve ["*"] or a list of ids to active members other than the author.
export function resolveReviewers(members, authorId, list) {
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_REVIEWERS * 2) return null;
  const active = Object.keys(members ?? {}).filter(id => id !== authorId && ownMember(members, id)?.active !== false);
  const picked = list.length === 1 && list[0] === "*" ? active : [...new Set(list)];
  if (picked.length === 0 || picked.length > MAX_REVIEWERS || picked.some(id => typeof id !== "string" || !active.includes(id))) return null;
  return picked;
}

function reviewView(db, row) {
  const reviewers = JSON.parse(row.reviewers);
  const answers = db.prepare("SELECT member_id,objections,answered_at FROM group_review_answers WHERE review_id=? ORDER BY answered_at").all(row.id);
  const answered = new Set(answers.map(a => a.member_id));
  return { id: row.id, roomId: row.room_id, authorId: row.author_id, draft: row.draft, reviewers,
    objections: answers.flatMap(a => JSON.parse(a.objections).map(text => ({ memberId: a.member_id, text }))),
    noObjection: answers.filter(a => JSON.parse(a.objections).length === 0).map(a => a.member_id),
    waitingOn: reviewers.filter(id => !answered.has(id)), complete: reviewers.every(id => answered.has(id)),
    createdAt: new Date(row.created_at).toISOString() };
}

function review(ctx, roomId) {
  const row = ensureGroupReviews(ctx.store.db).prepare("SELECT * FROM group_reviews WHERE room_id=? AND id=?").get(roomId, ctx.params.reviewId);
  if (!row) ctx.reject(404, "review_not_found", "No such review in this room");
  return row;
}

export async function createReview(ctx) {
  const { roomId, auth } = access(ctx, true);
  const data = await ctx.body(ctx.req);
  const draft = typeof data?.draft === "string" ? data.draft.trim() : "";
  if (typeof data?.requestId !== "string" || !data.requestId || !draft || draft.length > 20000) ctx.reject(422, "invalid_review", "Supply requestId and a draft of at most 20000 characters");
  const reviewers = resolveReviewers(ctx.store.roomAuthority(roomId).members, auth.member.id, data.reviewers);
  if (!reviewers) ctx.reject(422, "invalid_reviewers", `reviewers is ["*"] or 1 to ${MAX_REVIEWERS} other active member ids`);
  const db = ensureGroupReviews(ctx.store.db);
  const prior = db.prepare("SELECT * FROM group_reviews WHERE room_id=? AND author_id=? AND request_id=?").get(roomId, auth.member.id, data.requestId);
  if (prior) return ctx.json(ctx.res, 200, reviewView(db, prior));
  const id = `rev_${randomUUID()}`;
  db.prepare("INSERT INTO group_reviews(id,room_id,author_id,request_id,draft,reviewers,created_at) VALUES(?,?,?,?,?,?,?)")
    .run(id, roomId, auth.member.id, data.requestId, draft, JSON.stringify(reviewers), ctx.store.now());
  return ctx.json(ctx.res, 201, reviewView(db, db.prepare("SELECT * FROM group_reviews WHERE id=?").get(id)));
}

export function readReview(ctx) {
  const { roomId } = access(ctx, false);
  return ctx.json(ctx.res, 200, reviewView(ctx.store.db, review(ctx, roomId)));
}

export function listReviews(ctx) {
  const { roomId, auth } = access(ctx, false);
  const db = ensureGroupReviews(ctx.store.db);
  const rows = db.prepare("SELECT * FROM group_reviews WHERE room_id=? ORDER BY created_at DESC LIMIT 100").all(roomId).map(row => reviewView(db, row));
  const mine = ctx.url.searchParams.get("mine");
  if (mine !== null && mine !== "asked" && mine !== "authored") ctx.reject(422, "invalid_review_filter", "mine is asked or authored");
  const picked = mine === "asked" ? rows.filter(r => r.waitingOn.includes(auth.member.id)) : mine === "authored" ? rows.filter(r => r.authorId === auth.member.id) : rows;
  return ctx.json(ctx.res, 200, { roomId, reviews: picked });
}

export async function answerReview(ctx) {
  const { roomId, auth } = access(ctx, true);
  const row = review(ctx, roomId);
  if (!JSON.parse(row.reviewers).includes(auth.member.id)) ctx.reject(403, "reviewer_required", "Only a named reviewer answers this review");
  const data = await ctx.body(ctx.req);
  const list = data?.none === true ? [] : data?.objections;
  if (!Array.isArray(list) || (data?.none !== true && list.length === 0) || list.length > MAX_OBJECTIONS
    || list.some(text => typeof text !== "string" || !text.trim() || text.length > 1000))
    ctx.reject(422, "invalid_objections", `Supply objections (1 to ${MAX_OBJECTIONS}, each at most 1000 characters) or none: true`);
  ctx.store.db.prepare(`INSERT INTO group_review_answers(review_id,member_id,objections,answered_at) VALUES(?,?,?,?)
    ON CONFLICT(review_id,member_id) DO UPDATE SET objections=excluded.objections, answered_at=excluded.answered_at`)
    .run(row.id, auth.member.id, JSON.stringify(list.map(text => text.trim())), ctx.store.now());
  return ctx.json(ctx.res, 200, reviewView(ctx.store.db, row));
}

const params = Object.freeze({ type: "object", required: ["roomId"], properties: { roomId: { type: "string" } } });
const reviewParams = Object.freeze({ type: "object", required: ["roomId", "reviewId"], properties: { roomId: { type: "string" }, reviewId: { type: "string" } } });
const response = Object.freeze({ type: "object" });
const parity = "exempt:HTTP-first; fan-out over #4351 addressing and an MCP tool follow once #4339 lands";
const row = (id, method, path, handler, p) => Object.freeze({ id, method, path, auth: "room", capability: null, scope: "room", handler, parity, schema: { params: p, response }, events: [] });
export const GROUP_REVIEW_ROUTES = Object.freeze([
  row("reviews-create", "POST", "/api/rooms/{roomId}/reviews", createReview, params),
  row("reviews-list", "GET", "/api/rooms/{roomId}/reviews", listReviews, params),
  row("reviews-read", "GET", "/api/rooms/{roomId}/reviews/{reviewId}", readReview, reviewParams),
  row("reviews-answer", "POST", "/api/rooms/{roomId}/reviews/{reviewId}/objections", answerReview, reviewParams),
]);
