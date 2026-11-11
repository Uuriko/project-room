import sys,json,re
buf="";decoder=json.JSONDecoder()
methods={'fetch','probeStorage','readJobHealth','ensureJobAlarm','runSlowJob','recordCronTick','recordCronAttempt','verifyRoomIntegrity','alarm','exportRoomNdjson'}
stages={'worker_wait_started','worker_rpc_started','do_entered','sql_completed','do_completed','worker_rpc_settled','worker_response'}
events={'room.readiness_probe','room.do_request','room.cold_start','room.sql_cost','room.do_initialized','room.scheduler_reconciliation_failed'}
numbers={'status','epochMs','elapsedMs','probeWaitMs','timeoutMs','durationMs','appMs','cpuMs','sqlElapsedMs','doElapsedMs','initializationMs','storeInitializationMs','authoritySqlElapsedMs','authorityDoElapsedMs'}
tokens={'stage','outcome','method','scopeKind','operation','probeRole','authorityObservation','authoritySqlOutcome'}
stamps={'sourceRevision','buildId','authoritySourceRevision','authorityBuildId'}
def safe_log(value):
 if isinstance(value,str):
  try:value=json.loads(value)
  except:return None
 if not isinstance(value,dict) or value.get('event') not in events:return None
 out={'event':value['event']}
 for key in numbers:
  v=value.get(key)
  if isinstance(v,(int,float)) and not isinstance(v,bool) and 0<=v<=9007199254740991:out[key]=v
 for key in tokens:
  v=value.get(key)
  if isinstance(v,str) and re.fullmatch(r'[a-zA-Z0-9_.-]{1,64}',v):out[key]=v
 for key in stamps:
  v=value.get(key)
  if v is None or isinstance(v,str) and (re.fullmatch(r'[a-f0-9]{40}',v) or re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z',v)):out[key]=v
 return out
for line in sys.stdin:
 buf+=line
 if len(buf)>2097152:buf=""
 while True:
  begin=buf.find('{')
  if begin<0:buf="";break
  buf=buf[begin:]
  try:v,end=decoder.raw_decode(buf)
  except json.JSONDecodeError:break
  buf=buf[end:]
  if not isinstance(v,dict):continue
  out={'outcome':v.get('outcome') if v.get('outcome') in ('ok','canceled','exception','exceededCpu','exceededMemory','unknown') else 'other'}
  if isinstance(v.get('scriptName'),str) and re.fullmatch(r'project-room[a-z0-9-]*',v['scriptName']):out['scriptName']=v['scriptName']
  if isinstance(v.get('eventTimestamp'),(int,float)):out['eventTimestamp']=v['eventTimestamp']
  event=v.get('event') if isinstance(v.get('event'),dict) else {}
  response=event.get('response') if isinstance(event.get('response'),dict) else {}
  if isinstance(response.get('status'),int):out['responseStatus']=response['status']
  for method in (event.get('rpcMethod'),event.get('method'),(event.get('rpc') or {}).get('method') if isinstance(event.get('rpc'),dict) else None):
   if method in methods:out['rpcMethod']=method
  req=event.get('request') if isinstance(event.get('request'),dict) else {}
  if req.get('method') in ('GET','POST','HEAD','OPTIONS','DELETE','PUT','PATCH'):out['requestMethod']=req['method']
  out['exceptions']=[]
  for ex in v.get('exceptions',[]):
   msg=str(ex.get('message',''))
   out['exceptions'].append({'knownCategories':[category for category in ('exceeded CPU','CPU time limit','Too many','SQLITE_FULL','database or disk is full','storage limit','memory limit','blockConcurrencyWhile','Deadlock','DO_SQLITE_OVERLOADED','D1_ERROR','storage operation exceeded timeout') if category.lower() in msg.lower()]})
  logs=[]
  for entry in v.get('logs',[]):
   messages=entry.get('message',[])
   if not isinstance(messages,list):messages=[messages]
   for m in messages:
    safe=safe_log(m)
    if safe is not None:logs.append(safe)
  out['logs']=logs
  print(json.dumps(out,separators=(',',':')),flush=True)
