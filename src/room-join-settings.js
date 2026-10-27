export function createRoomJoinSettings({client, getState, section}) {
  const select=section.querySelector("select"),status=section.querySelector('[role="status"]');
  let epoch=0,scope=null,current=null,busy=false;
  function owner() { const state=getState();return state?.room?.id===client.session?.roomId&&state.room.ownerId===client.session?.member?.id; }
  function valid(ticket,session) { return ticket===epoch&&session===client.session&&owner(); }
  function reset() { epoch++;scope=null;current=null;busy=false;section.hidden=true; }
  async function refresh() {
    if(!owner()){reset();return;}
    const session=client.session,ticket=++epoch;scope=session;section.hidden=false;select.disabled=true;status.textContent="Checking visibility…";
    try { const result=await client.request(client.path("/join-settings"));if(!valid(ticket,session))return;
      current=result.discoverable;select.value=current?"public":"private";status.textContent="";select.disabled=false;
    }catch{if(valid(ticket,session))status.textContent="Couldn’t check visibility. Reopen settings to retry.";}
  }
  select.addEventListener("change",async()=>{
    if(busy||!owner()||scope!==client.session||typeof current!=="boolean")return;
    const session=client.session,ticket=epoch;busy=true;select.disabled=true;status.textContent="Saving…";
    try {const result=await client.request(client.path("/join-settings"),{method:"POST",data:{discoverable:select.value==="public",expectedDiscoverable:current}});
      if(!valid(ticket,session))return;current=result.discoverable;status.textContent="Saved";
    }catch{if(valid(ticket,session)){select.value=current?"public":"private";status.textContent="Couldn’t save. Reopen settings to check the current value.";}}
    finally{if(valid(ticket,session)){busy=false;select.disabled=false;}}
  });
  return {refresh,reset};
}
