import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { afterEach, expect, test } from 'vitest';
import { call } from '../src/control.js';
const root = resolve(import.meta.dirname, '..');
const dirs: string[] = [];
const children: ChildProcess[] = [];
async function temporary(prefix: string) { const dir = await mkdtemp(join(tmpdir(), prefix)); dirs.push(dir); return dir; }
async function cli(args: string[]) {
  const child = spawn(process.execPath, ['--import','tsx','src/cli.ts',...args], {cwd:root});
  let stdout = ''; let stderr = '';
  child.stdout.on('data',d=>stdout+=d); child.stderr.on('data',d=>stderr+=d);
  const [code] = await once(child,'exit');
  expect(code, stderr).toBe(0);
  return JSON.parse(stdout);
}
async function start(data: string, config: string, path = process.env.PATH) {
  const child = spawn(process.execPath,['--import','tsx','src/cli.ts','serve','--data',data,'--config',config],{cwd:root,env:{...process.env,PATH:path}});
  children.push(child);
  await new Promise<void>((resolve,reject)=>{
    let output=''; let errors='';
    const timer=setTimeout(()=>reject(Error(errors || 'service not ready')),10000);
    child.stderr.on('data',d=>errors+=d);
    child.stdout.on('data',d=>{output+=d;if(output.includes('ready')){clearTimeout(timer);resolve()}});
    child.once('exit',()=>{clearTimeout(timer);reject(Error(errors))});
  });
  return join(data,'control.sock');
}
async function fixture(body: string, script = 'echo fixed-version\necho actual-error >&2\necho artifact > /artifacts/result.txt\nexit 1\n') {
  const repo = await temporary('orch-exec-repo-');
  const git = (...args:string[]) => execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
  git('init');
  await writeFile(join(repo,'test.sh'),script);
  git('add','.'); git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','first');
  const sha=git('rev-parse','HEAD');
  await writeFile(join(repo,'test.sh'),'echo wrong-version\n'); git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','second');
  const data=await temporary('orch-exec-data-'); const configDir=await temporary('orch-exec-config-');
  const config=join(configDir,'config.ts');
  await writeFile(config,`export default {version:'config-v2',repos:[{id:'alpha',location:${JSON.stringify(repo)}}],environments:[{id:'test',docker:{image:'node:22.22-alpine'}}],capabilities:[{id:'test-commit',environment:'test',validate(input){if(typeof input!=='string')throw Error('commit required')},execution:{commit(input){return input}},async run(ctx){${body}}}]};`);
  return {repo,sha,data,config,socket:await start(data,config)};
}
async function submit(f:Awaited<ReturnType<typeof fixture>>) {
  return await call(f.socket,{command:'submit',submission:{repo:'alpha',capability:'test-commit',input:f.sha,source:'manual'}}) as any;
}
async function finished(socket:string,id:string) {
  const deadline=Date.now()+15000;
  while(Date.now()<deadline) {
    const detail=await call(socket,{command:'show',id}) as any;
    if(['completed','start_failed','unknown'].includes(detail.execution.status))return detail;
    await new Promise(r=>setTimeout(r,30));
  }
  throw Error('execution did not finish');
}
afterEach(async()=>{
  await Promise.all(children.splice(0).map(async c=>{if(c.exitCode===null&&c.signalCode===null){const exit=once(c,'exit');c.kill('SIGTERM');await exit}}));
  await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));
});
test('fixed SHA script failure is completed business result with CLI-readable logs and artifacts',async()=>{
  const f=await fixture(`const result=await ctx.exec(['sh','/workspace/test.sh']);return {business:{passed:result.exitCode===0},artifacts:['result.txt']}`);
  const receipt=await submit(f);
  const detail=await finished(f.socket,receipt.executionId);
  expect(detail.execution.status).toBe('completed');
  expect(detail.attempts[0]).toMatchObject({actualSha:f.sha,configVersion:'config-v2',runState:'completed',contract:'valid',business:{passed:false}});
  const log=await cli(['logs',receipt.executionId,'--socket',f.socket]);
  expect(log.stdout).toContain('fixed-version');expect(log.stdout).not.toContain('wrong-version');expect(log.stderr).toContain('actual-error');expect(log.complete).toBe(true);
  const artifact=await cli(['artifact',receipt.executionId,'--name','result.txt','--socket',f.socket]);
  expect(artifact).toMatchObject({attemptId:detail.attempts[0].id,actualSha:f.sha,encoding:'base64',content:Buffer.from('artifact\n').toString('base64')});
},20000);

test('snapshot Git boundary explicitly disables partial clone lazy fetch',async()=>{
  const f=await fixture(`return {business:'done'}`);
  const child=children.pop()!;const exit=once(child,'exit');child.kill('SIGTERM');await exit;
  const bin=await temporary('orch-exec-git-bin-');
  const gitPath=execFileSync('which',['git'],{encoding:'utf8'}).trim();
  await writeFile(join(bin,'git'),`#!/bin/sh\nif [ "$GIT_NO_LAZY_FETCH" != 1 ]; then echo lazy-fetch-not-disabled >&2; exit 3; fi\nexec ${JSON.stringify(gitPath)} "$@"\n`,{mode:0o700});
  await start(f.data,f.config,`${bin}:${process.env.PATH}`);const receipt=await submit(f);const detail=await finished(f.socket,receipt.executionId);
  expect(detail.execution.status).toBe('completed');
},20000);

