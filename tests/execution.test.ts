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
  for(let i=0;i<100;i++) {
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
  const f=await fixture(`await ctx.exec(['sh','-c','echo first']);await ctx.exec(['sh','-c','echo second; sleep 1']);return {business:'done'}`);
  const receipt=await submit(f);
  let observed=false;
  for(let i=0;i<150;i++) {
    const logs=await call(f.socket,{command:'logs',id:receipt.executionId}) as any;
    if(logs.stdout?.includes('second')){expect(logs.complete).toBe(false);observed=true;break}
    await new Promise(r=>setTimeout(r,10));
  }
  expect(observed).toBe(true);const detail=await finished(f.socket,receipt.executionId);expect(detail.execution.status).toBe('completed');
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
