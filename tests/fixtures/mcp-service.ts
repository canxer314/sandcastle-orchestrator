// Controlled native stdio MCP service. No model, container, network, or external writes.
import { createInterface } from 'node:readline';
const lines=createInterface({input:process.stdin});
for await (const line of lines) {
  const request=JSON.parse(line);
  if(request.id===undefined)continue;
  // Drop the actual stdio connection only after tools/call has reached the service.
  if(request.method==='tools/call' && process.env.MCP_MODE==='unknown')process.exit(0);
  let result:unknown;
  if(request.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'controlled-existing',version:'1'}};
  else if(request.method==='tools/list')result={tools:process.env.MCP_MODE==='missing-tool'?[]:[{name:'inspect',description:'Read controlled service facts',inputSchema:{type:'object',properties:{},additionalProperties:false}}]};
  else if(request.method==='tools/call')result={content:[{type:'text',text:JSON.stringify({outcome:'success',summary:'actual stdio feedback',log:{reference:'service://private/log',readable:false},remoteStopped:null})}]};
  else {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Unknown method'}})+'\n');continue;}
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
}
