// Validate the bounded catch-up contract before an agent uses its checkpoint.
// A digest is a summary of a window, never proof that its events were handled.
const integer = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.length > 0;
const caps = { messages: 3, work: 4, attention: 5, decisions: 2 };
const countMap = value => object(value) && Object.values(value).every(integer);
const sum = value => Object.values(value).reduce((total, count) => total + count, 0);

export function validRoomDigest(value, { roomId, memberId, since }) {
  if(value?.contractVersion===2)return validCurrentDigest(value,{roomId,memberId,since});
  if (!object(value) || Buffer.byteLength(JSON.stringify(value), "utf8") > 4096
    || value.contractVersion !== 1 || value.roomId !== roomId || !text(value.viewerId)
    || memberId && value.viewerId !== memberId || value.untrusted !== true
    || !integer(value.since) || !integer(value.through) || value.through < value.since
    || value.next !== value.through || value.requestedSince !== since || value.since < since
    || (value.since > since ? value.floorApplied !== true : value.floorApplied !== undefined)
    || typeof value.evaluatedAt !== "string" || !Number.isFinite(Date.parse(value.evaluatedAt))) return false;
  const c = value.coverage;
  if (!object(c) || c.fromSeq !== value.since + 1 || c.toSeq !== value.through
    || !integer(c.eventsInWindow) || c.eventsInWindow > value.through - value.since
    || !countMap(c.byType) || sum(c.byType) !== c.eventsInWindow
    || ![c.workChangedTotal, c.attentionTotal, c.messagesTotal].every(integer)
    || c.messagesTotal !== (c.byType["message.posted"] ?? 0)
    || (c.messagesTotal > 0 ? value.bodiesOmitted !== c.messagesTotal : value.bodiesOmitted !== undefined)) return false;
  const context = value.context;
  if (!object(context) || !/^[a-f0-9]{64}$/.test(context.context_version)
    || ![context.rosterCount, context.focusWorkTotal, context.decisionsTotal, context.locksTotal].every(integer)
    || !Array.isArray(context.omitted) || !context.omitted.every(text)
    || !object(value.actionableNow) || !integer(value.actionableNow.total)
    || !countMap(value.actionableNow.byKind) || sum(value.actionableNow.byKind) !== value.actionableNow.total) return false;
  for (const [key, limit] of Object.entries(caps)) {
    const rows = value[key];
    if (!Array.isArray(rows) || rows.length > limit) return false;
    let previous = value.since;
    for (const row of rows) {
      if (!object(row) || !integer(row.seq) || row.seq <= value.since || row.seq > value.through || row.seq < previous) return false;
      previous = row.seq;
      if (key === "decisions") { if (!text(row.type)) return false; }
      else if (!text(row.id)) return false;
      if (["messages", "attention"].includes(key) && (typeof row.summary !== "string" || row.summary.length > 140)) return false;
      if (key === "attention" && !text(row.kind)) return false;
    }
  }
  if (value.work.length > c.workChangedTotal || value.attention.length > c.attentionTotal || value.messages.length > c.messagesTotal) return false;
  if (value.truncated !== undefined && (!countMap(value.truncated)
    || Object.entries(value.truncated).some(([key, count]) => !(key in caps) || count < 1))) return false;
  const room = encodeURIComponent(roomId), follow = value.followUps;
  return object(follow)
    && follow.events === `GET /api/rooms/${room}/events?after=${value.since}&limit=100`
    && follow.work === `GET /api/rooms/${room}/work-claims/{id}`
    && follow.context === `GET /api/rooms/${room}/context`
    && follow.updates === `GET /api/rooms/${room}/updates`;
}

function validCurrentDigest(v,{roomId,memberId,since}){
 if(!object(v)||Buffer.byteLength(JSON.stringify(v))>16384||v.roomId!==roomId||!text(v.viewerId)||memberId&&v.viewerId!==memberId||v.untrusted!==true||v.since!==since||v.requestedSince!==since||!integer(v.through)||v.through<since||typeof v.evaluatedAt!=='string'||!Number.isFinite(Date.parse(v.evaluatedAt)))return false;
 const w=v.sourceWindow,c=v.coverage,n=w?.nextRead;
 if(!object(w)||typeof w.complete!=='boolean'||w.coverage?.mode!=='native_bounded'||w.coverage.globalAttentionComplete!==false||!Array.isArray(w.coverage.omitted)||!w.coverage.omitted.every(text)||v.next!==(w.complete?v.through:since))return false;
 const source=w.coverage;if(source.available!==true||typeof source.conversation?.complete!=='boolean'||typeof source.standingWorkAndRequests?.complete!=='boolean'||w.complete!==(source.conversation.complete&&source.standingWorkAndRequests.complete)||!integer(source.conversation.examined)||source.conversation.examined>4||source.conversation.direction!=='catch_up')return false;
 if(w.complete?n!==null:!object(n)||Object.keys(n).sort().join(' ')!=='cursor since'||n.since!==since||!text(n.cursor)||Buffer.byteLength(n.cursor)>12288)return false;
 if(!object(c)||!['eventsInWindow','byType','workChangedTotal','attentionTotal','messagesTotal'].every(k=>c[k]===null)||v.actionableNow?.total!==null||v.actionableNow.complete!==false||!object(v.context)||!/^[a-f0-9]{64}$/.test(v.context.context_version))return false;
 if(!Array.isArray(v.attention)||v.attention.length>9||!Array.isArray(v.work)||v.work.length>1||c.attentionReturned!==v.attention.length)return false;
 for(const item of [...v.attention,...v.work])if(!object(item)||item.roomId!==roomId||!text(item.id)||!text(item.kind)||!integer(item.seq)||typeof item.summary!=='string'||item.summary.length>140||!object(item.next)||!text(item.next.tool)||!object(item.next.arguments)||item.next.arguments.roomId!==roomId)return false;
 const path=`GET /api/rooms/${encodeURIComponent(roomId)}`;
 return v.followUps?.context===path+'/context'&&v.followUps.events===path+`/events?after=${since}&limit=4`;
}
