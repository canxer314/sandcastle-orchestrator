import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
const root=resolve(import.meta.dirname,'..');
const dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})));});
test.each([false,true])('public PR snapshot tool reads only administrator-authorized PRs despite scope mutation %s',async mutate=>{
  const dir=await mkdtemp(join(tmpdir(),'orch-pr-'));dirs.push(dir);
  const file=join(dir,'snapshot.json');
  await writeFile(file,JSON.stringify({version:'export-1',collectedAt:'2026-10-10T12:00:00Z',pullRequests:[{repo:'owner/repo',number:3,url:'https://github.com/owner/repo/pull/3',updatedAt:'2026-10-10T11:00:00Z',headSha:'a'.repeat(40),body:'A missing input validation',reviews:[],diff:'changed validation',missing:['review threads'],truncated:false},{repo:'owner/repo',number:4,url:'https://github.com/owner/repo/pull/4',updatedAt:'2026-10-10T11:00:00Z',headSha:'b'.repeat(40),body:'not authorized',reviews:[],diff:'',missing:[],truncated:false}]}));
  const tool=join(dir,'tool.mts');await writeFile(tool,`import {createPrSnapshotTool} from ${JSON.stringify(join(root,'src/pr-analysis.ts'))}; const scope={path:${JSON.stringify(file)},repo:'owner/repo',pullRequests:[3]};const tool=createPrSnapshotTool(scope);${mutate?`scope.path='/not-authorized';scope.repo='other/repo';scope.pullRequests.push(4);`:''}console.log(JSON.stringify(await tool.read(JSON.parse(process.argv[2]))));`);
  const run=(input:unknown)=>execFileSync(process.execPath,['--import','tsx',tool,JSON.stringify(input)],{cwd:root,encoding:'utf8'});
  expect(JSON.parse(run({number:3}))).toMatchObject({source:{kind:'administrator-snapshot',version:'export-1',collectedAt:'2026-10-10T12:00:00Z',verifiedAgainstGitHub:false},pullRequest:{number:3,headSha:'a'.repeat(40),missing:['review threads'],truncated:false}});
  expect(()=>run({number:4})).toThrow();expect(()=>run({number:3,repo:'other/repo'})).toThrow();
});

