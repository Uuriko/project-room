const PARTITIONED_MAPS=new Set(['members','channels','workItems','replyRequests','messagesArchive']);
const RESTORE_MAPS=new Set([...PARTITIONED_MAPS,'seenEvents','seenIdempotencyKeys','helpOffers','agentHalts','bonds']);
const sourceLimit=state=>state?.version===3?state.sourceBytes:4*1024*1024;
const tokenLimit = state => state?.version === 3?state.sourceBytes : REPLAY_CODEC_TOKEN_BYTES;
// Bounded byte scanner for the immutable captured at-rest JSON. It partitions
// existing bytes; record semantics remain in projection-at-rest and applyEvent.
export const REPLAY_CODEC_TOKEN_BYTES = 128 * 1024;
export const REPLAY_CODEC_CONTROL_BYTES = 8192;
export const REPLAY_CODEC_INPUT_BYTES = 16 * 1024;
const whitespace = byte => byte===32 || byte===9 || byte===10 || byte===13;
const decode = bytes => new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
const fail = () => {throw Error('unsupported or corrupt replay projection codec');};
export function initialProjectionScan(){
  return {version:2,offset:0,phase:'start',key:'',keys:[],keyBytes:[],keyEscape:false,
    tokenStart:0,depth:0,string:false,escape:false,messageIndex:0,kind:'metadata',canEnd:true,entryKey:'',entryKeyOffset:0,entryKeyLength:0,mapStart:0,mapIndex:0,arrayStart:0,arrayIndex:0};
}
// Restore uses the very same scanner over a separately sealed source length.
// The cursor is framing only; source provenance, JSON semantics and checkpoint
// fallback remain the caller's responsibility. Default cutover limits do not move.
export function initialRecoveryProjectionScan(sourceBytes){
  if(!Number.isSafeInteger(sourceBytes)||sourceBytes<2)fail();
  return {...initialProjectionScan(),version:3,sourceBytes};
}
function validate(state){
  if(!state || ![2,3].includes(state.version) || (state.version===3&&(!Number.isSafeInteger(state.sourceBytes)||state.sourceBytes<2)) || !Number.isSafeInteger(state.offset) || state.offset<0 || state.offset>sourceLimit(state)
    || !['start','key-or-end','key','colon','messages-start','message-or-end','value','after-value','after-message','map-start','map-key-or-end','map-key','map-colon','after-map-entry','nested-array-start','nested-array-entry-or-end','after-nested-array-entry','done'].includes(state.phase)
    || !Number.isSafeInteger(state.depth) || state.depth<0 || state.depth>64
    || !Number.isSafeInteger(state.tokenStart) || state.tokenStart<0 || state.tokenStart>state.offset
    || !Number.isSafeInteger(state.messageIndex) || state.messageIndex<0 || state.messageIndex>1000000
    || !Array.isArray(state.keys) || state.keys.length>64 || state.keys.some(k=>typeof k!=='string'||new TextEncoder().encode(k).length>200)
    || new Set(state.keys).size!==state.keys.length || typeof state.key!=='string' || new TextEncoder().encode(state.key).length>200
    || !Array.isArray(state.keyBytes) || state.keyBytes.length>512 || state.keyBytes.some(x=>!Number.isInteger(x)||x<0||x>255)
    || !['metadata','message','metadata-entry','metadata-index',...(state.version===3?['array-entry']:[])].includes(state.kind)
    || typeof state.entryKey!=='string'||new TextEncoder().encode(state.entryKey).length>200
    || !['entryKeyOffset','entryKeyLength','mapStart','mapIndex','arrayStart','arrayIndex'].every(k=>Number.isSafeInteger(state[k])&&state[k]>=0&&state[k]<=sourceLimit(state))
    || ['keyEscape','string','escape','canEnd'].some(k=>typeof state[k]!=='boolean')
    || new TextEncoder().encode(JSON.stringify(state)).length>REPLAY_CODEC_CONTROL_BYTES)fail();
}