test.each(['running','missing'])('caught unknown command end (%s) cannot be turned into business completion',async state=>{
  const f=await fixture(`try {await ctx.exec(['sh','/workspace/test.sh'])}catch{}try {await ctx.exec(['sh','-c','echo must-not-start'])}catch{}return {business:'caught'}`);
  const child=children.pop()!;const exit=once(child,'exit');child.kill('SIGTERM');await exit;
  const bin=await temporary('orch-exec-bin-');
  await writeFile(join(bin,'docker'),`#!/bin/sh\nif [ "$1" = run ]; then exit 0; fi\n${state==='running' ? `echo '{"Running":true,"Status":"running","ExitCode":0}'; exit 0` : 'exit 1'}\n`,{mode:0o700});
  await start(f.data,f.config,`${bin}:${process.env.PATH}`);
  const receipt=await submit(f);const detail=await finished(f.socket,receipt.executionId);
  expect(detail.execution.status).toBe('unknown');expect(detail.attempts[0].business).toBeUndefined();
  expect(detail.attempts[0].container).toMatch(/-1$/);
},20000);

test.each(['running','missing'])('client exit without trustworthy container end (%s) stays unknown',async state=>{
  const f=await fixture(`await ctx.exec(['sh','/workspace/test.sh']);return {business:'premature'}`);
  const child=children.pop()!;const exit=once(child,'exit');child.kill('SIGTERM');await exit;
  const bin=await temporary('orch-exec-bin-');
  await writeFile(join(bin,'docker'),`#!/bin/sh\nif [ "$1" = run ]; then echo client-exited; exit 0; fi\n${state==='running' ? `echo '{"Running":true,"Status":"running","ExitCode":0}'; exit 0` : 'exit 1'}\n`,{mode:0o700});
  await start(f.data,f.config,`${bin}:${process.env.PATH}`);
  const receipt=await submit(f);const detail=await finished(f.socket,receipt.executionId);
  expect(detail.execution.status).toBe('unknown');expect(detail.attempts[0].business).toBeUndefined();
  expect(detail.attempts[0].logs.complete).toBe(false);
  const stopped=children.pop()!;const done=once(stopped,'exit');stopped.kill('SIGTERM');await done;
  await start(f.data,f.config,`${bin}:${process.env.PATH}`);
  const restarted=await cli(['show',receipt.executionId,'--socket',f.socket]);expect(restarted.attempts).toHaveLength(1);expect(restarted.execution.status).toBe('unknown');
},20000);

test('second sequential command resets log completeness until confirmed end',async()=>{
  const f=await fixture(`await ctx.exec(['sh','-c','echo first']);await ctx.exec(['sh','-c','echo second']);return {business:'done'}`);
  const child=children.pop()!;const exit=once(child,'exit');child.kill('SIGTERM');await exit;
  const bin=await temporary('orch-sequential-bin-');const release=join(bin,'release');
  await writeFile(join(bin,'docker'),`#!/bin/sh\ncase "$1" in\nrun) case "$*" in *'echo second'*) echo second; while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.02; done;; *) echo first;; esac;;\ninspect) echo '{"Running":false,"Status":"exited","ExitCode":0}';;\nesac\n`,{mode:0o700});
  await start(f.data,f.config,`${bin}:${process.env.PATH}`);
  const receipt=await submit(f);
  try {
    await expect.poll(async()=>{
      const logs=await call(f.socket,{command:'logs',id:receipt.executionId}) as any;
      if(!logs.stdout?.includes('second'))return null;
      return {complete:logs.complete,stdout:logs.stdout};
    },{timeout:10000,interval:20}).toEqual({complete:false,stdout:'first\nsecond\n'});
  } finally {await writeFile(release,'continue');}
  const detail=await finished(f.socket,receipt.executionId);expect(detail.execution.status).toBe('completed');
  expect((await call(f.socket,{command:'logs',id:receipt.executionId}) as any).complete).toBe(true);
},20000);

test('unawaited execution stays unknown and late output cannot overwrite its state',async()=>{
  const f=await fixture(`void ctx.exec(['sh','/workspace/test.sh']);return {business:'premature'}`,'sleep 1\necho ended\n');
  const receipt=await submit(f);let detail=await finished(f.socket,receipt.executionId);
  expect(detail.execution.status).toBe('unknown');expect(detail.attempts[0].business).toBeUndefined();
  await new Promise(r=>setTimeout(r,2500));detail=await cli(['show',receipt.executionId,'--socket',f.socket]);
  expect(detail.execution.status).toBe('unknown');
},20000);

test.each(['undefined','()=>{}',"Symbol('omitted')"])('business value %s omitted by JSON is explicit contract error',async value=>{
  const f=await fixture(`await ctx.exec(['sh','/workspace/test.sh']);return {business:${value}}`);
  const receipt=await submit(f);const detail=await finished(f.socket,receipt.executionId);
  expect(detail.execution.status).toBe('completed');expect(detail.attempts[0].contract).toBe('error');
},20000);

test('entrypoint contract errors do not erase normal script completion',async()=>{
  const f=await fixture(`await ctx.exec(['sh','/workspace/test.sh']);return 'not-the-contract'`);
  const receipt=await submit(f);const detail=await finished(f.socket,receipt.executionId);
  expect(detail.execution.status).toBe('completed');
  expect(detail.attempts[0]).toMatchObject({runState:'completed',exitCode:1,contract:'error'});
  expect(detail.attempts[0].business).toBeUndefined();
},20000);

test('finish save failure remains unresolved in current service and after restart',async()=>{
  const f=await fixture(`await ctx.exec(['sh','/workspace/test.sh']);return {business:{passed:false}}`);
  const { DatabaseSync }=await import('node:sqlite');
  const db=new DatabaseSync(join(f.data,'records.sqlite'));
  db.exec("CREATE TRIGGER no_end BEFORE UPDATE ON attempts WHEN NEW.run_state = 'completed' OR NEW.run_state = 'unknown' BEGIN SELECT RAISE(FAIL, 'end save blocked'); END;");
  const receipt=await submit(f);
  let detail=await finished(f.socket,receipt.executionId);
  expect(detail.execution.status).toBe('unknown');expect(detail.attempts[0].runState).toBe('unknown');
  expect(detail.attempts[0].persistenceError).toContain('end save blocked');
  const child=children.pop()!;const exit=once(child,'exit');child.kill('SIGTERM');await exit;
  db.close();await start(f.data,f.config);
  detail=await call(f.socket,{command:'show',id:receipt.executionId}) as any;
  expect(detail.execution.status).toBe('unknown');expect(detail.attempts).toHaveLength(1);expect(detail.attempts[0].business).toBeUndefined();
},20000);

