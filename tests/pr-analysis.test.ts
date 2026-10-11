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

test.each(['normal','large','denied','tool-failure','save-failure','scope-change','report-save-failure','business-save-failure','unicode'])('role invokes its authorized readonly tool and CLI separates observed facts from %s model report',async mode=>{
  const dir=await mkdtemp(join(tmpdir(),'orch-pr-run-'));dirs.push(dir);
  const repo=join(dir,'repo');const data=join(dir,'data');const configuration=join(dir,'config');
  const {mkdir}=await import('node:fs/promises');for(const path of [repo,data,configuration])await mkdir(path);
  const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();git('init');await writeFile(join(repo,'code.txt'),'fixed');git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','fixture');const sha=git('rev-parse','HEAD');
  if(mode==='unicode')await writeFile(join(dir,'unicode.mjs'),`import {request,createServer} from 'node:http';import {spawn} from 'node:child_process';
const mount=process.argv[2];
const observed=await new Promise((resolve,reject)=>{const req=request({socketPath:mount+'/tools.sock',method:'POST'},res=>{res.setEncoding('utf8');let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve(JSON.parse(body)));});req.on('error',reject);const bytes=Buffer.from(JSON.stringify({tool:'unicode',input:'中文'}));const split=bytes.indexOf(Buffer.from('中'))+1;req.write(bytes.subarray(0,split));setTimeout(()=>req.end(bytes.subarray(split)),30);});
const socket=${JSON.stringify(join(dir,'unicode.sock'))};const server=createServer((req,res)=>{const bytes=Buffer.from(JSON.stringify('中文'));res.write(bytes.subarray(0,2));setTimeout(()=>res.end(bytes.subarray(2)),30);});await new Promise(resolve=>server.listen(socket,resolve));
const received=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[mount+'/call.mjs','unicode','null'],{env:{ORCHESTRATOR_TOOL_SOCKET:socket}});let out='';child.stdout.setEncoding('utf8');child.stdout.on('data',c=>out+=c);child.on('error',reject);child.on('close',()=>resolve(JSON.parse(out)));});server.close();console.log(JSON.stringify({observed,received}));`);
  const docker=join(dir,'docker');
  await writeFile(docker,`#!/usr/bin/env node
const fs=require('node:fs');const cp=require('node:child_process');const args=process.argv.slice(2);const state=${JSON.stringify(join(dir,'mount'))};
if(args[0]==='run'){const mount=args.find(a=>a.includes('dst=/orchestrator-tools,'));fs.writeFileSync(state,mount?mount.match(/src=([^,]+)/)[1]:'');${mode==='save-failure'?`if(mount){const tools=mount.match(/src=([^,]+)/)[1];fs.unlinkSync(tools+'/../artifacts/observations.jsonl');fs.mkdirSync(tools+'/../artifacts/observations.jsonl');}`:''}console.log('controlled');${['report-save-failure','business-save-failure'].includes(mode)?`if(mount){const tools=mount.match(/src=([^,]+)/)[1];fs.mkdirSync(tools+'/../artifacts/${mode==='report-save-failure'?'report.txt':'business.json'}');}`:''}}
else if(args[0]==='exec'){const text=args.at(-1);if(text.includes('ORCH_EXIT_')){const mount=fs.readFileSync(state,'utf8');try{${mode==='unicode'?`console.log(cp.execFileSync(process.execPath,[${JSON.stringify(join(dir,'unicode.mjs'))},mount],{encoding:'utf8'}).trim());`:''}const facts=JSON.parse(cp.execFileSync(process.execPath,[mount+'/call.mjs','pr-snapshot',${JSON.stringify(JSON.stringify({number:mode==='denied'?4:3}))}],{env:{ORCHESTRATOR_TOOL_SOCKET:mount+'/tools.sock'},encoding:'utf8'}));console.log('Report: '+facts.pullRequest.body+'; source administrator snapshot, missing '+facts.pullRequest.missing.join(', ')+${mode==='large'||mode==='business-save-failure'?"'x'.repeat(9*1024*1024)+' END-OF-REPORT'":"''"});}catch(e){console.log('Unable to collect authorized PR evidence');}console.log(text.match(/ORCH_EXIT_[a-f0-9]+/)[0]+':0');}else if(text.includes('rev-parse'))console.log(${JSON.stringify(sha)});}
`,{mode:0o700});
  const evidence=join(configuration,'snapshot.json');await writeFile(evidence,JSON.stringify({version:'v1',collectedAt:'2026-10-10T12:00:00Z',pullRequests:[{repo:'owner/repo',number:3,url:'https://github.com/owner/repo/pull/3',updatedAt:'2026-10-10T11:00:00Z',headSha:sha,body:'missing input validation',reviews:[],diff:'code evidence',missing:['review threads'],truncated:false}]}));
  const config=join(configuration,'config.ts');await writeFile(config,`import {createPrSnapshotTool,createPrAnalysisRole} from ${JSON.stringify(join(root,'src/pr-analysis.ts'))}; export default {version:'config-v1',repos:[{id:'sample',location:${JSON.stringify(repo)}}],environments:[{id:'readonly',docker:{image:'controlled:image',binary:${JSON.stringify(docker)}}}],capabilities:[],tools:[${mode==='unicode'?`{id:'unicode',description:'Echo observed Unicode',async read(input){return input}},`:''}createPrSnapshotTool({path:${JSON.stringify(evidence)},repo:'owner/repo',pullRequests:[3]})],roles:[${mode==='unicode'?`{...createPrAnalysisRole({repo:'owner/repo',pullRequests:[3]}),tools:['pr-snapshot','unicode']}`:`createPrAnalysisRole({repo:'owner/repo',pullRequests:[3]})`}],providers:[{id:'controlled',agent:{name:'controlled',env:{},captureSessions:false,buildPrintCommand(){return {command:'controlled-agent'}},parseStreamLine(line){return [{type:'result',result:line}]}}}],roleBindings:[{role:'pr-analysis',provider:'controlled',environment:'readonly',commit(){return '${sha}'}}]}`);
  const child=spawn(process.execPath,['--import','tsx','src/cli.ts','serve','--config',config,'--data',data],{cwd:root});
  try {
    await new Promise<void>((resolve,reject)=>{let out='';let err='';const timer=setTimeout(()=>reject(Error(err||'not ready')),10000);child.stdout.on('data',d=>{out+=d;if(out.includes('ready')){clearTimeout(timer);resolve();}});child.stderr.on('data',d=>err+=d);child.once('exit',()=>{clearTimeout(timer);reject(Error(err));});});
    if(mode==='tool-failure')await rm(evidence);
    const {call}=await import('../src/control.js');const socket=join(data,'control.sock');
    expect(await call(socket,{command:'submit',submission:{repo:'sample',capability:'pr-analysis',input:{sha,pullRequests:[4]},source:'test'}})).toMatchObject({accepted:false});
    const receipt=await call(socket,{command:'submit',submission:{repo:'sample',capability:'pr-analysis',input:{sha,pullRequests:[3]},source:'test'}}) as any;
    await expect.poll(async()=>(await call(socket,{command:'show',id:receipt.executionId}) as any).execution.status,{timeout:10000}).toBe(['report-save-failure','business-save-failure'].includes(mode)?'unknown':'completed');
    const cli=(...args:string[])=>JSON.parse(execFileSync(process.execPath,['--import','tsx','src/cli.ts',...args,'--socket',socket],{cwd:root,encoding:'utf8',maxBuffer:2*1024*1024}));
    const detail=cli('show',receipt.executionId);
    if(mode==='unicode') {
      const logs=cli('logs',receipt.executionId);expect(logs.stdout).toContain('"observed":"中文"');expect(logs.stdout).toContain('"received":"中文"');return;
    }
    if(['report-save-failure','business-save-failure'].includes(mode)) {
      expect(detail.attempts[0]).toMatchObject({exitCode:0,stopConfirmation:{kind:'agent-exit-marker',exitCode:0},reportPersistenceError:expect.any(String)});
      expect(detail.attempts[0].endedAt).toEqual(expect.any(String));expect(detail.attempts[0].contract).not.toBe('error');expect(detail.attempts[0].businessReference).toBeUndefined();
      if(mode==='report-save-failure')expect(detail.attempts[0].report).toMatchObject({missing:true,complete:false});return;
    }
    if(['denied','tool-failure','save-failure'].includes(mode)) {
      expect(detail.attempts[0].business).toBe('Unable to collect authorized PR evidence');
      if(mode==='save-failure'){expect(detail.attempts[0].toolObservationError).toContain('could not be saved');return;}
      const artifact=cli('artifact',receipt.executionId,'--name','observations.jsonl');
      const facts=JSON.parse(Buffer.from(artifact.content,'base64').toString().trim());expect(facts.error).toContain('unavailable');expect(facts.result).toBeUndefined();return;
    }
    if(mode==='large') {
      expect(detail.attempts[0].report).toMatchObject({name:'report.txt',complete:true,truncated:false});
      let offset=0;let report='';let chunk;
      do {chunk=cli('artifact',receipt.executionId,'--name','report.txt','--offset',String(offset));const bytes=Buffer.from(chunk.content,'base64');offset+=bytes.length;report+=bytes.toString();}while(!chunk.complete);
      expect(report.startsWith('Report: missing input validation')).toBe(true);expect(report.endsWith('END-OF-REPORT')).toBe(true);expect(report.length).toBeGreaterThan(9*1024*1024);
      expect(cli('logs',receipt.executionId).truncated.stdout).toBe(true);return;
    }
    expect(detail.attempts[0].business).toContain('missing input validation');
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
