// Compact connection controls. The host supplies validated API responses and
// an owner key that becomes null immediately when account authority ends.
export function installMessagingConnections({list,status,api,ownerKey}) {
  let generation=0,busy=false;
  const current=(owner,turn)=>owner!==null && owner===ownerKey() && generation===turn;
  function reset() { generation++;busy=false;list.replaceChildren();status.textContent=''; }
  async function read(){
    const [value,receiving]=await Promise.all([api.twilioStatus(),api.receivingStatus?.().catch(()=>null)]);
    return {...value,receiving:receiving?.enabled?receiving.connections:[],receivingUnavailable:Boolean(api.receivingStatus)&&!receiving};
  }
  function render(connections,owner,turn,receiving=[]) {
    const doc=list.ownerDocument;
    list.replaceChildren(...connections.map(c=>{
      const row=doc.createElement('div'),label=doc.createElement('p');
      const name=c.provider==='sms'?'SMS':'WhatsApp';
      label.textContent=name+(c.state==='active'?'':c.state==='disconnected'?' · Disconnected':' · Setup needed');
      row.append(label);
      if(c.state==='active') {
        const button=doc.createElement('button');button.type='button';button.className='text-button';
        button.textContent='Disconnect';button.setAttribute('aria-label',`Disconnect ${name}`);button.disabled=busy;
        button.addEventListener('click',()=>{if(current(owner,turn))disconnect(c);});row.append(button);
      }
      const permission=receiving.find(p=>p.connectionId===c.connectionId&&p.provider===c.provider);
      if(permission){
        const details=doc.createElement('details'),summary=doc.createElement('summary'),explanation=doc.createElement('p');
        summary.textContent='Receiving';details.append(summary);
        explanation.textContent=permission.state==='active'
          ?'Allowed until '+new Date(permission.expiresAt).toLocaleString()+'.'
          :'Allow incoming messages for 24 hours, even after sign-out. No sending or sharing.';
        details.append(explanation);
        const actions=[];
        if(permission.state!=='active'&&permission.canStart)actions.push('start');
        if(permission.revision>0&&permission.state!=='revoked')actions.push('stop');
        for(const action of actions){
          const button=doc.createElement('button');button.type='button';button.className='text-button';button.disabled=busy;
          button.textContent=action==='stop'?'Stop receiving':'Allow for 24 hours';
          button.setAttribute('aria-label',button.textContent+' · '+name);
          button.addEventListener('click',()=>{if(current(owner,turn))change(permission,action);});details.append(button);
        }
        row.append(details);
      }
      return row;
    }));
  }
  async function load() {
    if(busy)return;
    const owner=ownerKey(),turn=++generation;list.replaceChildren();status.textContent='';
    if(owner===null)return;
    try {const value=await read();if(current(owner,turn)){
      render(value.connections,owner,turn,value.receiving);
      if(value.receivingUnavailable)status.textContent='Receiving permission unavailable. Refresh to check.';
    }}
    catch {if(current(owner,turn))status.textContent='Messaging status unavailable.';}
  }
  async function disconnect(connection) {
    return change(connection,'disconnect');
  }
  async function change(connection,action) {
    const owner=ownerKey();if(owner===null||busy)return;
    const turn=++generation;busy=true;status.textContent=action==='disconnect'?'Disconnecting…':'Updating permission…';
    list.querySelectorAll('button').forEach(b=>{b.disabled=true;});
    let confirmed=false;
    try {
      const data={connectionId:connection.connectionId,expectedRevision:connection.revision};
      if(action==='start')data.expectedConnectionRevision=connection.expectedConnectionRevision;
      if(action==='disconnect')await api.twilioDisconnect(data);else await api.receivingAction(action,data);
      if(!current(owner,turn))return;
      confirmed=true;
      // Do not leave a stale active control behind if the status refresh fails.
      list.replaceChildren();
      const value=await read();if(current(owner,turn))render(value.connections,owner,turn,value.receiving);
    }catch {
      if(!current(owner,turn))return;
    }finally {
      if(current(owner,turn)) {
        busy=false;list.querySelectorAll('button').forEach(b=>{b.disabled=false;});
        status.textContent=confirmed?(action==='disconnect'?'Disconnected here. Saved messages remain.':action==='start'
          ?'Receiving allowed for 24 hours.':'Receiving stopped. Saved messages remain.'):'Action unconfirmed. Refresh before trying again.';
        if(!confirmed) {
          const refresh=list.ownerDocument.createElement('button');refresh.type='button';refresh.className='text-button';refresh.textContent='Refresh';
          refresh.setAttribute('aria-label','Refresh messaging connections');
          refresh.addEventListener('click',()=>{if(current(owner,turn))load();});
          list.replaceChildren(refresh);
        }
      }
    }
  }
  return {load,reset};
}