test.each(['partial-observation-write','recovered-observation-write','concurrent-observations','normal','large','denied','tool-failure','save-failure','scope-change','report-save-failure','business-save-failure','unicode','unicode-preview','large-cancelled','late-save-failure','late-success','late-disconnected-save-failure'])('role invokes its authorized readonly tool and CLI separates observed facts from %s model report',async mode=>{
  const dir=await mkdtemp(join(tmpdir(),'orch-pr-run-'));dirs.push(dir);
  const repo=join(dir,'repo');const data=join(dir,'data');const configuration=join(dir,'config');
  const {mkdir}=await import('node:fs/promises');for(const path of [repo,data,configuration])await mkdir(path);
  const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();git('init');await writeFile(join(repo,'code.txt'),'fixed');git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','fixture');const sha=git('rev-parse','HEAD');
  if(mode==='unicode')await writeFile(join(dir,'unicode.mjs'),`import {request,createServer} from 'node:http';import {spawn} from 'node:child_process';
const mount=process.argv[2];
const observed=await new Promise((resolve,reject)=>{const req=request({socketPath:mount+'/tools.sock',method:'POST'},res=>{res.setEncoding('utf8');let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve(JSON.parse(body)));});req.on('error',reject);const bytes=Buffer.from(JSON.stringify({tool:'unicode',input:'中文'}));const split=bytes.indexOf(Buffer.from('中'))+1;req.write(bytes.subarray(0,split));setTimeout(()=>req.end(bytes.subarray(split)),30);});
const socket=${JSON.stringify(join(dir,'unicode.sock'))};const server=createServer((req,res)=>{const bytes=Buffer.from(JSON.stringify('中文'));res.write(bytes.subarray(0,2));setTimeout(()=>res.end(bytes.subarray(2)),30);});await new Promise(resolve=>server.listen(socket,resolve));
const received=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[mount+'/call.mjs','unicode','null'],{env:{ORCHESTRATOR_TOOL_SOCKET:socket}});let out='';child.stdout.setEncoding('utf8');child.stdout.on('data',c=>out+=c);child.on('error',reject);child.on('close',()=>resolve(JSON.parse(out)));});server.close();console.log(JSON.stringify({observed,received}));`);
  if(mode==='late-disconnected-save-failure')await writeFile(join(dir,'disconnect.mjs'),`import {request} from 'node:http';import {access} from 'node:fs/promises';const req=request({socketPath:process.argv[2]+'/tools.sock',method:'POST'});req.on('error',()=>{});req.end(JSON.stringify({tool:'pr-snapshot',input:{number:3}}));while(true){try{await access(${JSON.stringify(join(dir,'accepted'))});break;}catch{}await new Promise(r=>setTimeout(r,10));}req.destroy();`);
  if(['recovered-observation-write','partial-observation-write'].includes(mode))await writeFile(join(dir,'recover.mjs'),`import {request} from 'node:http';import {unlink,mkdir,rmdir,writeFile} from 'node:fs/promises';import {execFileSync} from 'node:child_process';
const mount=process.argv[2];const file=mount+'/../artifacts/observations.jsonl';
const invoke=label=>new Promise((resolve,reject)=>{const req=request({socketPath:mount+'/tools.sock',method:'POST'},res=>{res.setEncoding('utf8');let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,value:JSON.parse(body)}));});req.on('error',reject);req.end(JSON.stringify({tool:'recovery-read',input:{label}}));});
${mode==='partial-observation-write'?`const prior=await invoke('prior');if(prior.status!==200)throw Error('Prior evidence not saved');const pid=prior.value.pid;execFileSync('prlimit',['--pid',String(pid),'--fsize=1024:unlimited']);let failed;try{failed=await invoke('first');}finally{execFileSync('prlimit',['--pid',String(pid),'--fsize=unlimited:unlimited']);}`:`await unlink(file);await mkdir(file);const failed=await invoke('first');`}
if(failed.status!==400||failed.value.error!=='Tool observation could not be saved; result not delivered')throw Error('Unsaved result delivered');
${mode==='partial-observation-write'?'':`await rmdir(file);await writeFile(file,'');`}const later=await invoke('later');
if(later.status!==200||later.value!=='later evidence')throw Error('Later observation write did not recover');
console.log('Later evidence saved after failed observation');`);
  if(mode==='concurrent-observations')await writeFile(join(dir,'parallel.mjs'),`import {request} from 'node:http';
const results=await Promise.all(['A','B','C'].map(label=>new Promise((resolve,reject)=>{const req=request({socketPath:process.argv[2]+'/tools.sock',method:'POST'},res=>{res.setEncoding('utf8');let body='';res.on('data',c=>body+=c);res.on('end',()=>{try{if(res.statusCode!==200)throw Error(body);const value=JSON.parse(body);if(value!==label.repeat(3*1024*1024))throw Error('Incomplete tool result');resolve(label);}catch(error){reject(error);}});});req.on('error',reject);req.end(JSON.stringify({tool:'large-read',input:{label}}));})));
console.log('Saved complete results: '+results.join(','));`);
  const docker=join(dir,'docker');
  await writeFile(docker,`#!/usr/bin/env node
const fs=require('node:fs');const cp=require('node:child_process');const args=process.argv.slice(2);const state=${JSON.stringify(join(dir,'mount'))};
if(args[0]==='run'){const mount=args.find(a=>a.includes('dst=/orchestrator-tools,'));fs.writeFileSync(state,mount?mount.match(/src=([^,]+)/)[1]:'');${mode==='save-failure'?`if(mount){const tools=mount.match(/src=([^,]+)/)[1];fs.unlinkSync(tools+'/../artifacts/observations.jsonl');fs.mkdirSync(tools+'/../artifacts/observations.jsonl');}`:''}console.log('controlled');${['report-save-failure','business-save-failure'].includes(mode)?`if(mount){const tools=mount.match(/src=([^,]+)/)[1];fs.mkdirSync(tools+'/../artifacts/${mode==='report-save-failure'?'report.txt':'business.json'}');}`:''}}
else if(args[0]==='exec'){const text=args.at(-1);if(text.includes('ORCH_EXIT_')){${mode==='large-cancelled'?`const stop=fs.readFileSync(state,'utf8')+'/../stop/requested';const deadline=Date.now()+10000;while(!fs.existsSync(stop)){if(Date.now()>deadline)process.exit(1);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}`:''}const mount=fs.readFileSync(state,'utf8');try{${['recovered-observation-write','partial-observation-write'].includes(mode)?`console.log(cp.execFileSync(process.execPath,[${JSON.stringify(join(dir,'recover.mjs'))},mount],{encoding:'utf8',timeout:10000}).trim());console.log(text.match(/ORCH_EXIT_[a-f0-9]+/)[0]+':0');process.exit(0);`:''}${mode==='concurrent-observations'?`console.log(cp.execFileSync(process.execPath,[${JSON.stringify(join(dir,'parallel.mjs'))},mount],{encoding:'utf8',timeout:10000}).trim());console.log(text.match(/ORCH_EXIT_[a-f0-9]+/)[0]+':0');process.exit(0);`:''}${mode==='unicode'?`console.log(cp.execFileSync(process.execPath,[${JSON.stringify(join(dir,'unicode.mjs'))},mount],{encoding:'utf8'}).trim());`:''}${mode.startsWith('late-')?`const background=cp.spawn(process.execPath,${mode==='late-disconnected-save-failure'?`[${JSON.stringify(join(dir,'disconnect.mjs'))},mount]`:`[mount+'/call.mjs','pr-snapshot','{"number":3}']`},{env:{ORCHESTRATOR_TOOL_SOCKET:mount+'/tools.sock'},stdio:['ignore',fs.openSync(${JSON.stringify(join(dir,'tool-out'))},'w'),fs.openSync(${JSON.stringify(join(dir,'tool-error'))},'w')],detached:true});background.unref();const deadline=Date.now()+10000;while(!fs.existsSync(${JSON.stringify(join(dir,'accepted'))})){if(Date.now()>deadline)process.exit(2);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}console.log('Report without waiting for tool');console.log(text.match(/ORCH_EXIT_[a-f0-9]+/)[0]+':0');process.exit(0);`:''}const facts=JSON.parse(cp.execFileSync(process.execPath,[mount+'/call.mjs','pr-snapshot',${JSON.stringify(JSON.stringify({number:mode==='denied'?4:3}))}],{env:{ORCHESTRATOR_TOOL_SOCKET:mount+'/tools.sock'},encoding:'utf8'}));console.log('Report: '+facts.pullRequest.body+'; source administrator snapshot, missing '+facts.pullRequest.missing.join(', ')+${mode==='large'||mode==='business-save-failure'||mode==='large-cancelled'?"'x'.repeat(9*1024*1024)+' END-OF-REPORT'":"''"});}catch(e){console.log('Unable to collect authorized PR evidence');}console.log(text.match(/ORCH_EXIT_[a-f0-9]+/)[0]+':0');}else if(text.includes('rev-parse'))console.log(${JSON.stringify(sha)});}
`,{mode:0o700});
  const evidence=join(configuration,'snapshot.json');await writeFile(evidence,JSON.stringify({version:'v1',collectedAt:'2026-10-10T12:00:00Z',pullRequests:[{repo:'owner/repo',number:3,url:'https://github.com/owner/repo/pull/3',updatedAt:'2026-10-10T11:00:00Z',headSha:sha,body:'missing input validation',reviews:[],diff:'code evidence',missing:['review threads'],truncated:false}]}));
  const config=join(configuration,'config.ts');await writeFile(config,`import {createPrSnapshotTool,createPrAnalysisRole} from ${JSON.stringify(join(root,'src/pr-analysis.ts'))}; export default {version:'config-v1',repos:[{id:'sample',location:${JSON.stringify(repo)}}],environments:[{id:'readonly',docker:{image:'controlled:image',binary:${JSON.stringify(docker)}}}],capabilities:[],tools:[${['recovered-observation-write','partial-observation-write'].includes(mode)?`{id:'recovery-read',description:'Read controlled evidence',async read(input){${mode==='partial-observation-write'?`if(input.label==='prior')return {pid:process.pid,evidence:'prior evidence'};if(input.label==='first')return 'A'.repeat(8192);`:''}return input.label+' evidence'}},`:''}${mode==='concurrent-observations'?`{id:'large-read',description:'Read controlled large evidence',read:(()=>{let count=0;let release;const ready=new Promise(r=>release=r);return async input=>{if(++count===3)release();await ready;return input.label.repeat(3*1024*1024)}})()},`:''}${mode==='unicode'?`{id:'unicode',description:'Echo observed Unicode',async read(input){return input}},`:''}${mode.startsWith('late-')?`{id:'pr-snapshot',description:'Controlled delayed read',async read(){const fs=await import('node:fs/promises');await fs.writeFile(${JSON.stringify(join(dir,'accepted'))},'accepted');while(true){try{await fs.access(${JSON.stringify(join(dir,'release'))});break;}catch{}await new Promise(r=>setTimeout(r,10));}return {pullRequest:{body:'delayed evidence',missing:[]}}}}`:`createPrSnapshotTool({path:${JSON.stringify(evidence)},repo:'owner/repo',pullRequests:[3]})`}],roles:[${['recovered-observation-write','partial-observation-write'].includes(mode)?`{...createPrAnalysisRole({repo:'owner/repo',pullRequests:[3]}),tools:['recovery-read']}`:mode==='concurrent-observations'?`{...createPrAnalysisRole({repo:'owner/repo',pullRequests:[3]}),tools:['large-read']}`:mode==='unicode'?`{...createPrAnalysisRole({repo:'owner/repo',pullRequests:[3]}),tools:['pr-snapshot','unicode']}`:`createPrAnalysisRole({repo:'owner/repo',pullRequests:[3]})`}],providers:[{id:'controlled',agent:{name:'controlled',env:{},captureSessions:false,buildPrintCommand(){return {command:'controlled-agent'}},parseStreamLine(line){return [{type:'result',result:${mode==='unicode-preview'?"'Report: '+'a'.repeat(65522)+'中😀中文 END-OF-REPORT; source administrator snapshot, missing review threads'":"line"}}]}}}],roleBindings:[{role:'pr-analysis',provider:'controlled',environment:'readonly',commit(){return '${sha}'}}]}`);
  const clock=join(dir,'clock.mjs');const advanceClock=join(dir,'advance-clock');
  await writeFile(clock,`import {existsSync} from 'node:fs';const now=Date.now;Date.now=()=>now()+(existsSync(${JSON.stringify(advanceClock)})?31*24*60*60*1000:0);`);
  const signals=join(dir,'signals.mjs');await writeFile(signals,`process.on('SIGXFSZ',()=>{});`);
  const child=spawn(process.execPath,['--import','tsx','--import',signals,'--import',clock,'src/cli.ts','serve','--config',config,'--data',data],{cwd:root});
  try {
    await new Promise<void>((resolve,reject)=>{let out='';let err='';const timer=setTimeout(()=>reject(Error(err||'not ready')),10000);child.stdout.on('data',d=>{out+=d;if(out.includes('ready')){clearTimeout(timer);resolve();}});child.stderr.on('data',d=>err+=d);child.once('exit',()=>{clearTimeout(timer);reject(Error(err));});});
    if(mode==='tool-failure')await rm(evidence);
    const {call}=await import('../src/control.js');const socket=join(data,'control.sock');
    expect(await call(socket,{command:'submit',submission:{repo:'sample',capability:'pr-analysis',input:{sha,pullRequests:[4]},source:'test'}})).toMatchObject({accepted:false});
    const receipt=await call(socket,{command:'submit',submission:{repo:'sample',capability:'pr-analysis',input:{sha,pullRequests:[3]},source:'test'}}) as any;
    if(mode.startsWith('late-')) {
      const cli=(...args:string[])=>JSON.parse(execFileSync(process.execPath,['--import','tsx','src/cli.ts',...args,'--socket',socket],{cwd:root,encoding:'utf8'}));
      try {
        await expect.poll(async()=>(await call(socket,{command:'show',id:receipt.executionId}) as any).attempts[0]?.report,{timeout:10000}).toMatchObject({complete:true});
        const pending=cli('show',receipt.executionId);
        expect(pending.execution.status).toBe('running');
        expect(pending.attempts[0].business).toBeUndefined();expect(pending.attempts[0].contract).toBeUndefined();
        expect(pending.attempts[0].stopConfirmation).toBeUndefined();
        if(mode!=='late-success'){const observations=join(data,'attempts',pending.attempts[0].id,'artifacts','observations.jsonl');await rm(observations);await mkdir(observations);}
        await writeFile(join(dir,'release'),'release');
        if(mode==='late-success') {
          await expect.poll(async()=>(await call(socket,{command:'show',id:receipt.executionId}) as any).execution.status,{timeout:10000}).toBe('completed');
          const final=cli('show',receipt.executionId);expect(final.attempts[0]).toMatchObject({business:'Report without waiting for tool',contract:'valid',stopConfirmation:{kind:'agent-exit-marker',exitCode:0}});
          const observation=cli('artifact',receipt.executionId,'--name','observations.jsonl');expect(JSON.parse(Buffer.from(observation.content,'base64').toString())).toMatchObject({tool:'pr-snapshot',input:{number:3},result:{pullRequest:{body:'delayed evidence'}}});
          await expect.poll(async()=>await import('node:fs/promises').then(fs=>fs.readFile(join(dir,'tool-out'),'utf8'))).toContain('delayed evidence');return;
        }
        await expect.poll(async()=>(await call(socket,{command:'show',id:receipt.executionId}) as any).attempts[0]?.toolObservationError,{timeout:10000}).toContain('could not be saved');
        const final=cli('show',receipt.executionId);
        expect(final.execution.status).toBe('unknown');
        expect(final.attempts[0]).toMatchObject({runState:'unknown',exitCode:0,stopConfirmation:{kind:'agent-exit-marker',exitCode:0},toolObservationError:expect.stringContaining('could not be saved')});
        expect(final.attempts[0].business).toBeUndefined();expect(final.attempts[0].businessReference).toBeUndefined();expect(final.attempts[0].contract).toBeUndefined();
        const report=cli('artifact',receipt.executionId,'--name','report.txt');expect(Buffer.from(report.content,'base64').toString()).toBe('Report without waiting for tool');
        await writeFile(advanceClock,'advance');expect(cli('cleanup')).toEqual({attempts:[]});
        await call(socket,{command:'cancel',id:receipt.executionId,reason:'operator review'});
        expect(cli('show',receipt.executionId).attempts[0]).toMatchObject({runState:'unknown',toolObservationError:expect.stringContaining('could not be saved')});
        expect(cli('cleanup')).toEqual({attempts:[]});expect(cli('artifact',receipt.executionId,'--name','report.txt').content).toBe(report.content);
      } finally {await writeFile(join(dir,'release'),'release');}
      return;
    }
    if(mode==='large-cancelled') {
      await expect.poll(async()=>(await call(socket,{command:'show',id:receipt.executionId}) as any).execution.status).toBe('running');
      await call(socket,{command:'cancel',id:receipt.executionId,reason:'operator'});
    }
    await expect.poll(async()=>(await call(socket,{command:'show',id:receipt.executionId}) as any).execution.status,{timeout:10000}).toBe(mode==='large-cancelled'?'cancelled':['partial-observation-write','recovered-observation-write','save-failure','report-save-failure','business-save-failure'].includes(mode)?'unknown':'completed');
    const cli=(...args:string[])=>JSON.parse(execFileSync(process.execPath,['--import','tsx','src/cli.ts',...args,'--socket',socket],{cwd:root,encoding:'utf8',maxBuffer:2*1024*1024}));
    const detail=cli('show',receipt.executionId);
    if(['recovered-observation-write','partial-observation-write'].includes(mode)) {
      expect(detail.attempts[0]).toMatchObject({runState:'unknown',exitCode:0,stopConfirmation:{kind:'agent-exit-marker',exitCode:0},toolObservationError:'Tool observation could not be saved; result not delivered'});
      expect(detail.attempts[0].business).toBeUndefined();expect(detail.attempts[0].businessReference).toBeUndefined();expect(detail.attempts[0].contract).toBeUndefined();
      const artifact=cli('artifact',receipt.executionId,'--name','observations.jsonl');
      const observations=Buffer.from(artifact.content,'base64').toString().trimEnd().split('\n').map(line=>JSON.parse(line));
      if(mode==='partial-observation-write'){expect(observations).toHaveLength(2);expect(observations[0]).toMatchObject({input:{label:'prior'},result:{evidence:'prior evidence'}});}
      expect(observations.at(-1)).toEqual({attemptId:detail.attempts[0].id,actualSha:sha,observedAt:expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),tool:'recovery-read',input:{label:'later'},result:'later evidence'});
      expect(Buffer.from(cli('artifact',receipt.executionId,'--name','report.txt').content,'base64').toString()).toBe('Later evidence saved after failed observation');
      await writeFile(advanceClock,'advance');expect(cli('cleanup')).toEqual({attempts:[]});return;
    }
    if(mode==='concurrent-observations') {
      expect(detail.attempts[0].toolObservationError).toBeUndefined();
      expect(detail.attempts[0].business).toBe('Saved complete results: A,B,C');
      const chunks:Buffer[]=[];let offset=0;let chunk;
      do {chunk=cli('artifact',receipt.executionId,'--name','observations.jsonl','--offset',String(offset));const bytes=Buffer.from(chunk.content,'base64');chunks.push(bytes);offset+=bytes.length;}while(!chunk.complete);
      expect(offset).toBeGreaterThan(9*1024*1024);
      const lines=Buffer.concat(chunks).toString('utf8').trimEnd().split('\n');
      expect(lines).toHaveLength(3);
      const observations=lines.map(line=>JSON.parse(line)).sort((a,b)=>a.input.label.localeCompare(b.input.label));
      for(const [index,label] of ['A','B','C'].entries())expect(observations[index]).toEqual({attemptId:detail.attempts[0].id,actualSha:sha,observedAt:expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),tool:'large-read',input:{label},result:label.repeat(3*1024*1024)});
      expect(cli('cleanup')).toEqual({attempts:[]});return;
    }
    if(mode==='unicode-preview') {
      expect(Buffer.byteLength(detail.attempts[0].output)).toBeLessThanOrEqual(65536);
      expect(detail.attempts[0].output.slice(-12)).toBe('a'.repeat(11)+'中');
      expect(detail.attempts[0].outputTruncated).toBe(true);
      expect(detail.attempts[0].report).toMatchObject({complete:true,truncated:false});
      const artifact=cli('artifact',receipt.executionId,'--name','report.txt');
      expect(Buffer.from(artifact.content,'base64').toString('utf8')).toBe('Report: '+'a'.repeat(65522)+'中😀中文 END-OF-REPORT; source administrator snapshot, missing review threads');
      expect(detail.request.input).toEqual({sha,pullRequests:[3]});
      expect(detail.attempts[0].actualSha).toBe(sha);return;
    }
    if(mode==='unicode') {
      const logs=cli('logs',receipt.executionId);expect(logs.stdout).toContain('"observed":"中文"');expect(logs.stdout).toContain('"received":"中文"');return;
    }
    if(['report-save-failure','business-save-failure'].includes(mode)) {
      expect(detail.attempts[0]).toMatchObject({exitCode:0,stopConfirmation:{kind:'agent-exit-marker',exitCode:0},reportPersistenceError:expect.any(String)});
      expect(detail.attempts[0].endedAt).toEqual(expect.any(String));expect(detail.attempts[0].contract).not.toBe('error');expect(detail.attempts[0].businessReference).toBeUndefined();
      if(mode==='report-save-failure')expect(detail.attempts[0].report).toMatchObject({missing:true,complete:false});return;
    }
    if(mode==='save-failure') {
      expect(detail.attempts[0]).toMatchObject({runState:'unknown',exitCode:0,stopConfirmation:{kind:'agent-exit-marker',exitCode:0},actualSha:sha,toolObservationError:expect.stringContaining('could not be saved')});
      expect(detail.attempts[0].business).toBeUndefined();expect(detail.attempts[0].businessReference).toBeUndefined();expect(detail.attempts[0].contract).toBeUndefined();
      expect(detail.request.input).toEqual({sha,pullRequests:[3]});
      const report=cli('artifact',receipt.executionId,'--name','report.txt');
      expect(Buffer.from(report.content,'base64').toString()).toBe('Unable to collect authorized PR evidence');
      await writeFile(advanceClock,'advance');
      expect(cli('cleanup')).toEqual({attempts:[]});
      expect(cli('artifact',receipt.executionId,'--name','report.txt').content).toBe(report.content);
      expect(cli('logs',receipt.executionId).stdout).toContain('Unable to collect authorized PR evidence');
      await call(socket,{command:'cancel',id:receipt.executionId,reason:'operator review'});
      expect(cli('show',receipt.executionId).execution.status).toBe('unknown');
      expect(cli('cleanup')).toEqual({attempts:[]});return;
    }
    if(['denied','tool-failure'].includes(mode)) {
      expect(detail.attempts[0].business).toBe('Unable to collect authorized PR evidence');
      const artifact=cli('artifact',receipt.executionId,'--name','observations.jsonl');
      const facts=JSON.parse(Buffer.from(artifact.content,'base64').toString().trim());expect(facts.error).toContain('unavailable');expect(facts.result).toBeUndefined();return;
    }
    if(mode==='large-cancelled') {
      expect(detail.attempts[0].businessReference).toBeUndefined();
      expect(detail.attempts[0].business).toBeUndefined();expect(detail.attempts[0].contract).toBeUndefined();
      expect(detail.attempts[0].stopConfirmation).toMatchObject({kind:'agent-exit-marker',exitCode:0});
      expect(detail.request.input).toEqual({sha,pullRequests:[3]});expect(detail.attempts[0].actualSha).toBe(sha);
      const observed=cli('artifact',receipt.executionId,'--name','observations.jsonl');
      expect(JSON.parse(Buffer.from(observed.content,'base64').toString().trim()).result.pullRequest.headSha).toBe(sha);
    }
    if(mode==='large'||mode==='large-cancelled') {
      expect(detail.attempts[0].report).toMatchObject({name:'report.txt',complete:true,truncated:false});
      let offset=0;let report='';let chunk;
      do {chunk=cli('artifact',receipt.executionId,'--name','report.txt','--offset',String(offset));const bytes=Buffer.from(chunk.content,'base64');offset+=bytes.length;report+=bytes.toString();}while(!chunk.complete);
      expect(report.startsWith('Report: missing input validation')).toBe(true);expect(report.endsWith('END-OF-REPORT')).toBe(true);expect(report.length).toBeGreaterThan(9*1024*1024);
      expect(cli('logs',receipt.executionId).truncated.stdout).toBe(true);return;
    }
    expect(detail.attempts[0].business).toContain('missing input validation');
    expect(detail.attempts[0].outputTruncated).toBeUndefined();
    const artifact=cli('artifact',receipt.executionId,'--name','observations.jsonl');const facts=JSON.parse(Buffer.from(artifact.content,'base64').toString().trim());
    expect(facts).toMatchObject({tool:'pr-snapshot',input:{number:3},result:{source:{kind:'administrator-snapshot',version:'v1',verifiedAgainstGitHub:false},pullRequest:{number:3,headSha:sha}}});
    expect(cli('logs',receipt.executionId).stdout).toContain('source administrator snapshot');
    if(mode==='scope-change') {
      const first=detail.attempts[0];
      await writeFile(evidence,JSON.stringify({version:'v2',collectedAt:'2026-10-11T12:00:00Z',pullRequests:[]}));
      await call(socket,{command:'retry',id:receipt.executionId,source:'operator',reason:'updated evidence',handling:'no external writes',externalResults:'none'});
      await expect.poll(async()=>(await call(socket,{command:'show',id:receipt.executionId}) as any).attempts.at(-1).business,{timeout:10000}).toBe('Unable to collect authorized PR evidence');
      const after=cli('show',receipt.executionId);expect(after.attempts[0]).toEqual(first);expect(after.attempts[1].actualSha).toBe(sha);
      const old=cli('artifact',receipt.executionId,'--attempt',first.id,'--name','observations.jsonl');expect(old.content).toBe(artifact.content);
    }
  } finally {if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}}
},20000);