// The result records spans only. A complete small token is already in input;
// a spanning token is fetched once from the immutable witness by its bounded
// byte range. No growing token buffer or repeated prefix serialization exists.
export function scanProjectionChunk(current,input,options={}){
  if(current?.version!==2)fail();return scanChunk(current,input,options);
}
export function scanRecoveryProjectionChunk(current,input,options={}){
  if(current?.version!==3)fail();return scanChunk(current,input,options);
}
function scanChunk(current,input,{maximumRecords=32}={}){
  // Old non-nested continuation states acquire only fixed zero controls.
  current={...current,...(!Object.hasOwn(current??{},'arrayStart')?{arrayStart:0}:{}),...(!Object.hasOwn(current??{},'arrayIndex')?{arrayIndex:0}:{})};
  validate(current);
  if ( ! ( input instanceof Uint8Array ) || input . length > REPLAY_CODEC_INPUT_BYTES
    || !Number.isInteger(maximumRecords)||maximumRecords<1||maximumRecords>32)fail();
  const state=structuredClone(current),records=[];let i=0;
  const take=()=>{i++;state.offset++;};
  const finishNestedArray=()=>{
    records.push({kind:'metadata-array',key:state.key,entryKey:state.entryKey,index:state.mapIndex++,
      keyOffset:state.entryKeyOffset,keyLength:state.entryKeyLength,offset:state.arrayStart,
      length:state.offset-state.arrayStart,entries:state.arrayIndex});
    state.phase='after-map-entry';
  };
  while(i<input.length && records.length<maximumRecords){
    const byte=input[i];
    if(state.phase==='start'){
      if(whitespace(byte)){take();continue;}if(byte!==123)fail();state.phase='key-or-end';state.canEnd=true;take();continue;
    }
    if(state.phase==='key-or-end'){
      if(whitespace(byte)){take();continue;}
      if(byte===125){if(!state.canEnd)fail();state.phase='done';take();continue;}
      if(byte!==34)fail();state.keyBytes=[byte];state.keyEscape=false;state.phase='key';take();continue;
    }
    if(state.phase==='key'||state.phase==='map-key'){
      const entry=state.phase==='map-key';
      if(state.keyBytes.length>=512)fail();state.keyBytes.push(byte);take();
      if(state.keyEscape){state.keyEscape=false;continue;}
      if(byte===92){state.keyEscape=true;continue;}
      if(byte!==34)continue;
      const key=JSON.parse(decode(new Uint8Array(state.keyBytes)));
      if(typeof key!=='string'||new TextEncoder().encode(key).length>200)fail();
      if(entry){state.entryKey=key;state.entryKeyLength=state.offset-state.entryKeyOffset;state.phase='map-colon';}
      else{if(state.keys.includes(key)||state.keys.length>=64)fail();state.key=key;state.keys.push(key);state.phase='colon';}
      state.keyBytes=[];continue;
    }
    if(state.phase==='colon'){
      if(whitespace(byte)){take();continue;}if(byte!==58)fail();take();
      state.phase = (state.key === 'messages' || state.version === 3 && state.key === 'eventLog')?'messages-start' : (state.version === 3?RESTORE_MAPS : PARTITIONED_MAPS).has(state.key)?'map-start' : 'value';state.kind = 'metadata';state.tokenStart = state.offset;continue;
    }
    if(state.phase==='map-start'){
      if(whitespace(byte)){take();continue;}
      if(state.key==='messagesArchive'&&byte!==123){state.phase='value';state.kind='metadata';state.tokenStart=state.offset;continue;}
      if(byte!==123)fail();state.mapStart=state.offset;state.mapIndex=0;take();state.phase='map-key-or-end';state.canEnd=true;continue;
    }
    if(state.phase==='map-key-or-end'){
      if(whitespace(byte)){take();continue;}
      if(byte===125){
        if(!state.canEnd)fail();take();
        records.push({kind:'metadata-map',key:state.key,offset:state.mapStart,length:state.offset-state.mapStart,entries:state.mapIndex});
        state.phase='after-value';continue;
      }
      if(byte!==34)fail();state.entryKeyOffset=state.offset;state.keyBytes=[byte];state.keyEscape=false;state.phase='map-key';take();continue;
    }
    if(state.phase==='map-colon'){
      if(whitespace(byte)){take();continue;}if(byte!==58)fail();take();
      state.phase=state.key==='messagesArchive'&&state.entryKey==='retainedIds'?'nested-array-start':'value';
      state.kind='metadata-entry';state.tokenStart=state.offset;continue;
    }
    if(state.phase==='after-map-entry'){
      if(whitespace(byte)){take();continue;}
      if(byte===44){state.phase='map-key-or-end';state.canEnd=false;take();continue;}
      if(byte===125){
        take();records.push({kind:'metadata-map',key:state.key,offset:state.mapStart,length:state.offset-state.mapStart,entries:state.mapIndex});
        state.phase='after-value';continue;
      }
      fail();
    }
    if(state.phase==='nested-array-start'){
      if(whitespace(byte)){take();continue;}if(byte!==91)fail();
      state.arrayStart=state.offset;state.arrayIndex=0;take();state.phase='nested-array-entry-or-end';state.canEnd=true;continue;
    }
    if(state.phase==='nested-array-entry-or-end'){
      if(whitespace(byte)){take();continue;}
      if(byte===93){if(!state.canEnd)fail();take();finishNestedArray();continue;}
      state.phase='value';state.kind='metadata-index';state.tokenStart=state.offset;continue;
    }
    if(state.phase==='after-nested-array-entry'){
      if(whitespace(byte)){take();continue;}
      if(byte===44){state.phase='nested-array-entry-or-end';state.canEnd=false;take();continue;}
      if(byte===93){take();finishNestedArray();continue;}fail();
    }
    if(state.phase==='messages-start'){
      if(whitespace(byte)){take();continue;}if(byte!==91)fail();take();state.phase='message-or-end';state.arrayIndex=0;state.canEnd=true;continue;
    }
    if(state.phase==='message-or-end'){
      if(whitespace(byte)){take();continue;}
      if(byte===93){if(!state.canEnd)fail();take();state.phase='after-value';continue;}
      state.phase='value';state.kind=state.version===3&&state.key==='eventLog'?'array-entry':'message';state.tokenStart=state.offset;continue;
    }
    if(state.phase==='value'){
      const empty=state.offset===state.tokenStart;
      if(empty&&whitespace(byte)){take();state.tokenStart=state.offset;continue;}
      if(!state.string && state.depth===0 && !empty && (whitespace(byte)||byte===44||byte===93||byte===125)){
        const length = state . offset - state . tokenStart ; if ( length < 1 || length > tokenLimit(state) ) fail ( ) ;
        records.push({kind:state.kind,key:state.key,index:state.kind==='message'?state.messageIndex++:state.kind==='metadata-entry'?state.mapIndex++:['metadata-index','array-entry'].includes(state.kind)?state.arrayIndex++:null,offset:state.tokenStart,length,
          ...(['metadata-entry','metadata-index'].includes(state.kind)?{entryKey:state.entryKey}:{ }),
          ...(state.kind==='metadata-entry'?{keyOffset:state.entryKeyOffset,keyLength:state.entryKeyLength}:{})});
        state.phase=['message','array-entry'].includes(state.kind)?'after-message':state.kind==='metadata-entry'?'after-map-entry':state.kind==='metadata-index'?'after-nested-array-entry':'after-value';continue;
      }
      if(!state.string){
        if(byte===34)state.string=true;
        else if(byte===123||byte===91){if(++state.depth>64)fail();}
        else if(byte===125||byte===93){if(state.depth===0)fail();state.depth--;}
      }else if(state.escape)state.escape=false;
      else if(byte===92)state.escape=true;
      else if(byte===34)state.string=false;
      take();if(state.offset-state.tokenStart>tokenLimit(state))fail();continue;
    }
    if(state.phase==='after-message'){
      if(whitespace(byte)){take();continue;}
      if(byte===44){state.phase='message-or-end';state.canEnd=false;take();continue;}
      if(byte===93){state.phase='after-value';take();continue;}fail();
    }
    if(state.phase==='after-value'){
      if(whitespace(byte)){take();continue;}
      if(byte===44){state.phase='key-or-end';state.canEnd=false;take();continue;}
      if(byte===125){state.phase='done';take();continue;}fail();
    }
    if(state.phase==='done'){if(!whitespace(byte))fail();take();continue;}
    fail();
  }
  validate(state);return {state,records,consumed:i,complete:state.phase==='done'};
}

