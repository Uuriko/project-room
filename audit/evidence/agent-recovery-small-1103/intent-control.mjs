import assert from 'node:assert/strict';
import {closestToolName} from '../../../server/mcp-arg-errors.mjs';
import {listedMcpTools} from '../../../server/mcp-discovery.mjs';
const names=listedMcpTools('full').map(t=>t.name);
const results=['room_send_invoice','room_write_file','room_close_connection','room_read_reply','room_get_review'].map(name=>({name,suggestion:closestToolName(name,names)}));
console.log(JSON.stringify(results));
assert.ok(results.every(r=>r.suggestion===null),'unrelated objects and read requests must not suggest these writes');
