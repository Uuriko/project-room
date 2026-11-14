// Test-only endpoints prepare a disposable room; all page reads use real routes.
import entry, {DurableCoverageRoom as Base} from './durable-coverage-native.test-fixture.mjs';
import {initialRoom} from '../server/bootstrap.mjs';

export class DurableCoverageRoom extends Base {
  async fetch(request) {
    const path = new URL(request.url).pathname, store = this.store;
    if (path === '/__webmcp-seed') {
      store.initialize(initialRoom('webmcp-fixture'), {representation:'normalized-current-v1'});
      const owner = store.issueAccessKey('webmcp-fixture','owner');
      const command = (id,type,data) => store.command(owner,'webmcp-fixture',{id,type,data});
      command('publish-room','room.public_page_set',{enabled:true});
      for (const id of ['public-task','private-task']) {
        command('propose-'+id,'work.proposed',{workItemId:id,title:id,definitionOfDone:'Test',accountableMemberId:'owner',mode:'read',ownerDecisionRequired:false,independentVerificationRequired:false});
      }
      command('publish-task','work.public_set',{workItemId:'public-task',enabled:true});
      await this.ctx.storage.put('fixture-owner',owner);
      return Response.json({ready:true});
    }
    if (path === '/__webmcp-unpublish') {
      const owner=await this.ctx.storage.get('fixture-owner');
      store.command(owner,'webmcp-fixture',{id:'unpublish-room',type:'room.public_page_set',data:{enabled:false}});
      return Response.json({ready:true});
    }
    return super.fetch(request);
  }
}
export default entry;