test('CLI preserves both PR sources separately from a controlled insufficient-evidence report',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'orch-pr-pair-'));dirs.push(dir);
  const repo=join(dir,'repo');const data=join(dir,'data');const configuration=join(dir,'config');
  const {mkdir}=await import('node:fs/promises');await mkdir(repo);await mkdir(data);await mkdir(configuration);
  const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
  git('init');await writeFile(join(repo,'code.txt'),'fixed');git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','fixture');const sha=git('rev-parse','HEAD');
  const evidence=join(configuration,'snapshot.json');
  await writeFile(evidence,JSON.stringify({version:'pair-v1',collectedAt:'2026-10-10T12:00:00Z',pullRequests:[
    {repo:'owner/repo',number:3,url:'https://github.com/owner/repo/pull/3',updatedAt:'2026-10-10T11:00:00Z',headSha:'a'.repeat(40),body:'Validation absent in PR 3',reviews:[],diff:'validation change',missing:[],truncated:false},
    {repo:'owner/repo',number:4,url:'https://github.com/owner/repo/pull/4',updatedAt:'2026-10-10T11:30:00Z',headSha:'b'.repeat(40),body:'PR 4 evidence incomplete',reviews:[],diff:'',missing:['diff','review threads'],truncated:true},
  ]}));
  const report='Controlled report: PR 3 has a validation observation. PR 4 is truncated and lacks diff/review threads; insufficient evidence for a recurring problem. Sources: https://github.com/owner/repo/pull/3 and https://github.com/owner/repo/pull/4. Scope: administrator snapshot pair-v1 only; not verified live GitHub.';
  const docker=join(dir,'docker');
  await writeFile(docker,`#!/usr/bin/env node
const fs=require('node:fs');const cp=require('node:child_process');const args=process.argv.slice(2);const state=${JSON.stringify(join(dir,'mount'))};
if(args[0]==='run'){fs.writeFileSync(state,args.find(a=>a.includes('dst=/orchestrator-tools,')).match(/src=([^,]+)/)[1]);console.log('controlled');}
else if(args[0]==='exec'){const text=args.at(-1);if(text.includes('ORCH_EXIT_')){const mount=fs.readFileSync(state,'utf8');for(const number of [3,4])cp.execFileSync(process.execPath,[mount+'/call.mjs','pr-snapshot',JSON.stringify({number})],{env:{ORCHESTRATOR_TOOL_SOCKET:mount+'/tools.sock'},encoding:'utf8'});console.log(${JSON.stringify(report)});console.log(text.match(/ORCH_EXIT_[a-f0-9]+/)[0]+':0');}else if(text.includes('rev-parse'))console.log(${JSON.stringify(sha)});}
`,{mode:0o700});
  const config=join(configuration,'config.ts');
  await writeFile(config,`import {createPrSnapshotTool,createPrAnalysisRole} from ${JSON.stringify(join(root,'src/pr-analysis.ts'))};export default {version:'pair-config',repos:[{id:'sample',location:${JSON.stringify(repo)}}],environments:[{id:'readonly',docker:{image:'controlled:image',binary:${JSON.stringify(docker)}}}],capabilities:[],tools:[createPrSnapshotTool({path:${JSON.stringify(evidence)},repo:'owner/repo',pullRequests:[3,4]})],roles:[createPrAnalysisRole({repo:'owner/repo',pullRequests:[3,4]})],providers:[{id:'controlled',agent:{name:'controlled',env:{},captureSessions:false,buildPrintCommand(){return {command:'controlled-agent'}},parseStreamLine(line){return [{type:'result',result:line}]}}}],roleBindings:[{role:'pr-analysis',provider:'controlled',environment:'readonly',commit(){return '${sha}'}}]}`);
  const child=spawn(process.execPath,['--import','tsx','src/cli.ts','serve','--config',config,'--data',data],{cwd:root});
  try {
    await new Promise<void>((resolve,reject)=>{let out='';let err='';const timer=setTimeout(()=>reject(Error(err||'not ready')),10000);child.stdout.on('data',d=>{out+=d;if(out.includes('ready')){clearTimeout(timer);resolve();}});child.stderr.on('data',d=>err+=d);child.once('exit',()=>{clearTimeout(timer);reject(Error(err));});});
    const socket=join(data,'control.sock');
    const cli=(...args:string[])=>JSON.parse(execFileSync(process.execPath,['--import','tsx','src/cli.ts',...args,'--socket',socket],{cwd:root,encoding:'utf8'}));
    const receipt=cli('submit','--repo','sample','--capability','pr-analysis','--source','test','--input',JSON.stringify({sha,pullRequests:[3,4]}));
    const {call}=await import('../src/control.js');
    await expect.poll(async()=>(await call(socket,{command:'show',id:receipt.executionId}) as any).execution.status,{timeout:10000}).toBe('completed');
    const detail=cli('show',receipt.executionId);const attempt=detail.attempts[0];
    expect(detail.request.input).toEqual({sha,pullRequests:[3,4]});
    expect(attempt).toMatchObject({actualSha:sha,contract:'valid',business:report});
    const raw=cli('artifact',receipt.executionId,'--name','report.txt');expect(Buffer.from(raw.content,'base64').toString()).toBe(report);
    const artifact=cli('artifact',receipt.executionId,'--name','observations.jsonl');
    const observations=Buffer.from(artifact.content,'base64').toString().trimEnd().split('\n').map(line=>JSON.parse(line));
    expect(observations).toHaveLength(2);
    expect(observations.map(observation=>({attemptId:observation.attemptId,actualSha:observation.actualSha,input:observation.input,source:observation.result.source,pullRequest:observation.result.pullRequest}))).toEqual([
      {attemptId:attempt.id,actualSha:sha,input:{number:3},source:expect.objectContaining({kind:'administrator-snapshot',version:'pair-v1',collectedAt:'2026-10-10T12:00:00Z',verifiedAgainstGitHub:false}),pullRequest:expect.objectContaining({number:3,url:'https://github.com/owner/repo/pull/3',headSha:'a'.repeat(40),body:'Validation absent in PR 3',missing:[],truncated:false})},
      {attemptId:attempt.id,actualSha:sha,input:{number:4},source:expect.objectContaining({kind:'administrator-snapshot',version:'pair-v1',collectedAt:'2026-10-10T12:00:00Z',verifiedAgainstGitHub:false}),pullRequest:expect.objectContaining({number:4,url:'https://github.com/owner/repo/pull/4',headSha:'b'.repeat(40),body:'PR 4 evidence incomplete',diff:'',missing:['diff','review threads'],truncated:true})},
    ]);
    expect(observations[0].result.source.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(observations[1].result.source.contentSha256).toBe(observations[0].result.source.contentSha256);
  } finally {if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}}
},20000);
