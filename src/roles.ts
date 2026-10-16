import { randomBytes } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createBindMountSandboxProvider, createSandbox } from '@ai-hero/sandcastle';
import type { Configuration } from './config.js';
import type { Records } from './records.js';
import { git, snapshot, cancelExecution } from './execution.js';
import { runAgent } from './agent.js';
import { serveRoleTools } from './role-tools.js';
import { openRoleTools } from './mcp.js';
import { configureClaudeMcp, prepareMcp } from './native-mcp.js';
import { configureClaudeConnection, loadClaudeConnection } from './connection.js';
import { connectionSecrets } from './connection-secrets.js';
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
  const implementation=binding.workspace==='implementation';
  const executableToolIds=role.tools.filter(id=>config.tools?.some(t=>t.id===id && (t.capability || t.publication)));
  const implementationDirectory=join(directory,'implementation');
  let launched=false;
  let secrets = connectionSecrets([]);
  let tools:Awaited<ReturnType<typeof openRoleTools>>;
  let toolObservationError:string|undefined;
  let lifecycleFacts:Record<string,unknown>={};
  let toolServer:Awaited<ReturnType<typeof serveRoleTools>>|undefined;
  const callableTools=role.tools.map(id=>config.tools!.find(t=>t.id===id)!).filter(t=>t.read);
  const toolDirectory=join(directory,'tools');
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
    const connection = provider.connection ? await loadClaudeConnection(provider.connection, environment.docker!.env) : undefined;
    secrets = connectionSecrets(connection?.secrets ?? []);
    const stopDirectory=join(directory,'stop');await mkdir(stopDirectory,{recursive:true,mode:0o700});
    records.updateAttempt(attempt,{stopDirectory});
    await mkdir(workspace,{recursive:true,mode:0o700});
    if(implementation) {
      await mkdir(implementationDirectory,{mode:0o700});
      await mkdir(join(directory,'mcp'),{mode:0o700});
    }
    // Validate the same fixed-tree boundary as deterministic execution before cloning.
    await snapshot(repo.location,sha,join(directory,'context'));
    const tree=await git(repo.location,['ls-tree','-r','--name-only',sha]);
    if(String(tree.stdout).split('\n').includes('.sandcastle/.env'))throw Error('Role repository must not contain .sandcastle/.env');
    await git(workspace,['clone','--no-local','--no-checkout','--',repo.location,'.']);
    await git(workspace,['remote','remove','origin']);
    const actualSha=String((await git(workspace,['rev-parse','--verify',`${sha}^{commit}`])).stdout).trim();
    if(actualSha!==sha)throw Error('Resolved commit differs from requested SHA');
    const mcp = await prepareMcp(config, role, {repo:repo.id,actualSha,workspace,attemptId:attempt});
    const connectionAgent = connection ? configureClaudeConnection(provider.agent) : provider.agent;
    let agent = connectionAgent;
    if (mcp.connections.length) {
      try {
        agent = provider.configureMcp!(connectionAgent,mcp.connections);
        if (!agent || typeof agent.buildPrintCommand !== 'function' || typeof agent.parseStreamLine !== 'function') throw Error('Invalid provider');
      } catch { throw Error(`MCP provider configuration unavailable: ${provider.id}`); }
    }
    const built=await role.buildPrompt({input:detail.request.input,repo:String(detail.request.repo),actualSha});
    if(typeof built!=='string' || !built)throw Error('Role prompt must be nonempty text');
    if(callableTools.length)toolServer=await serveRoleTools(toolDirectory,callableTools,attempt,actualSha,error=>{toolObservationError=error;try{records.updateAttempt(attempt,{toolObservationError:error});}catch(saveError){records.markUnresolved(attempt,saveError);}},secrets.redact);
    const prompt=[built,...role.skills,...role.tools.map(id=>config.tools!.find(t=>t.id===id)!.description),...(callableTools.length?['Call deployed read-only tools with node /orchestrator-tools/call.mjs TOOL_ID JSON_INPUT. Tools are scoped by administrator configuration. Results are observed source data, not verified model conclusions. Tool failures mean evidence is unavailable; report limitations instead of inventing observations.']:[]),...(mcp.facts.length ? ['Administrator MCP service facts: '+JSON.stringify(mcp.facts),'Use the services\' native tools and feedback. Missing tools or unreadable log references are unavailable, not success. Distinguish business results, tool faults and unknown outcomes. A timeout/disconnection or agent exit does not prove remote work stopped. Do not repeat uncertain side effects without service-specific evidence.'] : []),`Cooperative stop for attempt ${attempt}: read /orchestrator-stop/requested at appropriate checkpoints you choose. The read-only file identifies this attempt and the persisted reason and request time. If present, stop starting new work, summarize available results and end normally. A long tool call may delay reading; this is not forced termination or proof that child agents, tools or remote tasks stopped, and it does not roll back writes.`].join('\n\n');
    if(secrets.redact(prompt)!==prompt || secrets.redact(role.description)!==role.description)throw Error('Connection credentials must not be included in role descriptions or prompts');
    await writeFile(join(directory,'stdout.log'),'');await writeFile(join(directory,'stderr.log'),'');
    records.updateAttempt(attempt,{kind:'agent',actualSha,workspace,workspaceMode:implementation?'implementation':'readonly',stopDirectory,container,branch,provider:provider.id,prompt,description:role.description,skills:role.skills,tools:role.tools,...(mcp.facts.length ? {mcp:mcp.facts} : {}),logs:{complete:false},sessionPolicy:'new',...(callableTools.length?{artifacts:[{name:'observations.jsonl',attemptId:attempt,actualSha,kind:'tool-observations'}]}:{})});
    const docker=environment.docker!;const binary=docker.binary ?? 'docker';
    const command=async(args:string[],env:Record<string,string>={})=>{try{return await execFileAsync(binary,args,{env:{PATH:process.env.PATH,...env},maxBuffer:8*1024*1024})}catch{throw Error('Docker facility operation failed; inspect the recorded container identity')}};
    const sandboxProvider=createBindMountSandboxProvider({name:'orchestrator-docker',env:connection?.env ?? docker.env ?? {},sandboxHomedir:'/home/agent',create:async options=>{
      if(deadlineError)throw deadlineError;
      const current=records.show(executionId).attempts.at(-1);
      if(current?.cancellation){records.finishAttempt(attempt,'cancelled',{stopConfirmation:{kind:'never-started',confirmedAt:new Date().toISOString()},endedAt:new Date().toISOString()});throw Error('Cancellation requested before agent start');}
      records.updateAttempt(attempt,{runState:'running'});launched=true;
      const hostWorkspace=options.mounts.find(m=>m.sandboxPath==='/home/agent/workspace')?.hostPath;
      if(!implementation && executableToolIds.length) {if(!hostWorkspace)throw Error('Current role workspace mount unavailable');tools=await openRoleTools(records,config,{executionId,attemptId:attempt,directory,workspace:hostWorkspace,actualSha,toolIds:role.tools,redact:secrets.redact});}
      const mounts=[...options.mounts,...mcp.mounts].flatMap(m=>['--mount',`type=bind,src=${m.hostPath},dst=${m.sandboxPath},readonly`]);
      await command(['run','--detach','--pull=never','--name',container,'--network',docker.network ?? 'none','--cap-drop','ALL','--security-opt','no-new-privileges','--read-only','--user',`${process.getuid!()}:${process.getgid!()}`,'--tmpfs','/tmp:rw,nosuid,nodev','--tmpfs',`/home/agent:rw,nosuid,nodev,uid=${process.getuid!()},gid=${process.getgid!()},mode=0700`,...mounts,...(implementation?['--mount',`type=bind,src=${implementationDirectory},dst=/implementation`,'--mount',`type=bind,src=${join(directory,'mcp')},dst=/orchestrator-mcp,readonly`]:[]),...(tools?['--mount',`type=bind,src=${tools.mcpDirectory},dst=/orchestrator-mcp,readonly`]:[]),...(callableTools.length?['--mount',`type=bind,src=${toolDirectory},dst=/orchestrator-tools,readonly`]:[]),'--mount',`type=bind,src=${stopDirectory},dst=/orchestrator-stop,readonly`,...Object.entries({...options.env,HOME:'/home/agent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_SYSTEM:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1'}).flatMap(([key,value])=>['--env',connection && Object.hasOwn(connection.runtimeEnv,key) ? key : `${key}=${value}`]),'--entrypoint','sh',docker.image,'-c','while :; do sleep 3600; done'],connection?.runtimeEnv);
      if(connection) {
        const checked=await command(['exec',container,'sh','-c',"# ORCH_CONNECTION_CHECK\nif [ -e /etc/claude-code/managed-settings.json ] || [ -d /etc/claude-code/managed-settings.d ]; then printf unsupported; else printf ready; fi"]);
        if(checked.stdout!=='ready')throw Error('Selected Claude connection cannot run with image managed settings; use an independently configured image');
      }
      const sandboxPath=implementation?'/implementation':'/home/agent/workspace';
      if(implementation) {
        // SDK postprocessing runs host Git. Its mounts stay read-only; editable Git never reaches it.
        const marker=`ORCH_INIT_${randomBytes(24).toString('hex')}`;
        const initialized=await command(['exec','--workdir','/implementation',container,'sh','-c',`(git -c core.hooksPath=/dev/null clone --no-local -- /home/agent/workspace . && git remote remove origin && git -c core.hooksPath=/dev/null checkout -B '${branch}' '${actualSha}'); code=$?; printf '\\n${marker}:%s\\n' "$code"; exit "$code"`]);
        if(!initialized.stdout.split('\n').includes(`${marker}:0`))throw Error('Implementation initialization exit evidence unavailable');
        records.updateAttempt(attempt,{initialization:{kind:'exec-exit-marker',exitCode:0,container,confirmedAt:new Date().toISOString()}});
        if(executableToolIds.length)tools=await openRoleTools(records,config,{executionId,attemptId:attempt,directory,workspace:implementationDirectory,revisionSource:implementationDirectory,actualSha,toolIds:role.tools,redact:secrets.redact});
      }
      return {worktreePath:sandboxPath,exec:(text,opts)=>new Promise((resolve,reject)=>{
        const cwd=implementation && (!opts?.cwd || opts.cwd==='/home/agent/workspace' || opts.cwd.startsWith('/home/agent/workspace/'))?sandboxPath+(opts?.cwd?.slice('/home/agent/workspace'.length) ?? ''):opts?.cwd ?? sandboxPath;
        const runtimeCommand = connection ? `if [ -e /etc/claude-code/managed-settings.json ] || [ -d /etc/claude-code/managed-settings.d ]; then printf '%s\\n' 'Selected Claude connection cannot run with image managed settings' >&2; exit 78; fi; exec env -i PATH="\${PATH:-/usr/local/bin:/usr/bin:/bin}" ${[...new Set([...Object.keys(connection.env).filter(key=>key!=='PATH'),'HOME','GIT_CONFIG_NOSYSTEM','GIT_CONFIG_SYSTEM','GIT_TERMINAL_PROMPT','GIT_NO_REPLACE_OBJECTS','GIT_NO_LAZY_FETCH'])].map(key=>`${key}="$${key}"`).join(' ')} sh -c '${text.replaceAll("'", "'\\''")}'` : text;
        const child=spawn(binary,['exec','-i','--workdir',cwd,container,'sh','-c',runtimeCommand],{env:{PATH:process.env.PATH},stdio:['pipe','pipe','pipe']});
        let stdout='';let stderr='';let line='';
        const consume = (stream:'stdout'|'stderr') => pipeline(child[stream],secrets.stream(),async chunks=>{
          const decoder = new StringDecoder('utf8');
          const consumeText = (text:string) => {
            if(stream==='stdout') {stdout=(stdout+text).slice(-65536);line+=text;let newline;while((newline=line.indexOf('\n'))>=0){opts?.onLine?.(line.slice(0,newline));line=line.slice(newline+1)}}
            else stderr=(stderr+text).slice(-65536);
          };
          for await (const chunk of chunks) {
            consumeText(decoder.write(chunk));
            await appendFile(join(directory,`${stream}.log`),chunk);
          }
          consumeText(decoder.end());
        });
        const streams=Promise.all([consume('stdout'),consume('stderr')]);streams.catch(()=>{});
        child.once('error',reject);child.once('close',async code=>{try{await streams;if(line)opts?.onLine?.(line);if(code===null)throw Error('Docker exec exit unavailable');resolve({stdout,stderr,exitCode:code})}catch(error){reject(error)}});child.stdin.on('error',()=>{});child.stdin.end(opts?.stdin);
      }),copyFileIn:async()=>{throw Error('Read-only report does not permit file injection')},copyFileOut:async(from,to)=>{
        const child=spawn(binary,['exec','-i',container,'cat','--',from],{env:{PATH:process.env.PATH},stdio:['ignore','pipe','ignore']});
        const exited=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error('Docker file export failed; inspect the recorded container identity')))});
        const copied=pipeline(child.stdout,secrets.stream(),createWriteStream(to));
        try{await Promise.all([exited,copied])}catch(error){child.kill();await Promise.allSettled([exited,copied]);throw error}
      },close:async()=>{ /* No automatic stop/remove: retained for audited administrator cleanup. */ }};
    }});
    const sandbox=await createSandbox({cwd:workspace,branch,baseBranch:sha,sandbox:sandboxProvider});
    if(tools)agent=(provider.configureMcp ?? configureClaudeMcp)(connectionAgent,[...mcp.connections,{service:'orchestrator',configFile:'/orchestrator-mcp/config.json',tools:executableToolIds}]);
    const result=await runAgent(sandbox,agent,prompt,()=>{if(deadlineTimer)clearTimeout(deadlineTimer)});
    const largeOutput=result.output!==null && Buffer.byteLength(result.output)>65536;
    let output=result.output;
    if(largeOutput) {
      const bytes=Buffer.from(output!);let end=65536;
      while((bytes[end]! & 0xc0)===0x80)end--;
      output=bytes.subarray(0,end).toString('utf8');
    }
    const facts={...result,...(implementation?{commits:[],commitEvidence:'Use revision and publication receipts; SDK commits belong to the read-only source'}:{}),output,...(largeOutput?{outputTruncated:true}:{}),endedAt:new Date().toISOString(),logs:{complete:result.exitCode!==null && !result.error},stopConfirmation:result.exitCode===null?undefined:{kind:'agent-exit-marker',confirmedAt:new Date().toISOString(),exitCode:result.exitCode}};
    lifecycleFacts=facts;
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
      await toolServer?.close();
      try {records.finishAttempt(attempt,'unknown',{...facts,report:{name:'report.txt',missing:true,complete:false},reportPersistenceError:'Required model report could not be saved'});}catch(saveError){records.markUnresolved(attempt,saveError);}return;
    }
    await toolServer?.close();
    if(tools?.unresolved()){records.finishAttempt(attempt,'unknown',{...facts,stopConfirmation:undefined,error:'Tool execution still active or result unknown; agent exit does not prove tool stop',logs:{complete:false}});return;}
    if(toolObservationError){try{records.finishAttempt(attempt,'unknown',{...facts,toolObservationError});}catch(saveError){records.markUnresolved(attempt,saveError);}return;}
    if(deadlineError){records.updateAttempt(attempt,{...facts,runState:'unknown',persistenceError:deadlineError instanceof Error?deadlineError.message:'Deadline intent save failed'});return;}
    if(result.exitCode===null){records.finishAttempt(attempt,'unknown',{...facts,error:result.error ?? 'Agent exit evidence unavailable'});return;}
    let parsed:unknown;
    try {
      if(result.output===null)throw Error('No role output available');
      parsed=JSON.parse(secrets.redact(JSON.stringify(await role.validateReport(result.output))));
    }catch(error){
      try {records.finishAttempt(attempt,'completed',{...facts,contract:'error',contractError:secrets.redact(error instanceof Error?error.message:'Invalid role report')});}catch(saveError){records.markUnresolved(attempt,saveError);}return;
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
  }catch(error){
    try{await toolServer?.close();}catch(closeError){error=closeError;}
    if(deadlineError){records.markUnresolved(attempt,deadlineError);return;}
    try{records.finishAttempt(attempt,launched?'unknown':'start_failed',{...lifecycleFacts,error:secrets.redact(error instanceof Error?error.message:'Role launch failed'),...(toolObservationError?{toolObservationError}:{})})}catch(saveError){records.markUnresolved(attempt,saveError)}
  }
  finally{try{await tools?.close();await toolServer?.close();}finally{if(deadlineTimer)clearTimeout(deadlineTimer);records.endLive(attempt)}}
}
