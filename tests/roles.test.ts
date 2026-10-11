import { spawn, type ChildProcess, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { afterEach, expect, test } from 'vitest';
import { call } from '../src/control.js';
const root = resolve(import.meta.dirname, '..');
const dirs: string[] = []; const children: ChildProcess[] = [];
async function temporary() { const dir = await mkdtemp(join(tmpdir(),'orch-role-')); dirs.push(dir); return dir; }
async function start(config:string,data:string) {
  const child=spawn(process.execPath,['--import','tsx','src/cli.ts','serve','--config',config,'--data',data],{cwd:root});children.push(child);
  await new Promise<void>((resolve,reject)=>{let output='';let errors='';const timer=setTimeout(()=>reject(Error(errors || 'not ready')),10000);child.stdout.on('data',d=>{output+=d;if(output.includes('ready')){clearTimeout(timer);resolve()}});child.stderr.on('data',d=>errors+=d);child.once('exit',()=>{clearTimeout(timer);reject(Error(errors))})});return join(data,'control.sock');
}
afterEach(async()=>{await Promise.all(children.splice(0).map(async c=>{if(c.exitCode===null&&c.signalCode===null){const exited=once(c,'exit');c.kill('SIGTERM');await exited}}));await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})))});
test('same business role validates ordinary requests in independently registered repos',async()=>{
  const configDir=await temporary();const data=await temporary();const alpha=await temporary();const beta=await temporary();const config=join(configDir,'config.ts');
  await writeFile(config,`export default {version:'roles-v1',repos:[{id:'alpha',location:${JSON.stringify(alpha)}},{id:'beta',location:${JSON.stringify(beta)}}],environments:[],capabilities:[],roles:[{id:'report',description:'Read-only repository report',validate(input){if(typeof input!=='string')throw Error('text required')},buildPrompt(ctx){return ctx.input},skills:[],tools:[],validateReport(value){return value}}]}`);
  const socket=await start(config,data);
  for(const repo of ['alpha','beta']) {
    const receipt=await call(socket,{command:'submit',submission:{repo,capability:'report',input:'summarize',source:'manual'}}) as any;
    expect(receipt.accepted).toBe(true);const detail=await call(socket,{command:'show',id:receipt.executionId}) as any;expect(detail.request).toMatchObject({repo,capability:'report',input:'summarize'});expect(detail.execution.status).toBe('queued');
  }
  expect(await call(socket,{command:'submit',submission:{repo:'alpha',capability:'report',input:null,source:'manual'}})).toMatchObject({accepted:false,reason:'text required'});
},20000);

