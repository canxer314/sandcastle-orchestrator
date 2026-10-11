import { createServer } from 'node:http';
import { constants } from 'node:fs';
import { chmod, mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Configuration } from './config.js';

// A per-attempt transport, not the management socket. Only this role's tools exist here.
export async function serveRoleTools(directory:string, tools:NonNullable<Configuration['tools']>, attemptId:string, actualSha:string, saveError:(error:string)=>void) {
  await mkdir(directory,{mode:0o700});
  const artifacts=join(directory,'..','artifacts');await mkdir(artifacts,{mode:0o700});
  await writeFile(join(artifacts,'observations.jsonl'),'');
  await writeFile(join(directory,'call.mjs'),`import {request} from 'node:http';
try {
 const tool=process.argv[2];const input=JSON.parse(process.argv[3]);
 const result=await new Promise((resolve,reject)=>{const req=request({socketPath:process.env.ORCHESTRATOR_TOOL_SOCKET ?? '/orchestrator-tools/tools.sock',method:'POST',path:'/'},res=>{res.setEncoding('utf8');let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>{try{const value=JSON.parse(body);if(res.statusCode!==200)reject(Error(value.error));else resolve(value);}catch(error){reject(error);}});});req.on('error',reject);req.end(JSON.stringify({tool,input}));});console.log(JSON.stringify(result));
} catch(error){console.error(JSON.stringify({error:error.message}));process.exitCode=1;}
`);
  let accepting=true;
  let observationWrites=Promise.resolve();
  let observationCorrupt=false;
  const handlers=new Set<Promise<void>>();
  const server=createServer((req,res)=>{
    if(!accepting){res.statusCode=503;res.end(JSON.stringify({error:'Tool facility is closing'}));return;}
    const handling=(async()=>{
    res.setHeader('content-type','application/json');
    try {
      const chunks:Buffer[]=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>65536)throw Error('Tool request exceeds 64 KiB');chunks.push(chunk);}
      const message=JSON.parse(Buffer.concat(chunks,bytes).toString('utf8'));
      if(!message || typeof message.tool!=='string' || !Object.hasOwn(message,'input') || Object.keys(message).some(k=>!['tool','input'].includes(k)))throw Error('Invalid tool request');
      const tool=tools.find(t=>t.id===message.tool && t.read);
      if(!tool)throw Error('Tool outside authorized role scope');
      let result:unknown;let error:string|undefined;
      try {result=JSON.parse(JSON.stringify(await tool.read!(message.input)));}catch {error='Read-only tool failed; evidence unavailable';}
      // Save before delivery: model text is not a substitute for an observed result.
      // Serialize whole JSONL records, not reads: large appendFile calls can interleave.
      const observation=JSON.stringify({attemptId,actualSha,observedAt:new Date().toISOString(),tool:tool.id,input:message.input,...(error?{error}:{result})})+'\n';
      const saved=observationWrites.then(async()=>{
        if(observationCorrupt)throw Error('Observation rollback failed');
        // Roll back only this opened regular file, never a replacement at its path.
        const file=await open(join(artifacts,'observations.jsonl'),constants.O_WRONLY|constants.O_APPEND|constants.O_NOFOLLOW|constants.O_NONBLOCK);
        try {
          const before=await file.stat();
          if(!before.isFile())throw Error('Observation artifact is not a regular file');
          try {await file.appendFile(observation);}
          catch(error){
            try {await file.truncate(before.size);}
            catch {observationCorrupt=true;}
            throw error;
          }
        } finally {await file.close();}
      });
      observationWrites=saved.catch(()=>{}); // A failed save must not poison later writes.
      try {await saved;}
      catch {const message='Tool observation could not be saved; result not delivered';saveError(message);throw Error(message);}
      if(error)throw Error(error);
      res.end(JSON.stringify(result));
    }catch(error){res.statusCode=400;res.end(JSON.stringify({error:error instanceof Error?error.message:'Tool operation failed'}));}
    })();
    handlers.add(handling);
    void handling.then(()=>handlers.delete(handling),()=>handlers.delete(handling));
  });
  const socket=join(directory,'tools.sock');
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});
  await chmod(socket,0o600);
  let closing:Promise<void>|undefined;
  return {close:()=>{
    if(closing)return closing;
    accepting=false;
    // HTTP close waits for responses, not async handlers after a client disconnects.
    const closed=new Promise<Error|undefined>(resolve=>server.close(resolve));
    closing=(async()=>{
      await Promise.all(handlers);
      const error=await closed;
      if(error)throw error;
    })();
    return closing;
  }};
}
