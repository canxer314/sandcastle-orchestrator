import { spawn, execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createBindMountSandboxProvider, createSandbox } from '@ai-hero/sandcastle';
import type { Configuration } from './config.js';
import type { Records } from './records.js';
import { git, snapshot, cancelExecution } from './execution.js';
import { runAgent } from './agent.js';
import { prepareMcp } from './mcp.js';
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
  const attempt=records.beginAttempt(executionId,config.version,role.id,environment.id,sha,{kind:'agent',provider:provider.id,sessionPolicy:'new',attemptDeadlineSeconds:binding.attemptDeadlineSeconds});
  const directory=join(data,'attempts',attempt);const workspace=join(directory,'repo');const container=`orch-${attempt}-1`;const branch=`orch/${attempt}`;
  let launched=false;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineError: unknown;
  let deadlineAt: string | undefined;
  const expire=()=>{
    try{
      const current=records.show(executionId).attempts.at(-1);
      if(current?.id!==attempt || ['completed','cancelled','resolved','start_failed'].includes(current.runState))return;
      const remaining=Date.parse(deadlineAt!)-Date.now();
      if(remaining>0){deadlineTimer=setTimeout(expire,Math.min(remaining,2147483647));return;}
      records.cancel(executionId,'Explicit attempt deadline reached','deadline');void cancelExecution(records,executionId).catch(error=>records.markUnresolved(attempt,error));
    }catch(error){deadlineError=error;records.markUnresolved(attempt,error);}
  };
  try {
    deadlineAt=records.show(executionId).attempts.at(-1)?.deadlineAt;
    if(deadlineAt)expire();
    const stopDirectory=join(directory,'stop');await mkdir(stopDirectory,{recursive:true,mode:0o700});
    records.updateAttempt(attempt,{stopDirectory});
    await mkdir(workspace,{recursive:true,mode:0o700});
    // Validate the same fixed-tree boundary as deterministic execution before cloning.
    await snapshot(repo.location,sha,join(directory,'context'));
    const tree=await git(repo.location,['ls-tree','-r','--name-only',sha]);
    if(String(tree.stdout).split('\n').includes('.sandcastle/.env'))throw Error('Role repository must not contain .sandcastle/.env');
    await git(workspace,['clone','--no-local','--no-checkout','--',repo.location,'.']);
    await git(workspace,['remote','remove','origin']);
    const actualSha=String((await git(workspace,['rev-parse','--verify',`${sha}^{commit}`])).stdout).trim();
    if(actualSha!==sha)throw Error('Resolved commit differs from requested SHA');
    const mcp = await prepareMcp(config, role, {repo:repo.id,actualSha,workspace,attemptId:attempt});
    let agent = provider.agent;
    if (mcp.connections.length) {
      try {
        agent = provider.configureMcp!(provider.agent,mcp.connections);
        if (!agent || typeof agent.buildPrintCommand !== 'function' || typeof agent.parseStreamLine !== 'function') throw Error('Invalid provider');
      } catch { throw Error(`MCP provider configuration unavailable: ${provider.id}`); }
    }
    const built=await role.buildPrompt({input:detail.request.input,repo:String(detail.request.repo),actualSha});
    if(typeof built!=='string' || !built)throw Error('Role prompt must be nonempty text');
    const prompt=[built,...role.skills,...role.tools.map(id=>config.tools!.find(t=>t.id===id)!.description),...(mcp.facts.length ? ['Administrator MCP service facts: '+JSON.stringify(mcp.facts),'Use the services\' native tools and feedback. Missing tools or unreadable log references are unavailable, not success. Distinguish business results, tool faults and unknown outcomes. A timeout/disconnection or agent exit does not prove remote work stopped. Do not repeat uncertain side effects without service-specific evidence.'] : []),`Cooperative stop for attempt ${attempt}: read /orchestrator-stop/requested at appropriate checkpoints you choose. The read-only file identifies this attempt and the persisted reason and request time. If present, stop starting new work, summarize available results and end normally. A long tool call may delay reading; this is not forced termination or proof that child agents, tools or remote tasks stopped, and it does not roll back writes.`].join('\n\n');
    await writeFile(join(directory,'stdout.log'),'');await writeFile(join(directory,'stderr.log'),'');
    records.updateAttempt(attempt,{kind:'agent',actualSha,workspace,stopDirectory,container,branch,provider:provider.id,prompt,description:role.description,skills:role.skills,tools:role.tools,...(mcp.facts.length ? {mcp:mcp.facts} : {}),logs:{complete:false},sessionPolicy:'new'});
    const docker=environment.docker!;const binary=docker.binary ?? 'docker';
    const command=async(args:string[])=>{try{return await execFileAsync(binary,args,{env:{PATH:process.env.PATH},maxBuffer:8*1024*1024})}catch{throw Error('Docker facility operation failed; inspect the recorded container identity')}};
    const sandboxProvider=createBindMountSandboxProvider({name:'orchestrator-docker',env:docker.env ?? {},sandboxHomedir:'/home/agent',create:async options=>{
      if(deadlineError)throw deadlineError;
      const current=records.show(executionId).attempts.at(-1);
      if(current?.cancellation){records.finishAttempt(attempt,'cancelled',{stopConfirmation:{kind:'never-started',confirmedAt:new Date().toISOString()},endedAt:new Date().toISOString()});throw Error('Cancellation requested before agent start');}
      records.updateAttempt(attempt,{runState:'running'});launched=true;
      const mounts=[...options.mounts,...mcp.mounts].flatMap(m=>['--mount',`type=bind,src=${m.hostPath},dst=${m.sandboxPath},readonly`]);
      await command(['run','--detach','--pull=never','--name',container,'--network',docker.network ?? 'none','--cap-drop','ALL','--security-opt','no-new-privileges','--read-only','--user',`${process.getuid!()}:${process.getgid!()}`,'--tmpfs','/tmp:rw,nosuid,nodev','--tmpfs',`/home/agent:rw,nosuid,nodev,uid=${process.getuid!()},gid=${process.getgid!()},mode=0700`,...mounts,'--mount',`type=bind,src=${stopDirectory},dst=/orchestrator-stop,readonly`,...Object.entries({...options.env,HOME:'/home/agent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_SYSTEM:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1'}).flatMap(([key,value])=>['--env',`${key}=${value}`]),'--entrypoint','sh',docker.image,'-c','while :; do sleep 3600; done']);
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
    const result=await runAgent(sandbox,agent,prompt,()=>{if(deadlineTimer)clearTimeout(deadlineTimer)});
    const facts={...result,endedAt:new Date().toISOString(),logs:{complete:result.exitCode!==null && !result.error},stopConfirmation:result.exitCode===null?undefined:{kind:'agent-exit-marker',confirmedAt:new Date().toISOString(),exitCode:result.exitCode}};
    if(deadlineError){records.updateAttempt(attempt,{...facts,runState:'unknown',persistenceError:deadlineError instanceof Error?deadlineError.message:'Deadline intent save failed'});return;}
    if(result.exitCode===null){records.finishAttempt(attempt,'unknown',{...facts,error:result.error ?? 'Agent exit evidence unavailable'});return;}
    try {
      if(result.output===null)throw Error('No role output available');
      const returned=await role.validateReport(result.output!);
      const parsed=JSON.parse(JSON.stringify(returned));
      records.finishAttempt(attempt,'completed',{...facts,contract:'valid',business:parsed});
    }catch(error){records.finishAttempt(attempt,'completed',{...facts,contract:'error',contractError:error instanceof Error?error.message:'Invalid role report'});}
  }catch(error){if(deadlineError){records.markUnresolved(attempt,deadlineError);return;}try{records.finishAttempt(attempt,launched?'unknown':'start_failed',{error:error instanceof Error?error.message:'Role launch failed'})}catch(saveError){records.markUnresolved(attempt,saveError)}}
  finally{if(deadlineTimer)clearTimeout(deadlineTimer);records.endLive(attempt)}
}
