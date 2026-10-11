import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { afterEach, expect, test } from 'vitest';
import { call } from '../src/control.js';
const root=resolve(import.meta.dirname,'..');
const dirs:string[]=[];const children:ChildProcess[]=[];
async function temporary(){const dir=await mkdtemp(join(tmpdir(),'orch-cleanup-'));dirs.push(dir);return dir}
async function cli(socket:string,args:string[]){const child=spawn(process.execPath,['--import','tsx','src/cli.ts',...args,'--socket',socket],{cwd:root});let out='';let err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);const [code]=await once(child,'exit');expect(code,err).toBe(0);return JSON.parse(out)}
async function fixture(){
 const data=await temporary();const configDir=await temporary();const config=join(configDir,'config.ts');
 await writeFile(config,`export default {version:'v1',repos:[{id:'alpha',location:'/test/alpha'}],environments:[{id:'test'}],capabilities:[{id:'test',environment:'test',validate(){},async run(){throw Error('must not run')}}]}`);
 // Historical records are fixture inputs, never written behind a running control service.
 const db=new DatabaseSync(join(data,'records.sqlite'));
 db.exec(`CREATE TABLE requests(id TEXT PRIMARY KEY,repo TEXT,capability TEXT,input TEXT,source TEXT,created_at TEXT,rejection TEXT);CREATE TABLE executions(id TEXT PRIMARY KEY,request_id TEXT,status TEXT);CREATE TABLE attempts(id TEXT PRIMARY KEY,execution_id TEXT,config_version TEXT,capability TEXT,environment TEXT,run_state TEXT,facts TEXT);`);
 db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?,?)').run('request','alpha','test','"sha"','manual','2026-01-01T00:00:00Z',null);
 db.prepare('INSERT INTO executions VALUES(?,?,?)').run('execution','request','completed');
 db.prepare('INSERT INTO attempts VALUES(?,?,?,?,?,?,?)').run('attempt','execution','v1','test','test','completed',JSON.stringify({endedAt:'2026-01-01T00:00:00Z',actualSha:'sha',logs:{complete:true},artifacts:[{name:'report.txt'}],sessionId:'provider-session',externalReferences:['https://example.invalid/pr/1']}));db.close();
 const directory=join(data,'attempts','attempt');await mkdir(join(directory,'artifacts'),{recursive:true});
 for(const name of ['stdout.log','stderr.log','artifacts/report.txt','provider.log'])await writeFile(join(directory,name),name);
 await mkdir(join(directory,'workspace'));await writeFile(join(directory,'workspace','keep'),'checkout');
 const launcher=join(configDir,'serve.mts');await writeFile(launcher,`const RealDate=Date;globalThis.Date=class extends RealDate {constructor(...args){super(...(args.length?args:['2026-01-31T00:00:00Z']))}static now(){return new RealDate('2026-01-31T00:00:00Z').getTime()}};const {serve}=await import(${JSON.stringify(join(root,'src/control.ts'))});await serve(${JSON.stringify(data)},${JSON.stringify(config)});`);
 return {data,directory,launcher,socket:join(data,'control.sock')};
}
async function start(f:Awaited<ReturnType<typeof fixture>>){const child=spawn(process.execPath,['--import','tsx',f.launcher],{cwd:root});children.push(child);await new Promise<void>((resolve,reject)=>{let out='';let err='';const timer=setTimeout(()=>reject(Error(err||'not ready')),10000);child.stderr.on('data',d=>err+=d);child.stdout.on('data',d=>{out+=d;if(out.includes('ready')){clearTimeout(timer);resolve()}});child.once('exit',()=>{clearTimeout(timer);reject(Error(err))})});return child}
afterEach(async()=>{await Promise.all(children.splice(0).map(async c=>{if(c.exitCode===null&&c.signalCode===null){const exit=once(c,'exit');c.kill('SIGTERM');await exit}}));await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})))});
test('external CLI cleanup at thirty days retains history and provider resources and reports cleaned content',async()=>{
 const f=await fixture();await start(f);
 expect(await cli(f.socket,['cleanup'])).toMatchObject({attempts:[{attemptId:'attempt',status:'cleaned'}]});
 await expect(readFile(join(f.directory,'stdout.log'))).rejects.toMatchObject({code:'ENOENT'});await expect(readFile(join(f.directory,'artifacts/report.txt'))).rejects.toMatchObject({code:'ENOENT'});
 expect(await readFile(join(f.directory,'provider.log'),'utf8')).toBe('provider.log');expect(await readFile(join(f.directory,'workspace/keep'),'utf8')).toBe('checkout');
 const detail=await cli(f.socket,['show','execution']);expect(detail.attempts[0]).toMatchObject({sessionId:'provider-session',externalReferences:['https://example.invalid/pr/1'],cleanup:{status:'cleaned'},logs:{complete:false}});
 expect(await cli(f.socket,['logs','execution'])).toMatchObject({availability:'cleaned',complete:false});expect(await cli(f.socket,['artifact','execution','--name','report.txt'])).toMatchObject({availability:'cleaned',content:null});
 expect(await cli(f.socket,['cleanup'])).toMatchObject({attempts:[{attemptId:'attempt',status:'cleaned'}]});
});

