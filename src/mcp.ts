import { createServer } from 'node:net';
import { constants } from 'node:fs';
import { z } from 'zod';
import { chmod, mkdir, writeFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { Configuration } from './config.js';
import type { Records } from './records.js';
import { execute } from './execution.js';
import { checkToolEvidenceDirectories } from './paths.js';

// The container needs only Node: all validation, business code and Docker execution stay host-side.
const preview=(value:string | undefined,bytes:number)=>{
  if(value===undefined)return;
  let text=Buffer.from(value).subarray(0,bytes).toString('utf8');
  while(Buffer.byteLength(JSON.stringify(text))>bytes)text=text.slice(0,Math.floor(text.length/2));
  return text;
};
const bridge=`const {connect}=require('node:net');const s=connect(process.argv[2]);s.on('error',()=>process.exit(1));s.on('close',()=>process.exit());process.stdin.pipe(s);s.pipe(process.stdout);`;
export async function openRoleTools(records:Records,config:Configuration,{executionId,attemptId,directory,workspace,actualSha,toolIds}:{executionId:string;attemptId:string;directory:string;workspace:string;actualSha:string;toolIds:string[]}) {
  const deployed=config.tools?.filter(t=>toolIds.includes(t.id) && t.capability) ?? [];
  if(!deployed.length)return;
  const mcpDirectory=join(directory,'mcp');await mkdir(mcpDirectory,{mode:0o700});
  await writeFile(join(mcpDirectory,'bridge.cjs'),bridge,{mode:0o600});
  await writeFile(join(mcpDirectory,'config.json'),JSON.stringify({mcpServers:{orchestrator:{command:'node',args:['/orchestrator-mcp/bridge.cjs','/orchestrator-mcp/tools.sock']}}}));
  const calls:Record<string,any>[]=[];let active=false;let unknown=false;let closed=false;let idle:Promise<void>=Promise.resolve();let releaseIdle:()=>void=()=>{};
  const sessions:ReturnType<typeof serveStdio>[]=[];
  const server=createServer(socket=>{
    const handle=serveStdio(()=>{
      const mcp=new McpServer({name:'orchestrator',version:'1'});
      for(const tool of deployed)mcp.registerTool(tool.id,{description:tool.description,inputSchema:tool.inputSchema!},async input=>{
        if(closed || active || unknown)throw Error('Tool execution unavailable: closed, busy or previous result unknown');
        const parent=records.show(executionId).attempts.find(a=>a.id===attemptId);
        if(!parent || parent.cancellation || !['starting','running'].includes(parent.runState) || parent.stopConfirmation)throw Error('Attempt no longer allows tool execution');
        const capability=config.capabilities.find(c=>c.id===tool.capability)!;
        active=true;idle=new Promise(resolve=>{releaseIdle=resolve});
        const number=calls.length+1;const callDirectory=join(directory,'tools',String(number));
        const facts:Record<string,any>={id:String(number),tool:tool.id,capability:capability.id,environment:capability.environment,actualSha,attemptId,runState:'starting'};calls.push(facts);
        let validated=false;const save=(result:Record<string,any>)=>{Object.assign(facts,result);records.updateAttempt(attemptId,{toolCalls:calls})};
        try {
          const originalInput=JSON.stringify(input);await capability.validate(input);validated=true;save({});await mkdir(callDirectory,{recursive:true,mode:0o700});
          const result=await execute(records,config,executionId,'',{attemptId,capability:capability.id,input:JSON.parse(originalInput),actualSha,workspace,directory:callDirectory,callId:String(number),save});
          unknown=result?.runState==='unknown' || !!result?.persistenceError;
          const {workspace:_,artifactsDirectory:__,...summary}=result ?? {};const json=JSON.stringify({...summary,attemptId,actualSha,callId:String(number),files:{stdout:'stdout.log',stderr:'stderr.log'},readTool:'read_tool_file'});await writeFile(join(callDirectory,'result.json'),json,{mode:0o600});return {content:[{type:'text',text:Buffer.byteLength(json)<=16384?json:JSON.stringify({attemptId,actualSha,callId:String(number),runState:result?.runState,contract:result?.contract,businessPreview:preview(JSON.stringify(result?.business),8192),error:preview(result?.error,1024),contractError:preview(result?.contractError,1024),artifactsPreview:preview(JSON.stringify(result?.artifacts),1024),summaryTruncated:true,resultFile:'result.json',readTool:'read_tool_file'})}],isError:result?.runState!=='completed' || result?.contract!=='valid'};
        }catch(error){if(!validated){calls.pop();return {content:[{type:'text',text:'Capability input validation failed'}],isError:true}}unknown=true;try{save({runState:'unknown',error:'Required tool execution or record operation failed'})}catch(saveError){records.markUnresolved(attemptId,saveError)}return {content:[{type:'text',text:JSON.stringify({attemptId,actualSha,callId:String(number),runState:'unknown',error:'Tool execution or persistence failed; inspect current attempt'})}],isError:true};}finally{active=false;releaseIdle()}
      });
      mcp.registerTool('read_tool_file',{
        description:'Read full tool stdout/stderr or registered artifact in 64 KiB base64 chunks. Use kind: artifact to read registered artifacts named stdout.log, stderr.log or result.json. Only current attempt call references; nextOffset advances until truncated=false.',
        inputSchema:z.object({callId:z.string().regex(/^[1-9][0-9]*$/),name:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),kind:z.enum(['artifact']).optional(),offset:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0)}).strict(),
      },async ({callId,name,kind,offset})=>{
        const facts=calls.find(c=>c.id===callId);if(!facts)throw Error('Tool call not found');
        const log=kind!=='artifact' && ['stdout.log','stderr.log'].includes(name);const result=kind!=='artifact' && name==='result.json';
        if(!log && !result && !facts.artifacts?.some((a:{name:string})=>a.name===name))throw Error('Artifact not registered');
        const path=join(directory,'tools',callId,...(log || result?[]:['artifacts']),name);
        await checkToolEvidenceDirectories(directory,callId,!log && !result);
        const file=await open(path,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat=await file.stat();if(!stat.isFile())throw Error('Not a regular file');
          const buffer=Buffer.alloc(Math.min(65536,Math.max(0,stat.size-offset)));const {bytesRead}=await file.read(buffer,0,buffer.length,offset);
          return {content:[{type:'text',text:JSON.stringify({attemptId,actualSha,callId,name,encoding:'base64',content:buffer.subarray(0,bytesRead).toString('base64'),nextOffset:offset+bytesRead,truncated:offset+bytesRead<stat.size,complete:log?facts.logs?.complete===true:true})}]};
        }finally{await file.close()}
      });
      return mcp;
    },{transport:new StdioServerTransport(socket,socket,{maxBufferSize:1024*1024})});sessions.push(handle);
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(join(mcpDirectory,'tools.sock'),resolve)});await chmod(join(mcpDirectory,'tools.sock'),0o600);
  records.updateAttempt(attemptId,{mcpDirectory,toolCalls:calls});
  return {mcpDirectory,unresolved:()=>active || unknown,close:async()=>{closed=true;server.close();await idle;await Promise.all(sessions.map(s=>s.close()))}};
}

