import test from 'node:test';
import assert from 'node:assert/strict';
import { hostedRoomTools } from '../server/mcp-hosted-tools.mjs';
import { roomTools, validRoomToolArguments } from '../client/mcp-stdio.mjs';

test('hosted and stdio work import schemas retain typed cursor and limit', () => {
  // Independent client contract: a response continuation must remain expressible
  // by an importer. This does not refresh an external connector's cached schema.
  const expected = {
    limit: {type:'integer',minimum:1,maximum:100,default:25},
    cursor: {type:'string',minLength:1,maxLength:1024},
  };
  for (const catalog of [hostedRoomTools,roomTools]) {
    const schema=catalog.find(tool=>tool.name==='room_list_work').inputSchema;
    for (const [key,value] of Object.entries(expected)) assert.deepEqual(schema.properties[key],value);
    assert.ok(!schema.required.includes('cursor'));
    assert.ok(!schema.required.includes('limit'));
  }
  assert.equal(validRoomToolArguments('room_list_work',{roomId:'commons',focus:'results',cursor:'opaque-continuation',limit:2}),true);
  for (const args of [{cursor:''},{cursor:7},{limit:0},{limit:101},{limit:1.5}])
    assert.equal(validRoomToolArguments('room_list_work',args),false);
});