async function historical(f:Awaited<ReturnType<typeof fixture>>,state:string,facts:Record<string,unknown>={}) {
 const db=new DatabaseSync(join(f.data,'records.sqlite'));
 const old=JSON.parse(String(db.prepare('SELECT facts FROM attempts').get()!.facts));
 db.prepare('UPDATE attempts SET run_state=?, facts=?').run(state,JSON.stringify({...old,...facts}));db.prepare('UPDATE executions SET status=?').run(state);db.close();
}

test('CLI cancellation of an ended start_failed attempt preserves audit without blocking thirty-day cleanup',async()=>{
 const f=await fixture();await historical(f,'start_failed');await start(f);
 const cancelled=await cli(f.socket,['cancel','execution','--reason','retire failed launch']);
 expect(cancelled).toMatchObject({execution:{status:'start_failed',cancellation:{reason:'retire failed launch'}},attempts:[{runState:'start_failed',endedAt:'2026-01-01T00:00:00Z',cancellation:{reason:'retire failed launch'}}]});
 expect(cancelled.attempts[0].stopConfirmation).toBeUndefined();
 expect(await cli(f.socket,['cleanup'])).toMatchObject({attempts:[{attemptId:'attempt',status:'cleaned'}]});
 expect(await cli(f.socket,['logs','execution'])).toMatchObject({availability:'cleaned',complete:false});
 expect(await cli(f.socket,['show','execution'])).toMatchObject({attempts:[{runState:'start_failed',cancellation:{reason:'retire failed launch'},cleanup:{status:'cleaned'}}]});
});

test('CLI cleanup includes a cancelled-intent start_failed history after a completed retry ages thirty days',async()=>{
 const f=await fixture();await historical(f,'start_failed',{cancellation:{reason:'retire failed launch',requestedAt:'2025-12-31T00:00:00Z'}});
 const db=new DatabaseSync(join(f.data,'records.sqlite'));
 db.prepare('INSERT INTO attempts VALUES(?,?,?,?,?,?,?)').run('retry-attempt','execution','v1','test','test','completed',JSON.stringify({endedAt:'2026-01-01T00:00:00Z',actualSha:'sha',logs:{complete:true}}));
 db.prepare('UPDATE executions SET status=?').run('completed');db.close();
 await start(f);
 expect(await cli(f.socket,['cleanup'])).toEqual({attempts:[{attemptId:'attempt',status:'cleaned'},{attemptId:'retry-attempt',status:'cleaned'}]});
 expect(await cli(f.socket,['show','execution'])).toMatchObject({execution:{status:'completed'},attempts:[{runState:'start_failed',cancellation:{reason:'retire failed launch'},cleanup:{status:'cleaned'}},{runState:'completed',cleanup:{status:'cleaned'}}]});
});