test.each(['valid','invalid','missing-exit','cancelled','save-failure','secret-start-failure','nonzero','text','session','session-read-failure','session-write-failure'])('role binding runs a fixed SHA with explicit %s report/end contract',async mode=>{
  const configDir=await temporary();const data=await temporary();const repo=await temporary();const bin=await temporary();
  const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();git('init');await writeFile(join(repo,'context.txt'),'fixed context');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','first');const sha=git('rev-parse','HEAD');
  const capture=mode.startsWith('session');
  const session=Buffer.alloc(9*1024*1024,120);session[0]=0;session[session.length-1]=255;
  const sessionSource=join(bin,'session');if(capture)await writeFile(sessionSource,session);
  const docker=join(bin,'docker');await writeFile(docker,`#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(join(bin,'calls'))}\ncase "$1" in\nrun) ${mode==='secret-start-failure'?'exit 1':'echo controlled-container'};;\ncp) exit 1;;\nexec) if [ \"$4\" = cat ] && [ \"$5\" = -- ] && [ \"$6\" = /home/agent/session ]; then cat ${JSON.stringify(sessionSource)}; exit ${mode==='session-read-failure'?23:0}; fi; case "$*" in *ORCH_EXIT_*) ${mode==='cancelled'?'sleep 1; ':''}marker=$(printf '%s' "$*" | grep -o 'ORCH_EXIT_[a-f0-9]*' | head -1); printf '${mode==='nonzero'||capture?'SESSION:controlled-session\\n':''}${mode==='invalid' ? 'not-json' : mode==='text'?'plain report':'{"summary":"controlled report"}'}\\n${mode==='missing-exit' ? '' : mode==='nonzero' ? '%s:7\\n' : '%s:0\\n'}' "$marker"; ${mode==='nonzero'?'exit 7':''};; *rev-parse*) echo ${sha};; esac;;\ninspect) echo '{"Running":true,"Status":"running"}' ;;\nstop) exit 0;;\nesac\n`,{mode:0o700});
  const config=join(configDir,'config.ts');await writeFile(config,`${capture?`import {mkdir} from 'node:fs/promises';import {join} from 'node:path';`:''}export default {version:'run-v1',repos:[{id:'alpha',location:${JSON.stringify(repo)}}],environments:[{id:'report-env',docker:{image:'controlled:image',binary:${JSON.stringify(docker)},network:'none',env:{API_KEY:'never-persist-this-secret'}}}],capabilities:[],providers:[{id:'controlled',agent:{name:'controlled',env:{},captureSessions:${capture},${capture?`sessionStorage:{async captureToHost({hostCwd,handle}){const to=join(hostCwd,'captured-session');${mode==='session-write-failure'?`await mkdir(to);`:''}await handle.copyFileOut('/home/agent/session',to)},hostSessionFilePath(cwd){return join(cwd,'captured-session')}},`:''}buildPrintCommand(){return {command:'controlled-agent'}},parseStreamLine(line){if(line.startsWith('SESSION:'))return [{type:'session_id',sessionId:line.slice(8)}];return [{type:'result',result:line}]}}}],roles:[{id:'report',description:'Read-only report',validate(input){if(typeof input!=='string')throw Error('text required')},buildPrompt(ctx){return 'Inspect '+ctx.repo+' '+ctx.actualSha+': '+ctx.input},skills:['Report facts only'],tools:[],validateReport(output){${mode==='text'?'return output;':''}const report=JSON.parse(output);if(typeof report.summary!=='string')throw Error('summary required');return report}}],roleBindings:[{role:'report',provider:'controlled',environment:'report-env',commit(){return '${sha}'}}]}`);
  const socket=await start(config,data);
  if(mode==='save-failure') {const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(join(data,'records.sqlite'));db.exec("CREATE TRIGGER no_prompt BEFORE UPDATE ON attempts WHEN json_extract(NEW.facts,'$.prompt') IS NOT NULL BEGIN SELECT RAISE(FAIL,'prompt save blocked'); END;");db.close();}
  const receipt=await call(socket,{command:'submit',submission:{repo:'alpha',capability:'report',input:'summarize',source:'manual'}}) as any;
  if(mode==='cancelled') {await expect.poll(async()=>(await call(socket,{command:'show',id:receipt.executionId}) as any).execution.status).toBe('running');await call(socket,{command:'cancel',id:receipt.executionId,reason:'operator'});}
  await expect.poll(async()=>(await call(socket,{command:'show',id:receipt.executionId}) as any).execution.status,{timeout:10000}).toBe(mode==='missing-exit'||mode==='secret-start-failure'?'unknown':mode==='cancelled'?'cancelled':mode==='save-failure'?'start_failed':'completed');
  const detail=await call(socket,{command:'show',id:receipt.executionId}) as any;
  if(capture){
    const calls=await readFile(join(bin,'calls'),'utf8');expect(calls).toContain(`exec -i ${detail.attempts[0].container} cat -- /home/agent/session`);expect(calls).not.toMatch(/^cp /m);
    expect(detail.attempts[0]).toMatchObject({exitCode:0,contract:'valid',business:{summary:'controlled report'}});
    if(mode==='session'){expect(detail.attempts[0].error).toBeUndefined();expect(detail.attempts[0].iterations[0]).toMatchObject({sessionId:'controlled-session',sessionFilePath:join(detail.attempts[0].workspace,'captured-session')});expect(await readFile(detail.attempts[0].iterations[0].sessionFilePath)).toEqual(session);}
    else expect(detail.attempts[0]).toMatchObject({error:'Agent execution or SDK postprocessing failed',iterations:[{sessionId:'controlled-session'}]});
    return;
  }
  if(mode==='text'){expect(detail.attempts[0]).toMatchObject({contract:'valid',business:'plain report',output:'plain report'});return;}
  if(mode==='nonzero'){expect(detail.attempts[0]).toMatchObject({exitCode:7,output:'{"summary":"controlled report"}',contract:'valid',business:{summary:'controlled report'},iterations:[{sessionId:'controlled-session'}],error:'Agent execution or SDK postprocessing failed'});return;}
  if(mode==='secret-start-failure'){expect(JSON.stringify(detail)).not.toContain('never-persist-this-secret');expect(JSON.stringify(await call(socket,{command:'logs',id:receipt.executionId}))).not.toContain('never-persist-this-secret');return;}
  if(mode!=='valid'){
    expect(detail.attempts[0].business).toBeUndefined();
    if(mode==='save-failure') {expect(detail.attempts[0].error).toContain('prompt save blocked');expect(await (await import('node:fs/promises')).readFile(join(bin,'calls'),'utf8').catch(()=>'' )).toBe('');return;}
    if(mode==='cancelled') {const stopped=await (await import('node:fs/promises')).readFile(join(detail.attempts[0].stopDirectory,'requested'),'utf8');expect(stopped).toBe('requested\n');expect(detail.attempts[0].prompt).toContain('/orchestrator-stop/requested');expect(detail.attempts[0].stopConfirmation.kind).toBe('agent-exit-marker');}
    else if(mode==='invalid')expect(detail.attempts[0].contract).toBe('error');
    else {expect(detail.attempts[0].stopConfirmation).toBeUndefined();await call(socket,{command:'cancel',id:receipt.executionId,reason:'operator'});expect((await call(socket,{command:'show',id:receipt.executionId}) as any).attempts[0].cancellationLimit).toContain('Agent cancellation');
      const audit={source:'operator',handling:'checked host and daemon',reason:'retry',externalResults:'no writes'};
      await expect(call(socket,{command:'retry',id:receipt.executionId,...audit})).rejects.toThrow('Stop not confirmed');
      const child=children.pop()!;const exit=once(child,'exit');child.kill('SIGTERM');await exit;
      const restarted=await start(config,data);const persisted=await call(restarted,{command:'show',id:receipt.executionId}) as any;expect(persisted.execution.status).toBe('unknown');expect(persisted.attempts).toHaveLength(1);
      await rm(join(detail.attempts[0].stopDirectory,'requested'));await rm(detail.attempts[0].stopDirectory,{recursive:true});
      await call(restarted,{command:'cancel',id:receipt.executionId,reason:'notify again'});
      await expect.poll(async()=>(await call(restarted,{command:'show',id:receipt.executionId}) as any).attempts[0].cancellationNotification).toBe('failed');
      const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(join(data,'records.sqlite'));db.exec("CREATE TRIGGER no_notification BEFORE UPDATE ON attempts WHEN json_extract(NEW.facts,'$.cancellationNotification')='published' BEGIN SELECT RAISE(FAIL,'notification save blocked'); END;");db.close();
      await (await import('node:fs/promises')).mkdir(detail.attempts[0].stopDirectory);await call(restarted,{command:'cancel',id:receipt.executionId,reason:'notify again'});
      await expect.poll(async()=>String((await call(restarted,{command:'show',id:receipt.executionId}) as any).attempts[0].persistenceError)).toContain('published, but required record save failed');
    }
    return;
  }
  expect(detail.attempts[0]).toMatchObject({kind:'agent',actualSha:sha,configVersion:'run-v1',provider:'controlled',exitCode:0,contract:'valid',business:{summary:'controlled report'}});expect(detail.attempts[0].prompt).toContain('Report facts only');expect(detail.attempts[0].branch).toMatch(/^orch\//);expect((await call(socket,{command:'logs',id:receipt.executionId}) as any).stdout).toContain('controlled report');
  await call(socket,{command:'retry',id:receipt.executionId,source:'operator',handling:'reviewed',reason:'again',externalResults:'no writes'});
  await expect.poll(async()=>(await call(socket,{command:'show',id:receipt.executionId}) as any).attempts.length).toBe(2);
  await expect.poll(async()=>(await call(socket,{command:'show',id:receipt.executionId}) as any).execution.status).toBe('completed');
  const calls=await (await import('node:fs/promises')).readFile(join(bin,'calls'),'utf8');expect(calls).toContain('--read-only');expect(calls).toContain(',readonly');expect(calls).toContain('--workdir /home/agent/workspace');expect(calls).toContain('HOME=/home/agent');expect(calls).not.toContain('rm -f');expect(calls).not.toContain('stop ');
  const retry=await call(socket,{command:'show',id:receipt.executionId}) as any;expect(retry.attempts[1]).toMatchObject({actualSha:sha,sessionPolicy:'new'});expect(retry.attempts[1].branch).not.toBe(detail.attempts[0].branch);expect(retry.attempts[0]).toEqual(detail.attempts[0]);
},20000);
