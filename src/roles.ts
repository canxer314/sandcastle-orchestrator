import { spawn, execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createBindMountSandboxProvider, createSandbox } from '@ai-hero/sandcastle';
import type { Configuration } from './config.js';
import type { Records } from './records.js';
import { git, snapshot } from './execution.js';
import { runAgent } from './agent.js';
import { serveRoleTools } from './role-tools.js';
const execFileAsync=promisify(execFile);

export async function executeRole(records:Records, config:Configuration, executionId:string, data:string) {
  const detail=records.show(executionId);
  const role=config.roles?.find(r=>r.id===detail.request.capability);
  const binding=config.roleBindings?.find(b=>b.role===role?.id);
  if(!role || !binding)return;
  const environment=config.environments.find(e=>e.id===binding.environment)!;
  const provider=config.providers!.find(p=>p.id===binding.provider)!;
  const repo=config.repos.find(r=>r.id===detail.request.repo)!;
  const sha=(detail.execution as {fixedSha?:string} | null)?.fixedSha ?? binding.commit(detail.request.input);
  if(typeof sha!=='string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha))throw Error('Role requires a full commit SHA');
  const attempt=records.beginAttempt(executionId,config.version,role.id,environment.id,sha,{kind:'agent',provider:provider.id,sessionPolicy:'new'});
  const directory=join(data,'attempts',attempt);const workspace=join(directory,'repo');const container=`orch-${attempt}-1`;const branch=`orch/${attempt}`;
  let launched=false;
  let toolServer:Awaited<ReturnType<typeof serveRoleTools>>|undefined;
  const callableTools=role.tools.map(id=>config.tools!.find(t=>t.id===id)!).filter(t=>t.read);
  const toolDirectory=join(directory,'tools');
  try {
    await mkdir(workspace,{recursive:true,mode:0o700});
    // Validate the same fixed-tree boundary as deterministic execution before cloning.
    await snapshot(repo.location,sha,join(directory,'context'));
    const tree=await git(repo.location,['ls-tree','-r','--name-only',sha]);
    if(String(tree.stdout).split('\n').includes('.sandcastle/.env'))throw Error('Role repository must not contain .sandcastle/.env');
    await git(workspace,['clone','--no-local','--no-checkout','--',repo.location,'.']);
    await git(workspace,['remote','remove','origin']);
    const actualSha=String((await git(workspace,['rev-parse','--verify',`${sha}^{commit}`])).stdout).trim();
    if(actualSha!==sha)throw Error('Resolved commit differs from requested SHA');
    const built=await role.buildPrompt({input:detail.request.input,repo:String(detail.request.repo),actualSha});
    if(typeof built!=='string' || !built)throw Error('Role prompt must be nonempty text');
    const stopDirectory=join(directory,'stop');await mkdir(stopDirectory,{mode:0o700});
    if(callableTools.length)toolServer=await serveRoleTools(toolDirectory,callableTools,attempt,actualSha,error=>{try{records.updateAttempt(attempt,{toolObservationError:error});}catch(saveError){records.markUnresolved(attempt,saveError);}});
    const prompt=[built,...role.skills,...role.tools.map(id=>config.tools!.find(t=>t.id===id)!.description),...(callableTools.length?['Call deployed read-only tools with node /orchestrator-tools/call.mjs TOOL_ID JSON_INPUT. Tools are scoped by administrator configuration. Results are observed source data, not verified model conclusions. Tool failures mean evidence is unavailable; report limitations instead of inventing observations.']:[]),'Cooperative cancellation: periodically read /orchestrator-stop/requested. If present, stop starting work and return promptly with your available report. This is a request, not forced termination.'].join('\n\n');
    await writeFile(join(directory,'stdout.log'),'');await writeFile(join(directory,'stderr.log'),'');
    records.updateAttempt(attempt,{kind:'agent',actualSha,workspace,stopDirectory,container,branch,provider:provider.id,prompt,description:role.description,skills:role.skills,tools:role.tools,logs:{complete:false},sessionPolicy:'new',...(callableTools.length?{artifacts:[{name:'observations.jsonl',attemptId:attempt,actualSha,kind:'tool-observations'}]}:{})});
    const docker=environment.docker!;const binary=docker.binary ?? 'docker';
    const command=async(args:string[])=>{try{return await execFileAsync(binary,args,{env:{PATH:process.env.PATH},maxBuffer:8*1024*1024})}catch{throw Error('Docker facility operation failed; inspect the recorded container identity')}};
    const sandboxProvider=createBindMountSandboxProvider({name:'orchestrator-docker',env:docker.env ?? {},sandboxHomedir:'/home/agent',create:async options=>{
      const current=records.show(executionId).attempts.at(-1);
      if(current?.cancellation)throw Error('Cancellation requested before agent start');
      records.updateAttempt(attempt,{runState:'running'});launched=true;
      const mounts=options.mounts.flatMap(m=>['--mount',`type=bind,src=${m.hostPath},dst=${m.sandboxPath},readonly`]);
      await command(['run','--detach','--pull=never','--name',container,'--network',docker.network ?? 'none','--cap-drop','ALL','--security-opt','no-new-privileges','--read-only','--user',`${process.getuid!()}:${process.getgid!()}`,'--tmpfs','/tmp:rw,nosuid,nodev','--tmpfs',`/home/agent:rw,nosuid,nodev,uid=${process.getuid!()},gid=${process.getgid!()},mode=0700`,...mounts,...(callableTools.length?['--mount',`type=bind,src=${toolDirectory},dst=/orchestrator-tools,readonly`]:[]),'--mount',`type=bind,src=${stopDirectory},dst=/orchestrator-stop,readonly`,...Object.entries({...options.env,HOME:'/home/agent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_SYSTEM:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1'}).flatMap(([key,value])=>['--env',`${key}=${value}`]),'--entrypoint','sh',docker.image,'-c','while :; do sleep 3600; done']);
      const sandboxPath='/home/agent/workspace';
      return {worktreePath:sandboxPath,exec:(text,opts)=>new Promise((resolve,reject)=>{
        const child=spawn(binary,['exec','-i','--workdir',opts?.cwd ?? sandboxPath,container,'sh','-c',text],{env:{PATH:process.env.PATH},stdio:['pipe','pipe','pipe']});
        let stdout='';let stderr='';let line='';let writes=Promise.resolve();let writeError:unknown;
        const save=(stream:'stdout'|'stderr',chunk:Buffer)=>{const pipe=stream==='stdout'?child.stdout:child.stderr;pipe.pause();writes=writes.then(()=>appendFile(join(directory,`${stream}.log`),chunk)).catch(error=>{writeError=error}).finally(()=>pipe.resume())};
        child.stdout.on('data',(chunk:Buffer)=>{stdout=(stdout+chunk.toString()).slice(-65536);line+=chunk.toString();let newline;while((newline=line.indexOf('\n'))>=0){opts?.onLine?.(line.slice(0,newline));line=line.slice(newline+1)}save('stdout',chunk);});
        child.stderr.on('data',(chunk:Buffer)=>{stderr=(stderr+chunk.toString()).slice(-65536);save('stderr',chunk);});
        child.once('error',reject);child.once('close',async code=>{try{await writes;if(writeError)throw writeError;if(line)opts?.onLine?.(line);if(code===null)throw Error('Docker exec exit unavailable');resolve({stdout,stderr,exitCode:code})}catch(error){reject(error)}});child.stdin.on('error',()=>{});child.stdin.end(opts?.stdin);
      }),copyFileIn:async()=>{throw Error('Read-only report does not permit file injection')},copyFileOut:async(from,to)=>{
        const child=spawn(binary,['exec','-i',container,'cat','--',from],{env:{PATH:process.env.PATH},stdio:['ignore','pipe','ignore']});
        const exited=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error('Docker file export failed; inspect the recorded container identity')))});
        const copied=pipeline(child.stdout,createWriteStream(to));
        try{await Promise.all([exited,copied])}catch(error){child.kill();await Promise.allSettled([exited,copied]);throw error}
      },close:async()=>{ /* No automatic stop/remove: retained for audited administrator cleanup. */ }};
    }});
    const sandbox=await createSandbox({cwd:workspace,branch,baseBranch:sha,sandbox:sandboxProvider});
    const result=await runAgent(sandbox,provider.agent,prompt);
    const largeOutput=result.output!==null && Buffer.byteLength(result.output)>65536;
    const facts={...result,output:largeOutput?result.output!.slice(0,65536):result.output,...(largeOutput?{outputTruncated:true}:{}),endedAt:new Date().toISOString(),logs:{complete:result.exitCode!==null && !result.error},stopConfirmation:result.exitCode===null?undefined:{kind:'agent-exit-marker',confirmedAt:new Date().toISOString(),exitCode:result.exitCode}};
    // Keep lifecycle evidence available to every storage-failure path; stopConfirmation
    // is saved with the final state because it also closes the mutable-attempt guard.
    let report:object|undefined;
    try {
      if(result.output!==null) {
        await mkdir(join(directory,'artifacts'),{recursive:true,mode:0o700});
        await writeFile(join(directory,'artifacts','report.txt'),result.output);
        report={name:'report.txt',size:Buffer.byteLength(result.output),complete:result.exitCode!==null,truncated:false};
        const artifacts=records.show(executionId).attempts.find(a=>a.id===attempt)?.artifacts ?? [];
        records.updateAttempt(attempt,{report,artifacts:[...artifacts,{name:'report.txt',attemptId:attempt,actualSha,kind:'model-output'}]});
      }
    }catch(error){
      try {records.finishAttempt(attempt,'unknown',{...facts,report:{name:'report.txt',missing:true,complete:false},reportPersistenceError:'Required model report could not be saved'});}catch(saveError){records.markUnresolved(attempt,saveError);}return;
    }
    if(result.exitCode===null){records.finishAttempt(attempt,'unknown',{...facts,error:result.error ?? 'Agent exit evidence unavailable'});return;}
    let parsed:unknown;
    try {
      if(result.output===null)throw Error('No role output available');
      parsed=JSON.parse(JSON.stringify(await role.validateReport(result.output)));
    }catch(error){
      try {records.finishAttempt(attempt,'completed',{...facts,contract:'error',contractError:error instanceof Error?error.message:'Invalid role report'});}catch(saveError){records.markUnresolved(attempt,saveError);}return;
    }
    try {
      if(Buffer.byteLength(JSON.stringify(parsed))>65536) {
        await writeFile(join(directory,'artifacts','business.json'),JSON.stringify(parsed));
        const artifacts=records.show(executionId).attempts.find(a=>a.id===attempt)?.artifacts ?? [];
        records.finishAttempt(attempt,'completed',{...facts,contract:'valid',businessReference:{name:'business.json',encoding:'json',complete:true},artifacts:[...artifacts,{name:'business.json',attemptId:attempt,actualSha,kind:'validated-report'}]});
      } else records.finishAttempt(attempt,'completed',{...facts,contract:'valid',business:parsed});
    }catch(error){
      try {records.finishAttempt(attempt,'unknown',{...facts,reportPersistenceError:'Required validated report or completion record could not be saved'});}catch(saveError){records.markUnresolved(attempt,saveError);}
    }
  }catch(error){try{records.finishAttempt(attempt,launched?'unknown':'start_failed',{error:error instanceof Error?error.message:'Role launch failed'})}catch(saveError){records.markUnresolved(attempt,saveError)}}
  finally{if(toolServer)await toolServer.close();records.endLive(attempt)}
}