test.each([
 ['not thirty days','completed',{endedAt:'2026-01-01T00:00:00.001Z'}],
 ['missing end time','completed',{endedAt:null}],
 ['unknown end time','completed',{endedAt:'not-a-date'}],
 ['active','running',{}],
 ['unresolved','unknown',{}],
 ['stop unconfirmed','cancelled',{cancellation:{reason:'cancel'}}],
 ['still needs reconciliation','unknown',{stopConfirmation:{kind:'manual'}}],
 ['requires attention','completed',{requiresAttention:true}],
] as const)('cleanup preserves evidence when %s',async(_label,state,facts)=>{
 const f=await fixture();await historical(f,state,{...facts});await start(f);
 expect(await cli(f.socket,['cleanup'])).toEqual({attempts:[]});
 expect(await readFile(join(f.directory,'stdout.log'),'utf8')).toBe('stdout.log');expect(await readFile(join(f.directory,'artifacts/report.txt'),'utf8')).toBe('artifacts/report.txt');
});

test('unsafe file cleanup fails visibly without following symlinks and can be retried',async()=>{
 const f=await fixture();const outside=await temporary();const target=join(outside,'tool.log');await writeFile(target,'provider evidence');
 await rm(join(f.directory,'stdout.log'));await symlink(target,join(f.directory,'stdout.log'));await start(f);
 expect(await cli(f.socket,['cleanup'])).toMatchObject({attempts:[{status:'failed'}]});
 expect(await cli(f.socket,['logs','execution'])).toMatchObject({availability:'failed',complete:false});expect(await readFile(target,'utf8')).toBe('provider evidence');
 await rm(join(f.directory,'stdout.log'));await writeFile(join(f.directory,'stdout.log'),'owned');
 expect(await cli(f.socket,['cleanup'])).toMatchObject({attempts:[{status:'cleaned'}]});
});

test('interrupted cleanup remains unknown and query never promises evidence',async()=>{
 const f=await fixture();await historical(f,'completed',{cleanup:{status:'unknown',startedAt:'2026-01-30T00:00:00Z'}});await rm(join(f.directory,'stdout.log'));await start(f);
 expect(await cli(f.socket,['logs','execution'])).toMatchObject({availability:'unknown',complete:false});
 expect(await cli(f.socket,['show','execution'])).toMatchObject({attempts:[{cleanup:{status:'unknown'}}]});
 expect(await cli(f.socket,['cleanup'])).toMatchObject({attempts:[{status:'cleaned'}]});
});

test('concurrent recovery wins safely or follows cleanup without deleting newly unresolved evidence',async()=>{
 const f=await fixture();await historical(f,'unknown',{stopConfirmation:{kind:'manual'}});await start(f);
 await Promise.all([
  call(f.socket,{command:'cleanup'}),
  call(f.socket,{command:'resolve',id:'execution',source:'admin',handling:'checked',reason:'stopped',externalResults:'no external writes'}),
 ]);
 expect(await readFile(join(f.directory,'stdout.log'),'utf8')).toBe('stdout.log');
 expect(await cli(f.socket,['cleanup'])).toEqual({attempts:[]});
});


test.each(['attempts','attempt','artifacts'])('cleanup refuses a symlinked %s directory',async(level)=>{
 const f=await fixture();const outside=await temporary();await writeFile(join(outside,'stdout.log'),'tool logs');await writeFile(join(outside,'report.txt'),'tool artifact');
 const path=level==='attempts'?join(f.data,'attempts'):level==='attempt'?f.directory:join(f.directory,'artifacts');
 await rm(path,{recursive:true});await symlink(outside,path);await start(f);
 expect(await cli(f.socket,['cleanup'])).toMatchObject({attempts:[{status:'failed'}]});
 expect(await readFile(join(outside,'stdout.log'),'utf8')).toBe('tool logs');expect(await readFile(join(outside,'report.txt'),'utf8')).toBe('tool artifact');
});