export function decodeProjectionSpan(bytes,record){return decodeSpan(bytes,record,REPLAY_CODEC_TOKEN_BYTES);}
export function decodeRecoveryProjectionSpan(bytes,record,sourceBytes){
  if(!Number.isSafeInteger(sourceBytes)||sourceBytes<2||!Number.isSafeInteger(record?.offset)||record.offset<0||record.offset+record.length>sourceBytes)fail();
  return decodeSpan(bytes,record,sourceBytes);
}
function decodeSpan(bytes,record,maximumBytes){
  if ( ! ( bytes instanceof Uint8Array ) || bytes . length !== record . length || bytes . length > maximumBytes ) fail ( ) ;
  const value=JSON.parse(decode(bytes));
  if(record.kind==='message' && (!value||typeof value!=='object'||Array.isArray(value)
    || typeof value.id!=='string'||new TextEncoder().encode(value.id).length>200))fail();
  if(record.kind==='metadata-index'&&(typeof value!=='string'||new TextEncoder().encode(value).length<1||new TextEncoder().encode(value).length>200))fail();
  return value;
}

// This small descriptor preserves exact parent boundaries and entry membership
// count. It is a framing record, never a substitute for the parent's value.
export function projectionMapFrame(record){
  if(record?.kind!=='metadata-map'||!PARTITIONED_MAPS.has(record.key)
    ||!Number.isSafeInteger(record.offset)||record.offset<0||!Number.isSafeInteger(record.length)||record.length<2
    || record . offset + record . length > 4 * 1024 * 1024 || ! Number . isSafeInteger ( record . entries ) || record . entries < 0 || record . entries > 1000000 ) fail ( ) ;
  return {version:1,kind:'entry-map',parent:record.key,offset:record.offset,length:record.length,entries:record.entries};
}


