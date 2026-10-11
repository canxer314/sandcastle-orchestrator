import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, appendFile, open } from 'node:fs/promises';
import { join, dirname, resolve, relative } from 'node:path';
import { constants } from 'node:fs';
import type { Configuration, ExecutionContext } from './config.js';
import type { Records } from './records.js';
const execFileAsync = promisify(execFile);

// No shell, global/system Git configuration, credentials or checkout hooks.
async function git(repo: string, args: string[], binary = false) {
  return execFileAsync('git', ['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',repo,...args], {
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null', GIT_TERMINAL_PROMPT:'0', GIT_NO_REPLACE_OBJECTS:'1', GIT_NO_LAZY_FETCH:'1' },
    encoding: binary ? 'buffer' : 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
}

async function snapshot(repo: string, sha: string, workspace: string) {
  const { stdout } = await git(repo,['ls-tree','-rz','--full-tree',sha]);
  for (const entry of String(stdout).split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    const [mode,type,object] = entry.slice(0,tab).split(' ');
    const name = entry.slice(tab+1);
    // A detached export has no remotes, hooks, local .env or mutable Git directory.
    if (type !== 'blob' || !['100644','100755'].includes(mode)) throw Error('Execution snapshot does not support symlinks or submodules');
    const target=resolve(workspace,name);
    if (!relative(workspace,target) || relative(workspace,target).startsWith('..') || name.split('/').includes('.git')) throw Error('Unsafe snapshot path');
    await mkdir(dirname(target),{recursive:true});
    const blob=await git(repo,['cat-file','blob',object],true);
    await writeFile(target,blob.stdout,{mode:mode==='100755'?0o700:0o600});
  }
}

export async function readArtifact(directory: string, name: string) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw Error('Invalid artifact name');
  const file=await open(join(directory,name),constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat=await file.stat();
    if(!stat.isFile()) throw Error('Artifact is not a regular file');
    if(stat.size>8*1024*1024) throw Error('Artifact exceeds 8 MiB read limit');
    return (await file.readFile()).toString('base64');
  } finally {await file.close()}
}

export async function execute(records: Records, config: Configuration, executionId: string, data: string) {
  const detail = records.show(executionId);
  const capability = config.capabilities.find(c => c.id === detail.request.capability)!;
  const environment = config.environments.find(e => e.id === capability.environment)!;
  if (!capability.execution || !environment.docker) return;
  const attempt = records.beginAttempt(executionId, config.version, capability.id, environment.id);
  const directory=join(data,'attempts',attempt);
  const workspace=join(directory,'workspace'); const artifacts=join(directory,'artifacts');
  let running=false;
  let pending=0;
  let closed=false;
  let ended=false;
  let commandNumber=0;
  let unknownEnd=false;
  try {
    const commit = capability.execution.commit(detail.request.input);
    if (typeof commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error('Execution requires a full commit SHA');
    const repo = config.repos.find(r => r.id === detail.request.repo)!;
    const { stdout } = await git(repo.location, ['rev-parse', '--verify', `${commit}^{commit}`]);
    const actualSha=String(stdout).trim();
    if(actualSha!==commit)throw Error('Resolved commit differs from requested SHA');
    await mkdir(workspace,{recursive:true,mode:0o700});await mkdir(artifacts,{mode:0o700});
    await writeFile(join(directory,'stdout.log'),'');await writeFile(join(directory,'stderr.log'),'');
    records.updateAttempt(attempt,{actualSha,workspace,artifactsDirectory:artifacts,logs:{complete:false},container:`orch-${attempt}`});
    await snapshot(repo.location,actualSha,workspace);
    const context:ExecutionContext={ actualSha, attemptId:attempt, input:detail.request.input, exec: argv=>{
      if (!Array.isArray(argv) || !argv.length || argv.some(arg=>typeof arg!=='string' || arg.includes('\0')))throw Error('Invalid command argv');
      if(closed)throw Error('Capability entrypoint already ended');
      if(unknownEnd)throw Error('A previous command end is unknown; no further commands may start');
      if(pending)throw Error('Commands within an attempt must be awaited sequentially');
      const container=`orch-${attempt}-${++commandNumber}`;
      records.updateAttempt(attempt,{runState:'running',logs:{complete:false},container});running=true;ended=false;pending++;
      const command = new Promise<{stdout:string;stderr:string;exitCode:number}>((resolve,reject)=>{
        const child=spawn('docker',['run','--pull=never','--name',container,'--network','none','--cap-drop','ALL','--security-opt','no-new-privileges','--read-only','--user',`${process.getuid!()}:${process.getgid!()}`,'--tmpfs','/tmp:rw,nosuid,nodev,noexec','--mount',`type=bind,src=${workspace},dst=/workspace`,'--mount',`type=bind,src=${artifacts},dst=/artifacts`,'--workdir','/workspace','--entrypoint',argv[0],environment.docker!.image,...argv.slice(1)],{env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe']});
        let stdout='';let stderr='';let writes=Promise.resolve();let writeError:unknown;
        const onData=(stream:'stdout'|'stderr',chunk:Buffer)=>{
          if(stream==='stdout')stdout=(stdout+chunk.toString()).slice(-65536);else stderr=(stderr+chunk.toString()).slice(-65536);
          const pipe=stream==='stdout'?child.stdout:child.stderr;
          pipe.pause();
          writes=writes.then(()=>appendFile(join(directory,`${stream}.log`),chunk)).catch(error=>{writeError=error}).finally(()=>pipe.resume());
        };
        child.stdout.on('data',chunk=>onData('stdout',chunk));child.stderr.on('data',chunk=>onData('stderr',chunk));
        child.once('error',error => { running=false; reject(error); });
        child.once('close',async(code,signal)=>{
          try {
            await writes;
            if(writeError)throw writeError;
            const inspected=await execFileAsync('docker',['inspect','--format','{{json .State}}',container],{env:{PATH:process.env.PATH}});
            const state=JSON.parse(inspected.stdout);
            if(state.Running===false && state.Status==='created' && typeof state.Error==='string' && state.Error) {
              running=false;throw Error(`Docker launch/entrypoint failed: ${state.Error}`);
            }
            if(state.Running!==false || state.Status!=='exited' || !Number.isInteger(state.ExitCode))throw Error('Container end information unavailable or container still running');
            if(!closed)records.updateAttempt(attempt,{exitCode:state.ExitCode,signal,logs:{complete:code!==null && code===state.ExitCode},containerState:state});
            ended=true;
            resolve({stdout,stderr,exitCode:state.ExitCode});
          } catch(error){reject(error)}
        });
      });
      const tracked=command.catch(error=>{if(running && !ended)unknownEnd=true;throw error;}).finally(()=>{pending--;});
      tracked.catch(()=>{});
      return tracked;
    }};
    let returned:unknown;
    try { returned=await capability.run(context); }
    catch(error) {
      closed=true;
      if(ended && !pending && !unknownEnd) {
        records.finishAttempt(attempt,'completed',{contract:'error',contractError:error instanceof Error?error.message:'Capability failed to interpret result',endedAt:new Date().toISOString()});
        return;
      }
      throw error;
    }
    finally {closed=true;}
    if(pending || unknownEnd){records.finishAttempt(attempt,'unknown',{error:pending?'Capability returned before its command ended':'A command ended without trustworthy container end information'});return;}
    let result: {business?:unknown;artifacts?:unknown} | null = null;
    try { result = JSON.parse(JSON.stringify(returned)); }
    catch (error) {
      records.finishAttempt(attempt,'completed',{contract:'error',contractError:error instanceof Error?error.message:'Business result is not JSON serializable'});
      return;
    }
    if(!result || typeof result!=='object' || !Object.hasOwn(result,'business') || (result.artifacts!==undefined && (!Array.isArray(result.artifacts) || result.artifacts.some((a:unknown)=>typeof a!=='string')))) {
      records.finishAttempt(attempt,'completed',{contract:'error',contractError:'Expected { business, artifacts?: string[] }',endedAt:new Date().toISOString()});
      return;
    }
    const names = (result.artifacts ?? []) as string[];
    let artifactError: string | undefined;
    try { for(const name of names)await readArtifact(artifacts,name); }
    catch(error) { artifactError = error instanceof Error ? error.message : 'Invalid artifact'; }
    records.finishAttempt(attempt,'completed',artifactError
      ? {contract:'error',contractError:artifactError,endedAt:new Date().toISOString()}
      : {contract:'valid',business:result.business,artifacts:names.map((name:string)=>({name,attemptId:attempt,actualSha})),endedAt:new Date().toISOString()});
  } catch (error) {
    try {
      records.finishAttempt(attempt,running?'unknown':'start_failed',{error:error instanceof Error?error.message:'Execution failed',endedAt:new Date().toISOString()});
    } catch(saveError) { records.markUnresolved(attempt,saveError); }
  }
}