test('required attempt save failure prevents environment start',async()=>{
  const f=await fixture(`await ctx.exec(['sh','/workspace/test.sh']);return {business:'must not run'}`);
  const { DatabaseSync }=await import('node:sqlite');
  const db=new DatabaseSync(join(f.data,'records.sqlite'));
  db.exec("CREATE TRIGGER no_attempt BEFORE INSERT ON attempts BEGIN SELECT RAISE(FAIL, 'attempt save blocked'); END;");
  const receipt=await submit(f);
  await new Promise(r=>setTimeout(r,100));
  const detail=await call(f.socket,{command:'show',id:receipt.executionId}) as any;
  expect(detail.execution.status).toBe('queued');expect(detail.attempts).toEqual([]);
  const { readdir }=await import('node:fs/promises');
  expect(await readdir(f.data)).not.toContain('attempts');
  db.close();
},20000);

test.each([125,126,127])('script exit %i is real business completion, not Docker launch failure',async code=>{
  const f=await fixture(`const result=await ctx.exec(['sh','/workspace/test.sh']);return {business:{exit:result.exitCode}}`,`exit ${code}\n`);
  const receipt=await submit(f);const detail=await finished(f.socket,receipt.executionId);
  expect(detail.execution.status).toBe('completed');expect(detail.attempts[0].business.exit).toBe(code);
},20000);

test('Docker launch failure never runs the script on the host',async()=>{
  const f=await fixture(`await ctx.exec(['missing-command']);return {business:'not reached'}`);
  const receipt=await submit(f);const detail=await finished(f.socket,receipt.executionId);
  expect(detail.execution.status).toBe('start_failed');
  expect(detail.attempts[0]).toMatchObject({runState:'start_failed',actualSha:f.sha});
  expect(detail.attempts[0].error).toContain('Docker launch/entrypoint failed');
},20000);

test('control crash preserves unresolved attempt and never restarts the running script',async()=>{
  const f=await fixture(`await ctx.exec(['sh','/workspace/test.sh']);return {business:'done'}`,'echo started\nsleep 2\necho ended\n');
  const receipt=await submit(f);
  let detail:any;
  for(let i=0;i<100;i++){detail=await call(f.socket,{command:'show',id:receipt.executionId});if(detail.execution.status==='running')break;await new Promise(r=>setTimeout(r,10))}
  expect(detail.execution.status).toBe('running');
  const child=children.pop()!;const exit=once(child,'exit');child.kill('SIGKILL');await exit;
  await start(f.data,f.config);detail=await cli(['show',receipt.executionId,'--socket',f.socket]);
  expect(detail.execution.status).toBe('unknown');expect(detail.attempts).toHaveLength(1);expect(detail.attempts[0].requiresAttention).toBe(true);
  await new Promise(r=>setTimeout(r,2500));
  detail=await cli(['show',receipt.executionId,'--socket',f.socket]);expect(detail.execution.status).toBe('unknown');expect(detail.attempts).toHaveLength(1);
},20000);

test('old persisted queued records are not consumed after execution config is enabled',async()=>{
  const f=await fixture(`await ctx.exec(['sh','/workspace/test.sh']);return {business:'done'}`);
  let child=children.pop()!;let exit=once(child,'exit');child.kill('SIGTERM');await exit;
  const {readFile}=await import('node:fs/promises');const enabled=await readFile(f.config,'utf8');
  await writeFile(f.config,enabled.replace('execution:{commit(input){return input}},',''));
  const submission={repo:'alpha',capability:'test-commit',input:f.sha,source:'manual',deduplicationKey:'historical-slot'};
  await start(f.data,f.config);const receipt=await call(f.socket,{command:'submit',submission}) as any;
  child=children.pop()!;exit=once(child,'exit');child.kill('SIGTERM');await exit;
  await writeFile(f.config,enabled);await start(f.data,f.config);
  expect(await call(f.socket,{command:'submit',submission})).toEqual(receipt);
  await new Promise(r=>setTimeout(r,100));
  const detail=await cli(['show',receipt.executionId,'--socket',f.socket]);
  expect(detail.execution.status).toBe('queued');expect(detail.attempts).toEqual([]);
},20000);