test('required cleanup intent save failure prevents any deletion',async()=>{
 const f=await fixture();const db=new DatabaseSync(join(f.data,'records.sqlite'));db.exec(`CREATE TRIGGER cleanup_save_failure BEFORE UPDATE ON attempts BEGIN SELECT RAISE(ABORT,'cleanup save failed'); END;`);db.close();await start(f);
 await expect(call(f.socket,{command:'cleanup'})).rejects.toThrow('cleanup save failed');
 expect(await readFile(join(f.directory,'stdout.log'),'utf8')).toBe('stdout.log');expect(await readFile(join(f.directory,'artifacts/report.txt'),'utf8')).toBe('artifacts/report.txt');
});

test('required final cleanup save failure preserves queryable unknown instead of claiming success',async()=>{
 const f=await fixture();const db=new DatabaseSync(join(f.data,'records.sqlite'));db.exec(`CREATE TRIGGER cleanup_finish_failure BEFORE UPDATE ON attempts WHEN json_extract(NEW.facts,'$.cleanup.status')='cleaned' BEGIN SELECT RAISE(ABORT,'cleanup finish save failed'); END;`);db.close();await start(f);
 await expect(call(f.socket,{command:'cleanup'})).rejects.toThrow('cleanup finish save failed');
 expect(await cli(f.socket,['logs','execution'])).toMatchObject({availability:'unknown',complete:false});
});

test('concurrent reads and repeated cleanup never claim removed evidence is complete',async()=>{
 const f=await fixture();await start(f);
 const results=await Promise.all([call(f.socket,{command:'logs',id:'execution'}),call(f.socket,{command:'cleanup'}),call(f.socket,{command:'cleanup'})]) as any[];
 expect(results[1]).toMatchObject({attempts:[{status:'cleaned'}]});expect(results[2]).toMatchObject({attempts:[{status:'cleaned'}]});
 expect(await cli(f.socket,['logs','execution'])).toMatchObject({availability:'cleaned',complete:false});
});

test('role context snapshots are disposable while provider checkout and unregistered tool artifacts remain',async()=>{
 const f=await fixture();await historical(f,'completed',{kind:'agent'});await mkdir(join(f.directory,'context','nested'),{recursive:true});await writeFile(join(f.directory,'context','nested','code.ts'),'snapshot');await writeFile(join(f.directory,'artifacts','tool.log'),'tool evidence');await mkdir(join(f.directory,'repo'));await writeFile(join(f.directory,'repo','session'),'provider session');await start(f);
 expect(await cli(f.socket,['cleanup'])).toMatchObject({attempts:[{status:'cleaned'}]});
 await expect(readFile(join(f.directory,'context','nested','code.ts'))).rejects.toMatchObject({code:'ENOENT'});
 expect(await readFile(join(f.directory,'repo','session'),'utf8')).toBe('provider session');expect(await readFile(join(f.directory,'artifacts','tool.log'),'utf8')).toBe('tool evidence');
});

test('context snapshot symlinks never delete tool resources',async()=>{
 const f=await fixture();await historical(f,'completed',{kind:'agent'});const outside=await temporary();await writeFile(join(outside,'session'),'tool session');await mkdir(join(f.directory,'context'));await symlink(outside,join(f.directory,'context','tool'));await start(f);
 expect(await cli(f.socket,['cleanup'])).toMatchObject({attempts:[{status:'failed'}]});expect(await readFile(join(outside,'session'),'utf8')).toBe('tool session');
});

test('unknown cleanup never leaves historical logs marked complete',async()=>{
 const f=await fixture();await historical(f,'completed',{cleanup:{status:'unknown'}});await start(f);
 expect(await cli(f.socket,['show','execution'])).toMatchObject({attempts:[{logs:{complete:false}}]});
});

test('missing registered content is explicitly unavailable without claiming complete evidence',async()=>{
 const f=await fixture();await rm(join(f.directory,'artifacts/report.txt'));await start(f);
 expect(await cli(f.socket,['artifact','execution','--name','report.txt'])).toMatchObject({availability:'unavailable',content:null});
 await rm(join(f.directory,'stderr.log'));
 expect(await cli(f.socket,['logs','execution'])).toMatchObject({availability:'unavailable',complete:false});
});
