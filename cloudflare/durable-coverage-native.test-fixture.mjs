// Actual production constructor/routes; test-only raw prepared-writer probe.
import {ProjectRoom} from './room.mjs';
export class DurableCoverageRoom extends ProjectRoom {
 constructor(ctx,env){super(ctx,env);this.preparedWriter=this.store.db.prepare("UPDATE credentials SET revoked=1 WHERE kind='access'");}
 async fetch(request){if(new URL(request.url).pathname==='/__prepared-write'){let refused=false,error;try{this.preparedWriter.run();}catch(cause){refused=true;error=cause.message;}return Response.json({refused,error});}return super.fetch(request);}
}
export default{fetch(request,env){const u=new URL(request.url),surface=u.searchParams.get('surface')??'target';u.searchParams.delete('surface');const headers=new Headers(request.headers);headers.set('Host','room.example.test');headers.set('x-room-visitor-ip','192.0.2.1');const options={method:request.method,headers};if(!['GET','HEAD'].includes(request.method))options.body=request.body;return env.ROOM.getByName(surface).fetch(new Request(u,options));}};
