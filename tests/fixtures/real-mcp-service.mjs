// Read-only native stdio MCP fixture; nonce exists only after an actual tools/call.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
for await (const line of createInterface({input:process.stdin})) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  if (request.method === 'initialize') result = {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'readonly-acceptance',version:'1'}};
  else if (request.method === 'tools/list') result = {tools:[{name:'inspect',description:'Return a readonly acceptance fact and a fresh nonce. No external work.',inputSchema:{type:'object',properties:{},additionalProperties:false}}]};
  else if (request.method === 'tools/call' && request.params?.name === 'inspect') {
    const feedback = {outcome:'success',summary:'readonly lighthouse feedback',nonce:randomUUID(),logs:{readable:false},remoteStopped:null};
    appendFileSync('/tmp/issue-23-mcp-evidence.jsonl', JSON.stringify({method:request.method,tool:request.params.name,feedback})+'\n');
    result = {content:[{type:'text',text:JSON.stringify(feedback)}]};
  } else { process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Unavailable'}})+'\n'); continue; }
  if (request.method !== 'tools/call') appendFileSync('/tmp/issue-23-mcp-evidence.jsonl',JSON.stringify({method:request.method})+'\n');
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
}