export function projectionArrayFrame(record){
  if(record?.kind!=='metadata-array'||record.key!=='messagesArchive'||record.entryKey!=='retainedIds'
    ||!Number.isSafeInteger(record.offset)||record.offset<0||!Number.isSafeInteger(record.length)||record.length<2
    || record . offset + record . length > 4 * 1024 * 1024 || ! Number . isSafeInteger ( record . entries ) || record . entries < 0 || record . entries > 1000000 ) fail ( ) ;
  return {version:1,kind:'entry-array',parent:record.key,member:record.entryKey,offset:record.offset,length:record.length,entries:record.entries};
}

// A restore parent is bound to the same sealed checkpoint as its leaf spans.
// It is not accepted by the cutover frame readers (which keep their old limit).
export function recoveryProjectionFrame(record,sourceBytes){
  if(!Number.isSafeInteger(sourceBytes)||sourceBytes<2||!record
    ||!Number.isSafeInteger(record.offset)||record.offset<0||!Number.isSafeInteger(record.length)||record.length<2
    ||record.offset+record.length>sourceBytes||!Number.isSafeInteger(record.entries)||record.entries<0||record.entries>1000000)fail();
  if(record.kind==='metadata-map'&&RESTORE_MAPS.has(record.key))return{version:1,kind:'entry-map',parent:record.key,offset:record.offset,length:record.length,entries:record.entries};
  if(record.kind==='metadata-array'&&record.key==='messagesArchive'&&record.entryKey==='retainedIds')return{version:1,kind:'entry-array',parent:record.key,member:record.entryKey,offset:record.offset,length:record.length,entries:record.entries};
  fail();
}
