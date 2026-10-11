// Controlled harness speaks native MCP stdio using the actual provider's CLI flags.
// It is not Claude Code and does not call a model.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
const args=process.argv.slice(2);
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
const index=args.indexOf('--mcp-config');
if(index<0 || !args.includes('--strict-mcp-config'))throw Error('Native MCP flags missing');
const config=JSON.parse(await readFile(args[index+1],'utf8'));
const server=config.mcpServers.existing;
const child=spawn(server.command,server.args,{env:{PATH:process.env.PATH,...server.env},stdio:['pipe','pipe','pipe']});
const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
let id=0;
const lines=createInterface({input:child.stdout});
lines.on('line',line=>{const response=JSON.parse(line);pending.get(response.id)?.resolve(response.result);pending.delete(response.id)});
child.on('error',()=>{for(const p of pending.values())p.reject(Error('Service unavailable'))});
child.on('exit',()=>{for(const p of pending.values())p.reject(Error('Service unavailable'))});
const rpc=(method:string,params:unknown={})=>new Promise<any>((resolve,reject)=>{const next=++id;pending.set(next,{resolve,reject});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:next,method,params})+'\n')});
let report;
let dispatched=false;
try{
  await rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'controlled-harness',version:'1'}});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const tools=await rpc('tools/list');
  if(!tools.tools.some((t:any)=>t.name==='inspect'))throw Error('Required MCP tool unavailable: inspect');
  dispatched=true;
  const feedback=await rpc('tools/call',{name:'inspect',arguments:{}});
  report=JSON.parse(feedback.content[0].text);
}catch(error){report={outcome:dispatched?'unknown':'fault',summary:dispatched?'connection lost after dispatch':error instanceof Error && error.message==='Required MCP tool unavailable: inspect'?error.message:'MCP service unavailable',remoteStopped:null};}
finally{child.stdin.end();}
if(!prompt.includes('existing'))throw Error('Role service context missing');
process.stdout.write(JSON.stringify({type:'result',result:JSON.stringify(report)})+'\n');