test('snapshot rejects tracked symlinks without running target scripts',async()=>{
  const f=await fixture(`return {business:'must not run'}`);
  const child=children.pop()!;const exit=once(child,'exit');child.kill('SIGTERM');await exit;
  const {symlink}=await import('node:fs/promises');await symlink('/etc/passwd',join(f.repo,'link'));
  execFileSync('git',['-C',f.repo,'add','.']);execFileSync('git',['-C',f.repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','symlink']);
  f.sha=execFileSync('git',['-C',f.repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  await start(f.data,f.config);const receipt=await submit(f);const detail=await finished(f.socket,receipt.executionId);
  expect(detail.execution.status).toBe('start_failed');expect(detail.attempts[0].error).toContain('symlinks or submodules');
},20000);

test('large live logs remain readable with explicit tail truncation',async()=>{
  const f=await fixture(`const result=await ctx.exec(['sh','/workspace/test.sh']);return {business:{tail:result.stdout.length}}`,'head -c 100000 /dev/zero | tr "\\000" x\n');
  const receipt=await submit(f);const detail=await finished(f.socket,receipt.executionId);
  expect(detail.execution.status).toBe('completed');expect(detail.attempts[0].business.tail).toBeLessThanOrEqual(65536);
  const logs=await cli(['logs',receipt.executionId,'--socket',f.socket]);
  expect(logs.stdout.length).toBe(65536);expect(logs.truncated.stdout).toBe(true);expect(logs.complete).toBe(true);
},20000);

test('incomplete execution configuration fails startup rather than silently queueing',async()=>{
  const data=await temporary('orch-exec-data-');const configDir=await temporary('orch-exec-config-');const config=join(configDir,'config.ts');
  await writeFile(config,`export default {version:'v',repos:[],environments:[{id:'test'}],capabilities:[{id:'test',environment:'test',validate(){},run(){},execution:{commit(input){return input}}}]}`);
  await expect(start(data,config)).rejects.toThrow('Execution capability requires Docker environment');
},20000);

test('unknown attempts are included by status filter after restart',async()=>{
  const f=await fixture(`await ctx.exec(['sh','/workspace/test.sh']);return {business:'done'}`);
  const { DatabaseSync }=await import('node:sqlite');const db=new DatabaseSync(join(f.data,'records.sqlite'));
  db.exec("CREATE TRIGGER no_end BEFORE UPDATE ON attempts WHEN NEW.run_state = 'completed' OR NEW.run_state = 'unknown' BEGIN SELECT RAISE(FAIL, 'blocked'); END;");
  const receipt=await submit(f);await finished(f.socket,receipt.executionId);
  const child=children.pop()!;const exit=once(child,'exit');child.kill('SIGTERM');await exit;db.close();
  await start(f.data,f.config);
  const listed=await cli(['list','--socket',f.socket,'--status','unknown']);
  expect(listed.map((x:any)=>x.execution.id)).toContain(receipt.executionId);
},20000);

test('capability parse failure after confirmed script end is completed contract error',async()=>{
  const f=await fixture(`await ctx.exec(['sh','/workspace/test.sh']);throw Error('cannot parse result')`);
  const receipt=await submit(f);const detail=await finished(f.socket,receipt.executionId);
  expect(detail.execution.status).toBe('completed');expect(detail.attempts[0].contract).toBe('error');
  expect(detail.attempts[0].contractError).toContain('cannot parse result');
},20000);

test('artifact symlink is a contract error and never exposes a container or host file',async()=>{
  const f=await fixture(`await ctx.exec(['sh','/workspace/test.sh']);return {business:'done',artifacts:['secret.txt']}`,'ln -s /etc/passwd /artifacts/secret.txt\necho done\n');
  const receipt=await submit(f);const detail=await finished(f.socket,receipt.executionId);
  expect(detail.execution.status).toBe('completed');expect(detail.attempts[0].contract).toBe('error');
  await expect(call(f.socket,{command:'artifact',id:receipt.executionId,name:'secret.txt'})).rejects.toThrow('Artifact not registered');
},20000);

test('real Docker boundary has no host credentials, network, Git remote or outside mount',async()=>{
  const f=await fixture(`const result=await ctx.exec(['sh','/workspace/test.sh']);return {business:result.stdout}`,
    'test ! -e /var/run/docker.sock || exit 3\ntest ! -e /workspace/.git || exit 4\ntest -z "$ORCHESTRATOR_SECRET" || exit 5\nnode -e "if(require(\'os\').networkInterfaces().eth0)process.exit(6)" || exit 6\necho isolated\n');
  const receipt=await submit(f);const detail=await finished(f.socket,receipt.executionId);
  expect(detail.execution.status).toBe('completed');expect(detail.attempts[0].exitCode).toBe(0);expect(detail.attempts[0].business).toBe('isolated\n');
},20000);

test('parallel submissions get distinct workspaces and have no orchestrator concurrency gate',async()=>{
  const f=await fixture(`const result=await ctx.exec(['sh','/workspace/test.sh']);return {business:result.stdout}`,'echo private > private.txt\nsleep 1\necho finished\n');
  const [first,second]=await Promise.all([submit(f),submit(f)]);
  const [a,b]=await Promise.all([finished(f.socket,first.executionId),finished(f.socket,second.executionId)]);
  expect(a.execution.status).toBe('completed');expect(b.execution.status).toBe('completed');
  expect(a.attempts[0].workspace).not.toBe(b.attempts[0].workspace);
  expect(a.attempts[0].actualSha).toBe(f.sha);expect(b.attempts[0].actualSha).toBe(f.sha);
  const { readFile }=await import('node:fs/promises');
  expect(await readFile(join(a.attempts[0].workspace,'private.txt'),'utf8')).toBe('private\n');
  expect(await readFile(join(b.attempts[0].workspace,'private.txt'),'utf8')).toBe('private\n');
},20000);

test('cancellation while snapshot is preparing prevents the host capability entrypoint',async()=>{
  const gate=await temporary('orch-prep-cancel-');const release=join(gate,'release');const waiting=join(gate,'waiting');const effect=join(gate,'effect');
  const f=await fixture(`const fs=await import('node:fs/promises');await fs.writeFile(${JSON.stringify(effect)},'forbidden');return {business:'done'}`);
  const child=children.pop()!;const exit=once(child,'exit');child.kill('SIGTERM');await exit;
  const gitPath=execFileSync('which',['git'],{encoding:'utf8'}).trim();
  await writeFile(join(gate,'git'),`#!/bin/sh\ncase "$*" in *ls-tree*) touch ${JSON.stringify(waiting)}; while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.02; done;; esac\nexec ${JSON.stringify(gitPath)} "$@"\n`,{mode:0o700});
  await start(f.data,f.config,`${gate}:${process.env.PATH}`);const receipt=await submit(f);
  const {stat}=await import('node:fs/promises');
  try {
    await expect.poll(async()=>Boolean(await stat(waiting).catch(()=>null))).toBe(true);
    await call(f.socket,{command:'cancel',id:receipt.executionId,reason:'before capability'});
  } finally {await writeFile(release,'done');}
  await expect.poll(async()=>(await call(f.socket,{command:'show',id:receipt.executionId}) as any).execution.status).toBe('cancelled');
  expect(await stat(effect).catch(()=>null)).toBeNull();
  expect((await call(f.socket,{command:'show',id:receipt.executionId}) as any).attempts[0].stopConfirmation.kind).toBe('never-started');
},20000);

test('late stop after start failure cannot overwrite a running retry',async()=>{
  const f=await fixture(`await ctx.exec(['sh']);return {business:'done'}`);
  const child=children.pop()!;const exit=once(child,'exit');child.kill('SIGTERM');await exit;
  const bin=await temporary('orch-late-startfail-');const first=join(bin,'first');const fail=join(bin,'fail');const release=join(bin,'release');const next=join(bin,'next');const inspected=join(bin,'inspected');
  await writeFile(join(bin,'docker'),`#!/bin/sh\ncase "$1" in\nrun) if [ ! -f ${JSON.stringify(first)} ]; then echo "$4" > ${JSON.stringify(first)}; while [ ! -f ${JSON.stringify(fail)} ]; do sleep 0.02; done; exit 125; else while [ ! -f ${JSON.stringify(next)} ]; do sleep 0.02; done; fi;;\nstop) while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.02; done;;\ninspect) if [ "$4" = "$(cat ${JSON.stringify(first)})" ]; then echo '{"Running":false,"Status":"created","ExitCode":125,"Error":"Launch failed"}'; if [ -f ${JSON.stringify(release)} ]; then touch ${JSON.stringify(inspected)}; fi; else echo '{"Running":false,"Status":"exited","ExitCode":0}'; fi;;\nesac\n`,{mode:0o700});
  await start(f.data,f.config,`${bin}:${process.env.PATH}`);const receipt=await submit(f);const id=receipt.executionId;
  const {stat}=await import('node:fs/promises');
  try {
    await expect.poll(async()=>(await call(f.socket,{command:'show',id}) as any).execution.status).toBe('running');
    await call(f.socket,{command:'cancel',id,reason:'stop'});await writeFile(fail,'fail');
    await expect.poll(async()=>(await call(f.socket,{command:'show',id}) as any).execution.status).toBe('start_failed');
    await call(f.socket,{command:'retry',id,source:'operator',handling:'checked',reason:'retry',externalResults:'no writes'});
    await expect.poll(async()=>(await call(f.socket,{command:'show',id}) as any).attempts[1]?.runState).toBe('running');
    await writeFile(release,'done');await expect.poll(async()=>Boolean(await stat(inspected).catch(()=>null))).toBe(true);
    await new Promise(r=>setTimeout(r,100));
    const detail=await call(f.socket,{command:'show',id}) as any;
    expect(detail.execution.status).toBe('running');expect(detail.attempts[0].runState).toBe('start_failed');
  } finally {await Promise.all([writeFile(fail,'done'),writeFile(release,'done'),writeFile(next,'done')]);}
  expect((await finished(f.socket,id)).execution.status).toBe('completed');
},20000);

test('stopped previous container does not confirm a still-live host capability',async()=>{
  const gate=await temporary('orch-host-gate-');const release=join(gate,'release');const waiting=join(gate,'waiting');
  const f=await fixture(`await ctx.exec(['sh']);const fs=await import('node:fs/promises');await fs.writeFile(${JSON.stringify(waiting)},'waiting');while(!(await fs.stat(${JSON.stringify(release)}).catch(()=>null)))await new Promise(r=>setTimeout(r,20));return {business:'done'}`);
  const child=children.pop()!;const exit=once(child,'exit');child.kill('SIGTERM');await exit;
  const bin=await temporary('orch-host-bin-');await writeFile(join(bin,'docker'),`#!/bin/sh\nif [ "$1" = inspect ]; then echo '{"Running":false,"Status":"exited","ExitCode":0}'; fi\n`,{mode:0o700});
  await start(f.data,f.config,`${bin}:${process.env.PATH}`);const receipt=await submit(f);
  const {stat}=await import('node:fs/promises');await expect.poll(async()=>Boolean(await stat(waiting).catch(()=>null))).toBe(true);
  try {
    await call(f.socket,{command:'cancel',id:receipt.executionId,reason:'stop'});
    await expect.poll(async()=>String((await call(f.socket,{command:'show',id:receipt.executionId}) as any).attempts[0].cancellationLimit)).toContain('entrypoint is still live');
    const detail=await call(f.socket,{command:'show',id:receipt.executionId}) as any;expect(detail.execution.status).toBe('unknown');expect(detail.attempts[0].stopConfirmation).toBeUndefined();
    await expect(call(f.socket,{command:'retry',id:receipt.executionId,source:'operator',handling:'checked',reason:'repeat',externalResults:'no writes'})).rejects.toThrow('live');
  } finally {await writeFile(release,'done');}
  await expect.poll(async()=>(await call(f.socket,{command:'show',id:receipt.executionId}) as any).execution.status).toBe('cancelled');
},20000);

test('starting save fault retry cannot change the originally selected baseline',async()=>{
  const f=await fixture(`return {business:ctx.actualSha}`);
  const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(join(f.data,'records.sqlite'));
  db.exec("CREATE TRIGGER no_updates BEFORE UPDATE ON attempts BEGIN SELECT RAISE(FAIL,'save blocked'); END;");
  const receipt=await submit(f);await finished(f.socket,receipt.executionId);
  const child=children.pop()!;const exit=once(child,'exit');child.kill('SIGTERM');await exit;
  db.exec('DROP TRIGGER no_updates');db.close();
  const {readFile}=await import('node:fs/promises');await writeFile(f.config,(await readFile(f.config,'utf8')).replace('commit(input){return input}',`commit(input){return '${'0'.repeat(40)}'}`));
  await start(f.data,f.config);const audit={source:'operator',handling:'checked full attempt',reason:'retry',externalResults:'no writes'};
  await call(f.socket,{command:'confirm-stop',id:receipt.executionId,...audit});await call(f.socket,{command:'retry',id:receipt.executionId,...audit});
  const detail=await finished(f.socket,receipt.executionId);expect(detail.execution.status).toBe('completed');expect(detail.attempts[1].actualSha).toBe(f.sha);
},20000);

test('failed cooperative stop is completed cancellation when the live command later exits',async()=>{
  const f=await fixture(`await ctx.exec(['sh']);return {business:'done'}`);
  const child=children.pop()!;const exit=once(child,'exit');child.kill('SIGTERM');await exit;
  const bin=await temporary('orch-late-exit-');const release=join(bin,'release');
  await writeFile(join(bin,'docker'),`#!/bin/sh\ncase "$1" in\nrun) while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.02; done;;\nstop) exit 1;;\ninspect) echo '{"Running":false,"Status":"exited","ExitCode":0}';;\nesac\n`,{mode:0o700});
  await start(f.data,f.config,`${bin}:${process.env.PATH}`);const receipt=await submit(f);
  await expect.poll(async()=>(await call(f.socket,{command:'show',id:receipt.executionId}) as any).execution.status).toBe('running');
  await call(f.socket,{command:'cancel',id:receipt.executionId,reason:'stop'});
  await expect.poll(async()=>Boolean((await call(f.socket,{command:'show',id:receipt.executionId}) as any).attempts[0].cancellationError)).toBe(true);
  try {
    await expect(call(f.socket,{command:'confirm-stop',id:receipt.executionId,source:'operator',handling:'checked',reason:'stop'})).rejects.toThrow('live');
  } finally {await writeFile(release,'done');}
  await expect.poll(async()=>(await call(f.socket,{command:'show',id:receipt.executionId}) as any).execution.status).toBe('cancelled');
},20000);

test('retry keeps old attempt artifacts accessible through the public CLI',async()=>{
  const f=await fixture(`await ctx.exec(['sh','/workspace/test.sh']);return {business:'done',artifacts:['result.txt']}`);
  const receipt=await submit(f);const old=await finished(f.socket,receipt.executionId);
  await cli(['retry',receipt.executionId,'--socket',f.socket,'--source','operator','--handling','checked','--reason','repeat','--external-results','no writes']);
  const detail=await finished(f.socket,receipt.executionId);expect(detail.attempts).toHaveLength(2);
  const artifact=await cli(['artifact',receipt.executionId,'--socket',f.socket,'--attempt',old.attempts[0].id,'--name','result.txt']);
  expect(artifact).toMatchObject({attemptId:old.attempts[0].id,actualSha:f.sha,content:Buffer.from('artifact\n').toString('base64')});
},20000);

test('starting crash without container identity requires manual confirmation and resolve audit',async()=>{
  const f=await fixture(`return {business:'unused'}`);
  const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(join(f.data,'records.sqlite'));
  db.exec("CREATE TRIGGER no_updates BEFORE UPDATE ON attempts BEGIN SELECT RAISE(FAIL,'starting save blocked'); END;");
  const receipt=await submit(f);const unknown=await finished(f.socket,receipt.executionId);
  expect(unknown.attempts[0].actualSha).toBeUndefined();expect(unknown.attempts[0].location).toMatchObject({container:null,processIdentity:null,reconnectHandle:null});
  const child=children.pop()!;const exit=once(child,'exit');child.kill('SIGTERM');await exit;
  db.exec('DROP TRIGGER no_updates');db.close();await start(f.data,f.config);
  await cli(['cancel',receipt.executionId,'--socket',f.socket,'--reason','stop']);
  const pending=await call(f.socket,{command:'show',id:receipt.executionId}) as any;
  expect(pending.execution.status).toBe('unknown');expect(pending.attempts[0].cancellationLimit).toContain('No usable container');
  const audit={source:'operator',handling:'checked host',reason:'resolve',externalResults:'no writes observed'};
  await call(f.socket,{command:'confirm-stop',id:receipt.executionId,...audit});
  const resolved=await cli(['resolve',receipt.executionId,'--socket',f.socket,'--source',audit.source,'--handling',audit.handling,'--reason',audit.reason,'--external-results',audit.externalResults]);
  expect(resolved.execution.status).toBe('resolved');expect(resolved.attempts[0].reconciliation.externalResults).toBe('no writes observed');
},20000);

test('late cooperative stop cannot overwrite resolved history or a replacement attempt',async()=>{
  const f=await fixture(`await ctx.exec(['sh']);return {business:'done'}`);
  const child=children.pop()!;const exit=once(child,'exit');child.kill('SIGTERM');await exit;
  const bin=await temporary('orch-late-stop-');const release=join(bin,'release');const counter=join(bin,'counter');
  await writeFile(join(bin,'docker'),`#!/bin/sh\ncase "$1" in\nrun) if [ ! -f ${JSON.stringify(counter)} ]; then touch ${JSON.stringify(counter)}; while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.02; done; fi; exit 0;;\nstop) while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.02; done; exit 0;;\ninspect) echo '{"Running":false,"Status":"exited","ExitCode":0}';;\nesac\n`,{mode:0o700});
  await start(f.data,f.config,`${bin}:${process.env.PATH}`);const receipt=await submit(f);
  for(let i=0;i<100;i++){const d=await call(f.socket,{command:'show',id:receipt.executionId}) as any;if(d.execution.status==='running')break;await new Promise(r=>setTimeout(r,10))}
  await call(f.socket,{command:'cancel',id:receipt.executionId,reason:'stop'});
  const audit={source:'operator',handling:'checked externally',reason:'recover',externalResults:'no writes'};
  await expect(call(f.socket,{command:'confirm-stop',id:receipt.executionId,...audit})).rejects.toThrow('live');
  await expect(call(f.socket,{command:'retry',id:receipt.executionId,...audit})).rejects.toThrow('live');
  await writeFile(release,'done');
  await expect.poll(async()=>(await call(f.socket,{command:'show',id:receipt.executionId}) as any).execution.status).toBe('cancelled');
  await call(f.socket,{command:'retry',id:receipt.executionId,...audit});
  const detail=await finished(f.socket,receipt.executionId);expect(detail.execution.status).toBe('completed');expect(detail.attempts).toHaveLength(2);
  await writeFile(release,'done');await new Promise(r=>setTimeout(r,100));
  expect((await call(f.socket,{command:'show',id:receipt.executionId}) as any).execution.status).toBe('completed');
},20000);

test('completed result survives cancellation and retry preserves baseline with current configuration',async()=>{
  const f=await fixture(`return {business:'original'}`);const receipt=await submit(f);const old=await finished(f.socket,receipt.executionId);
  expect((await cli(['cancel',receipt.executionId,'--socket',f.socket,'--reason','late'])).execution.status).toBe('completed');
  const child=children.pop()!;const exit=once(child,'exit');child.kill('SIGTERM');await exit;
  const {readFile}=await import('node:fs/promises');const changed=(await readFile(f.config,'utf8')).replace("version:'config-v2'","version:'config-v3'").replace('commit(input){return input}',`commit(input){return '${'0'.repeat(40)}'}`);
  await writeFile(f.config,changed);await start(f.data,f.config);
  await cli(['retry',receipt.executionId,'--socket',f.socket,'--source','operator','--handling','checked','--reason','again','--external-results','no writes']);
  const detail=await finished(f.socket,receipt.executionId);
  expect(detail.attempts).toHaveLength(2);expect(detail.attempts[0]).toEqual(old.attempts[0]);
  expect(detail.attempts[1]).toMatchObject({actualSha:f.sha,configVersion:'config-v3',runState:'completed'});
  expect(detail.request.input).toBe(f.sha);
},20000);

test.each(['accept','running','cancel'])('required %s save failure does not claim success or start forbidden work',async window=>{
  const f=await fixture(`await ctx.exec(['sh']);return {business:'done'}`);
  const child=children.pop()!;const exit=once(child,'exit');child.kill('SIGTERM');await exit;
  const bin=await temporary('orch-fault-bin-');const marker=join(bin,'started');
  await writeFile(join(bin,'docker'),`#!/bin/sh\necho "$1" >> ${JSON.stringify(marker)}\nif [ "$1" = run ]; then exit 0; fi\necho '{"Running":true,"Status":"running","ExitCode":0}'\n`,{mode:0o700});
  await start(f.data,f.config,`${bin}:${process.env.PATH}`);
  const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(join(f.data,'records.sqlite'));
  if(window==='accept')db.exec("CREATE TRIGGER fault BEFORE INSERT ON executions BEGIN SELECT RAISE(FAIL,'accept blocked'); END;");
  if(window==='running')db.exec("CREATE TRIGGER fault BEFORE UPDATE ON attempts WHEN NEW.run_state='running' BEGIN SELECT RAISE(FAIL,'running blocked'); END;");
  if(window==='accept'){await expect(submit(f)).rejects.toThrow('accept blocked');expect(await call(f.socket,{command:'list'})).toEqual([]);}
  else {
    const receipt=await submit(f);const detail=await finished(f.socket,receipt.executionId);
    if(window==='running')expect(detail.execution.status).toBe('start_failed');
    else {
      db.exec("CREATE TRIGGER fault BEFORE INSERT ON execution_management BEGIN SELECT RAISE(FAIL,'cancel blocked'); END;");
      await expect(call(f.socket,{command:'cancel',id:receipt.executionId,reason:'stop'})).rejects.toThrow('cancel blocked');
      expect((await call(f.socket,{command:'show',id:receipt.executionId}) as any).attempts[0].cancellation).toBeUndefined();
    }
  }
  const {readFile}=await import('node:fs/promises');const calls=await readFile(marker,'utf8').catch(()=>'');
  expect(calls).not.toContain(window==='cancel'?'stop':'run');db.close();
},20000);

test.each([false,true])('running cancellation uses cooperative stop and preserves unconfirmed failure (%s)',async fail=>{
  const f=await fixture(`await ctx.exec(['sh']);return {business:'must not override cancellation'}`);
  const child=children.pop()!;const exit=once(child,'exit');child.kill('SIGTERM');await exit;
  const bin=await temporary('orch-cancel-bin-');const marker=join(bin,'stopped');
  await writeFile(join(bin,'docker'),`#!/bin/sh\ncase "$1" in\nrun) while [ ! -f ${JSON.stringify(marker)} ]; do sleep 0.02; done; exit 0;;\nstop) echo "$@" > ${JSON.stringify(join(bin,'args'))}; ${fail?'exit 1':`touch ${JSON.stringify(marker)}; exit 0`};;\ninspect) if [ -f ${JSON.stringify(marker)} ]; then echo '{"Running":false,"Status":"exited","ExitCode":0}'; else echo '{"Running":true,"Status":"running","ExitCode":0}'; fi;;\nesac\n`,{mode:0o700});
  await start(f.data,f.config,`${bin}:${process.env.PATH}`);const receipt=await submit(f);
  for(let i=0;i<100;i++){const d=await call(f.socket,{command:'show',id:receipt.executionId}) as any;if(d.execution.status==='running')break;await new Promise(r=>setTimeout(r,10))}
  await cli(['cancel',receipt.executionId,'--socket',f.socket,'--reason','operator request']);
  await new Promise(r=>setTimeout(r,150));
  const detail=await call(f.socket,{command:'show',id:receipt.executionId}) as any;
  expect(detail.attempts[0].cancellation.reason).toBe('operator request');
  expect(detail.attempts[0].business).toBeUndefined();
  if(fail){expect(detail.execution.status).toBe('unknown');expect(detail.attempts[0].stopConfirmation).toBeUndefined();await writeFile(marker,'cleanup');}
  else {expect(detail.execution.status).toBe('cancelled');expect(detail.attempts[0].stopConfirmation.kind).toBe('docker-inspect');}
  const {readFile}=await import('node:fs/promises');expect(await readFile(join(bin,'args'),'utf8')).toContain('stop --timeout -1');
},20000);

test('unknown attempt requires manual stop confirmation and reconciliation before retry',async()=>{
  const f=await fixture(`await ctx.exec(['sh']);return {business:'done'}`);
  const child=children.pop()!;const exit=once(child,'exit');child.kill('SIGTERM');await exit;
  const bin=await temporary('orch-recovery-bin-');
  await writeFile(join(bin,'docker'),`#!/bin/sh\nif [ "$1" = run ]; then echo old-output; exit 0; fi\necho '{"Running":true,"Status":"running","ExitCode":0}'\n`,{mode:0o700});
  await start(f.data,f.config,`${bin}:${process.env.PATH}`);const receipt=await submit(f);
  const old=await finished(f.socket,receipt.executionId);
  const audit={source:'operator',handling:'checked daemon and external systems',reason:'recover',externalResults:'no external writes'};
  await expect(call(f.socket,{command:'retry',id:receipt.executionId,...audit})).rejects.toThrow('Stop not confirmed');
  const confirmed=await cli(['confirm-stop',receipt.executionId,'--socket',f.socket,'--source',audit.source,'--handling',audit.handling,'--reason',audit.reason]);
  expect(confirmed.attempts[0].stopConfirmation).toMatchObject({kind:'manual',source:'operator'});
  await expect(call(f.socket,{command:'retry',id:receipt.executionId,source:'operator',handling:'checked',reason:'retry'})).rejects.toThrow('Missing externalResults');
  const retry=await call(f.socket,{command:'retry',id:receipt.executionId,...audit}) as any;
  expect(retry.execution.id).toBe(receipt.executionId);
  for(let i=0;i<100;i++){const d=await call(f.socket,{command:'show',id:receipt.executionId}) as any;if(d.attempts.length===2&&d.execution.status==='unknown')break;await new Promise(r=>setTimeout(r,20))}
  const detail=await call(f.socket,{command:'show',id:receipt.executionId}) as any;
  expect(detail.attempts).toHaveLength(2);expect(detail.attempts[0].id).toBe(old.attempts[0].id);
  expect(detail.attempts[0].runState).toBe('resolved');expect(detail.attempts[1].actualSha).toBe(f.sha);
  expect((await cli(['logs',receipt.executionId,'--socket',f.socket,'--attempt',old.attempts[0].id])).stdout).toContain('old-output');
},20000);

test('queued cancellation is persisted and not consumed after restart',async()=>{
  const f=await fixture(`return {business:'done'}`);
  let child=children.pop()!;let exit=once(child,'exit');child.kill('SIGTERM');await exit;
  const {readFile}=await import('node:fs/promises');const enabled=await readFile(f.config,'utf8');
  await writeFile(f.config,enabled.replace('execution:{commit(input){return input}},',''));
  await start(f.data,f.config);const receipt=await submit(f);
  const cancelled=await cli(['cancel',receipt.executionId,'--socket',f.socket,'--reason','not needed']);
  expect(cancelled.execution.status).toBe('cancelled');expect(cancelled.execution.cancellation.reason).toBe('not needed');
  child=children.pop()!;exit=once(child,'exit');child.kill('SIGTERM');await exit;
  await writeFile(f.config,enabled);await start(f.data,f.config);
  await new Promise(r=>setTimeout(r,100));
  const detail=await call(f.socket,{command:'show',id:receipt.executionId}) as any;
  expect(detail.execution.status).toBe('cancelled');expect(detail.attempts).toEqual([]);
},20000);

test('keyed socket concurrency and CLI retries never create another attempt', async () => {
  const f = await fixture(`await ctx.exec(['sh','/workspace/test.sh']);return {business:'done'}`, 'sleep 1\necho done\n');
  const submission = { repo:'alpha', capability:'test-commit', input:f.sha, source:'timer', deduplicationKey:'slot' };
  const args = ['submit','--socket',f.socket,'--repo','alpha','--capability','test-commit','--input',JSON.stringify(f.sha),'--source','timer','--deduplication-key','slot'];
  const receipts = await Promise.all(Array.from({length:8},()=>call(f.socket,{command:'submit',submission}))) as any[];
  const receipt = receipts[0];
  expect(receipt).toEqual({accepted:true,requestId:expect.any(String),executionId:expect.any(String)});
  for(const value of receipts)expect(value).toEqual(receipt);
  expect(await cli(args)).toEqual(receipt);
  expect((await finished(f.socket,receipt.executionId)).attempts).toHaveLength(1);
  expect(await cli(args)).toEqual(receipt);
  const child=children.pop()!;const exit=once(child,'exit');child.kill('SIGTERM');await exit;
  await start(f.data,f.config);
  expect(await cli(args)).toEqual(receipt);
  await new Promise(r=>setTimeout(r,100));
  const detail=await cli(['show',receipt.executionId,'--socket',f.socket]);
  expect(detail.execution.status).toBe('completed');expect(detail.attempts).toHaveLength(1);
},20000);
