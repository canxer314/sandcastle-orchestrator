import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const root=resolve(import.meta.dirname,'..');
test('tool socket preserves prior evidence and independently readable later evidence after a partial append',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'orch-partial-'));
  try {
    const script=join(dir,'partial.mts');
    await writeFile(script,`import {serveRoleTools} from ${JSON.stringify(join(root,'src/role-tools.ts'))};
import {readFile} from 'node:fs/promises';import {request} from 'node:http';import {execFileSync} from 'node:child_process';
process.on('SIGXFSZ',()=>{});
let sticky='';const server=await serveRoleTools(${JSON.stringify(join(dir,'tools'))},[{id:'read',description:'Controlled evidence',async read(input){return input==='failed'?'A'.repeat(8192):input+' evidence';}}],'attempt','a'.repeat(40),error=>sticky=error);
const invoke=input=>new Promise((resolve,reject)=>{const req=request({socketPath:${JSON.stringify(join(dir,'tools/tools.sock'))},method:'POST'},res=>{let body='';res.setEncoding('utf8');res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,value:JSON.parse(body)}));});req.on('error',reject);req.end(JSON.stringify({tool:'read',input}));});
try {
 const prior=await invoke('prior');let failed;
 try {execFileSync('prlimit',['--pid',String(process.pid),'--fsize=1024:unlimited']);failed=await invoke('failed');}
 finally {execFileSync('prlimit',['--pid',String(process.pid),'--fsize=unlimited:unlimited']);}
 const later=await invoke('later');await server.close();
 console.log(JSON.stringify({prior,failed,later,sticky,artifact:await readFile(${JSON.stringify(join(dir,'artifacts/observations.jsonl'))},'utf8')}));
} finally {await server.close();}
`);
    const result=JSON.parse(execFileSync(process.execPath,['--import','tsx',script],{cwd:root,encoding:'utf8',timeout:10000}));
    expect(result.prior).toEqual({status:200,value:'prior evidence'});
    expect(result.failed).toEqual({status:400,value:{error:'Tool observation could not be saved; result not delivered'}});
    expect(result.later).toEqual({status:200,value:'later evidence'});
    expect(result.sticky).toBe('Tool observation could not be saved; result not delivered');
    const observations=result.artifact.trimEnd().split('\n').map((line:string)=>JSON.parse(line));
    expect(observations.map((observation:any)=>({input:observation.input,result:observation.result}))).toEqual([{input:'prior',result:'prior evidence'},{input:'later',result:'later evidence'}]);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('tool socket refuses later result delivery when a partial append cannot be rolled back',async context=>{
  if(process.platform!=='linux' || spawnSync('strace',['-e','inject=ftruncate:error=EIO','true'],{stdio:'ignore'}).status!==0) {
    context.skip(true,'Requires Linux strace syscall injection');return;
  }
  const dir=await mkdtemp(join(tmpdir(),'orch-rollback-failed-'));
  try {
    const script=join(dir,'rollback.mts');const trace=join(dir,'syscalls.log');
    await writeFile(script,`import {serveRoleTools} from ${JSON.stringify(join(root,'src/role-tools.ts'))};
import {readFile} from 'node:fs/promises';import {request} from 'node:http';import {execFileSync} from 'node:child_process';
process.on('SIGXFSZ',()=>{});
const errors=[];const server=await serveRoleTools(${JSON.stringify(join(dir,'tools'))},[{id:'read',description:'Controlled evidence',async read(input){return input==='failed'?'A'.repeat(8192):input+' evidence';}}],'attempt','a'.repeat(40),error=>errors.push(error));
const invoke=input=>new Promise((resolve,reject)=>{const req=request({socketPath:${JSON.stringify(join(dir,'tools/tools.sock'))},method:'POST'},res=>{let body='';res.setEncoding('utf8');res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,value:JSON.parse(body)}));});req.on('error',reject);req.end(JSON.stringify({tool:'read',input}));});
try {
 const prior=await invoke('prior');let failed;
 try {execFileSync('prlimit',['--pid',String(process.pid),'--fsize=1024:unlimited']);failed=await invoke('failed');}
 finally {execFileSync('prlimit',['--pid',String(process.pid),'--fsize=unlimited:unlimited']);}
 const before=await readFile(${JSON.stringify(join(dir,'artifacts/observations.jsonl'))},'utf8');
 const later=await invoke('later');await server.close();
 console.log(JSON.stringify({prior,failed,later,errors,before,after:await readFile(${JSON.stringify(join(dir,'artifacts/observations.jsonl'))},'utf8')}));
} finally {await server.close();}
`);
    const result=JSON.parse(execFileSync('strace',['-f','-o',trace,'-e','trace=ftruncate','-e','inject=ftruncate:error=EIO',process.execPath,'--import','tsx',script],{cwd:root,encoding:'utf8',timeout:10000}));
    expect(await readFile(trace,'utf8')).toMatch(/ftruncate\([^\n]+EIO[^\n]+INJECTED/);
    expect(result.prior).toEqual({status:200,value:'prior evidence'});
    const failure={status:400,value:{error:'Tool observation could not be saved; result not delivered'}};
    expect(result.failed).toEqual(failure);
    expect(result.later).toEqual(failure);
    expect(result.errors).toEqual([failure.value.error,failure.value.error]);
    expect(Buffer.byteLength(result.before)).toBe(1024);
    expect(result.after).toBe(result.before);
    expect(JSON.parse(result.after.split('\n')[0])).toMatchObject({input:'prior',result:'prior evidence'});
  } finally {await rm(dir,{recursive:true,force:true});}
});