import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { AgentProvider } from '@ai-hero/sandcastle';
import type { McpConnection, Role } from './config.js';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// Native Claude Code configuration; no MCP client, proxy, or tool contract translation.
export function configureClaudeMcp(agent: AgentProvider, connections: McpConnection[]): AgentProvider {
  return {...agent, buildPrintCommand(options) {
    const original = agent.buildPrintCommand(options);
    const files = connections.map(c => quote(c.configFile)).join(' ');
    return {...original, command: `${original.command} --strict-mcp-config --mcp-config ${files}`};
  }};
}

export async function prepareMcp(config: Configuration, role: Role, context: {repo: string; actualSha: string; workspace: string; attemptId: string}) {
  const mounts: {hostPath: string; sandboxPath: string}[] = [];
  const connections: McpConnection[] = [];
  const facts = [];
  for (const reference of role.mcp ?? []) {
    const service = config.mcpServices!.find(s => s.id === reference.service)!;
    for (const capability of reference.requiredCapabilities ?? []) {
      if (service.capabilities[capability] === null) throw Error(`MCP required capability unavailable: ${service.id}/${capability}`);
    }
    let prepared: Awaited<ReturnType<typeof service.prepare>>;
    try { prepared = await service.prepare(context); }
    catch { throw Error(`MCP service preparation unavailable: ${service.id}`); }
    if (service.context === 'code' && (!prepared.binding || prepared.binding.repo !== context.repo || prepared.binding.actualSha !== context.actualSha || typeof prepared.binding.location !== 'string' || !prepared.binding.location)) throw Error(`MCP trusted context mismatch: ${service.id}`);
    let hostPath: string;
    try {
      if (!isAbsolute(prepared.configFile)) throw Error('absolute path required');
      hostPath = await realpath(prepared.configFile);
      if (!(await stat(hostPath)).isFile()) throw Error('regular file required');
    } catch { throw Error(`MCP configuration unavailable: ${service.id}`); }
    const sandboxPath = `/orchestrator-mcp/${service.id}.json`;
    mounts.push({hostPath, sandboxPath});
    connections.push({service: service.id, configFile: sandboxPath, tools: reference.tools});
    // Persist only explicitly public descriptions and trusted binding, never native config or credentials.
    facts.push({service: service.id, tools: reference.tools, capabilities: service.capabilities, access: service.access, context: service.context, binding: prepared.binding && {repo:prepared.binding.repo,actualSha:prepared.binding.actualSha,location:prepared.binding.location}});
  }
  return {mounts, connections, facts};
}
