// Canonical H content uses the established v2 serving digest and the existing
// resumable SHA state. Source/receipt authority stays with replay-cutover.
import {initialReplayHash,advanceReplayHash,finishReplayHash,encodeReplayHash,decodeReplayHash} from './replay-sha256.mjs';
import {MESSAGE_PROOF_FIELDS} from './write-integrity.mjs';
const push=(encoded,bytes)=>encodeReplayHash(advanceReplayHash(decodeReplayHash(encoded),Buffer.from(bytes)));
export function advanceCanonicalH({state,header,readMetadata,readRange,nextMessage,readMessage,nextWork,readWork,archiveInfo,readRetained,stageRetained,hasRetained}) {
 let c=state.canonicalH;
 if(!c){
  const marker=readMetadata('messageAuthority');
  if(!marker||marker.version!==1||!Number.isSafeInteger(marker.count)||marker.count<0||Object.keys(marker).some(k=>!['version','count'].includes(k)))throw Error('Invalid protected canonical authority marker');
  const anchored=header.historicalCheckpoint.sequence===header.head&&/^[a-f0-9]{64}$/.test(header.historicalCheckpoint.contentHash??'');
  const explicit=header.contentProofIntent;
  if(!anchored&&!(explicit?.basis==='current-write-proofs'&&explicit.checkpointComparison==='unavailable-stale'&&/^[a-f0-9]{64}$/.test(explicit.planHash??'')))throw Error('Canonical H current content checkpoint or explicit write-proof plan required');
  const archive=archiveInfo();
  c={basis:anchored?'exact-current-checkpoint':'current-write-proofs',checkpointComparison:anchored?'pending':'unavailable-stale',phase:archive?'retained':'projection',archive,retainedIndex:0,visible:0,offset:0,cursor:'',count:0,expectedVisible:marker.count,expectedCount:marker.count+(archive?.count??0),hash:push(encodeReplayHash(initialReplayHash()),header.roomId+'\0'+header.head+'\0')};
 }
 if(c.phase==='retained'){
  if(c.retainedIndex<c.archive.retainedCount){
   const id=readRetained(c.retainedIndex);
   if(typeof id!=='string'||Buffer.byteLength(id)<1||Buffer.byteLength(id)>200||hasRetained(id))throw Error('Canonical archive retained identity invalid or repeated');
   const source=readMessage(id);if(source.absent||source.row.seq>c.archive.throughSeq)throw Error('Canonical archive retained identity lacks protected H member');
   stageRetained(id,c.retainedIndex);c={...c,retainedIndex:c.retainedIndex+1};
  }else c={...c,phase:'projection'};
 }else if(c.phase==='projection'){
  const length=Math.min(16384,header.bytes-c.offset);
  if(length)c={...c,hash:push(c.hash,readRange(c.offset,length)),offset:c.offset+length};
  if(c.offset===header.bytes)c={...c,phase:'messages',hash:push(c.hash,'\0canonical-messages-v1\0')};
 }else if(c.phase==='messages'){
  const key=nextMessage(c.cursor);
  if(key!==null){
   const source=readMessage(key);c={...c,cursor:key};
   if(!source.absent){const text=JSON.stringify(MESSAGE_PROOF_FIELDS.map(field=>source.row[field]));c={...c,count:c.count+1,visible:c.visible+(!c.archive||source.row.seq>c.archive.throughSeq||hasRetained(key)?1:0),hash:push(c.hash,Buffer.byteLength(text)+':'+text)};}
   if(c.count>c.expectedCount)throw Error('Canonical H complete membership count differs');
  }else{
   if(c.count!==c.expectedCount||c.visible!==c.expectedVisible)throw Error('Canonical H complete membership count differs');
   c={...c,phase:state.hHasWorkReferences?'work':'finish',cursor:''};
   if(state.hHasWorkReferences)c={...c,hash:push(c.hash,'\0canonical-work-v1\0')};
  }
 }else if(c.phase==='work'){
  const key=nextWork(c.cursor);
  if(key!==null){const source=readWork(key);c={...c,cursor:key};if(!source.absent){const text=JSON.stringify(['work_id','revision','digest','body'].map(field=>source.row[field]));c={...c,hash:push(c.hash,Buffer.byteLength(text)+':'+text)};}}
  else c={...c,phase:'finish'};
 }else if(c.phase==='finish'){
  const currentDigest=finishReplayHash(decodeReplayHash(c.hash));
  if(c.basis!=='current-write-proofs'&&currentDigest!==header.historicalCheckpoint.contentHash)throw Error('Canonical H complete content digest differs');
  c={...c,phase:'qualified',contentHash:currentDigest,checkpointComparison:c.basis==='current-write-proofs'?'unavailable-stale':'matched'};
 }
 return {...state,canonicalH:c,hMessageCount:c.count,hCanonicalCount:c.count,hMessagesQualified:c.phase==='qualified'};
}
