import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { afterEach, expect, test } from 'vitest';
import { call } from '../src/control.js';

const root = resolve(import.meta.dirname, '..');
let service: ChildProcess | undefined;
let directory: string | undefined;
afterEach(async () => {
  if (service && service.exitCode === null && service.signalCode === null) {
    const exited = once(service, 'exit'); service.kill('SIGTERM'); await exited;
  }
  if (directory) await rm(directory, {recursive:true,force:true});
});

test('socket source and key lookup returns rejected and accepted requests in record order without changing show by id', async () => {
  directory = await mkdtemp(join(tmpdir(), 'orch-record-query-'));
  const data = join(directory, 'data');
  await mkdir(join(directory,'config'));
  const config = join(directory, 'config', 'config.ts');
  await writeFile(config, `export default {version:'query-test',repos:[{id:'alpha',location:'/test/alpha'}],environments:[{id:'test'}],capabilities:[{id:'check',environment:'test',validate(input){if(input !== 'valid')throw Error('Invalid input')},run(){throw Error('Must not execute')}}]}`);
  service = spawn(process.execPath, ['--import','tsx','src/cli.ts','serve','--data',data,'--config',config], {cwd:root});
  let errors = '';
  service.stderr!.on('data', chunk => { errors += chunk; });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Service did not start')), 10000);
    service!.stdout!.on('data', chunk => {if(String(chunk).includes('ready')){clearTimeout(timer);resolve()}});
    service!.once('exit', code => {clearTimeout(timer);reject(Error(`Service exited ${code}: ${errors}`))});
  });
  const socket = join(data,'control.sock');
  const submit = (input:string) => call(socket,{command:'submit',submission:{repo:'alpha',capability:'check',source:'webhook',deduplicationKey:'delivery-1',input}}) as Promise<any>;
  const rejected = await submit('invalid');
  const accepted = await submit('valid');
  const only = await call(socket,{command:'show',source:'webhook',deduplicationKey:'delivery-1'}) as any[];
  expect(Array.isArray(only)).toBe(true); expect(only).toHaveLength(2);
  const secondKey = await call(socket,{command:'submit',submission:{repo:'alpha',capability:'check',source:'webhook',deduplicationKey:'single',input:'valid'}}) as any;
  const singleMatch = await call(socket,{command:'show',source:'webhook',deduplicationKey:'single'}) as any[];
  expect(singleMatch).toHaveLength(1); expect(singleMatch[0]).toMatchObject({accepted:true,execution:{id:secondKey.executionId}});
  const result = await call(socket,{command:'show',source:'webhook',deduplicationKey:'delivery-1'}) as any[];
  expect(result).toMatchObject([
    {accepted:false,request:{id:rejected.requestId,rejection:'Invalid input'},execution:null,attempts:[]},
    {accepted:true,request:{id:accepted.requestId,rejection:null},execution:{id:accepted.executionId,status:'queued'},attempts:[]},
  ]);
  expect(result).toHaveLength(2);
  const byId = await call(socket,{command:'show',id:accepted.requestId});
  expect(Object.keys(byId as object)).toEqual(['request','execution','attempts']);
  expect(await call(socket,{command:'show',source:'absent',deduplicationKey:'delivery-1'})).toEqual([]);
  await expect(call(socket,{command:'show',id:accepted.requestId,source:'webhook',deduplicationKey:'delivery-1'})).rejects.toThrow('mutually exclusive');
  const exited = once(service,'exit'); service.kill('SIGTERM'); await exited;
  const before = await readFile(join(data,'records.sqlite'));
  const offline = await cli(['show','--source','webhook','--deduplication-key','delivery-1','--offline','--data',data]);
  expect(offline.code,offline.stderr).toBe(0);
  expect(JSON.parse(offline.stdout)).toEqual(result);
  const single = await cli(['show','--source','webhook','--deduplication-key','absent','--offline','--data',data]);
  expect(JSON.parse(single.stdout)).toEqual([]);
  const listed = await cli(['list','--repo','alpha','--status','queued','--source','webhook','--offline','--data',data]);
  expect(listed.code,listed.stderr).toBe(0);
  expect(JSON.parse(listed.stdout).map((r:any) => r.execution.id)).toEqual([accepted.executionId,secondKey.executionId]);
  expect(await readFile(join(data,'records.sqlite'))).toEqual(before);
});


test('offline CLI reads existing records without initialization or projecting persisted running state to unknown', async () => {
  directory = await mkdtemp(join(tmpdir(), 'orch-offline-record-'));
  const { DatabaseSync } = await import('node:sqlite');
  const path = join(directory,'records.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE requests(id TEXT,repo TEXT,capability TEXT,input TEXT,source TEXT,created_at TEXT,rejection TEXT);
    CREATE TABLE executions(id TEXT,request_id TEXT,status TEXT);
    CREATE TABLE attempts(id TEXT,execution_id TEXT,config_version TEXT,capability TEXT,environment TEXT,run_state TEXT,facts TEXT);
    CREATE TABLE submission_metadata(request_id TEXT,scheduled_at TEXT,deduplication_key TEXT);
    CREATE TABLE execution_management(execution_id TEXT,facts TEXT);
    INSERT INTO requests VALUES ('request-1','alpha','check','null','webhook','2026-10-01',NULL);
    INSERT INTO executions VALUES ('execution-1','request-1','running');
    INSERT INTO attempts VALUES ('attempt-1','execution-1','v1','check','test','running','{}');`);
  db.close();
  const before = await readFile(path);
  const child = spawn(process.execPath,['--import','tsx','src/cli.ts','show','request-1','--offline','--data',directory],{cwd:root});
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => {stdout += chunk}); child.stderr.on('data', chunk => {stderr += chunk});
  const [code] = await once(child,'exit');
  expect(code,stderr).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({execution:{status:'running'},attempts:[{runState:'running',activityVerified:false}]});
  expect(await readFile(path)).toEqual(before);
  expect(await readdir(directory)).toEqual(['records.sqlite']);
  const logs = spawn(process.execPath,['--import','tsx','src/cli.ts','logs','execution-1','--offline','--data',directory],{cwd:root});
  let logOutput = ''; let logError = '';
  logs.stdout.on('data', chunk => {logOutput += chunk}); logs.stderr.on('data', chunk => {logError += chunk});
  const [logCode] = await once(logs,'exit');
  expect(logCode,logError).toBe(0);
  expect(JSON.parse(logOutput)).toMatchObject({attemptId:'attempt-1',availability:'unavailable',stdout:null,stderr:null,truncated:{stdout:false,stderr:false},complete:false});
  expect(await readFile(path)).toEqual(before);
  expect(await readdir(directory)).toEqual(['records.sqlite']);
  const human = await cli(['show','execution-1','--offline','--human','--data',directory]);
  expect(human.code,human.stderr).toBe(0);
  expect(human.stdout).toContain('persisted evidence only');
  expect(human.stdout).toContain('Activity: unverified (persisted running)');
  expect(human.stdout).toContain("show 'execution-1'");
  expect(human.stdout).toContain('--offline');
  expect(human.stdout).not.toContain(' serve ');
  expect(await readFile(path)).toEqual(before);
  expect(await readdir(directory)).toEqual(['records.sqlite']);
});

async function cli(args: string[]) {
  const child = spawn(process.execPath,['--import','tsx','src/cli.ts',...args],{cwd:root});
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  const [code] = await once(child,'exit');
  return {code,stdout,stderr};
}

test('offline failures preserve missing, incompatible and WAL records without executing a configuration', async () => {
  directory = await mkdtemp(join(tmpdir(), 'orch-offline-protection-'));
  const missing = join(directory,'not-created');
  const config = join(directory,'config.ts');
  await writeFile(config, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(directory,'executed'))},'bad'); throw Error('Config must not execute');`);
  const run = () => cli(['list','--offline','--data',directory!,'--config',config]);
  const absent = await cli(['list','--offline','--data',missing,'--config',config]);
  expect(absent.code).toBe(1); expect(absent.stderr).toContain(join(missing,'records.sqlite'));
  await expect(stat(missing)).rejects.toMatchObject({code:'ENOENT'});
  const {DatabaseSync} = await import('node:sqlite');
  const path = join(directory,'records.sqlite');
  const db = new DatabaseSync(path); db.exec('CREATE TABLE unrelated(value TEXT)'); db.close();
  const before = await readFile(path); const files = await readdir(directory);
  const unsupported = await run();
  expect(unsupported.code).toBe(1); expect(unsupported.stderr).toContain('Unsupported records structure');
  expect(unsupported.stderr).not.toMatch(/corrupt|损坏/i);
  expect(await readFile(path)).toEqual(before); expect(await readdir(directory)).toEqual(files);
  const wal = new DatabaseSync(path); wal.exec('PRAGMA journal_mode=WAL; INSERT INTO unrelated VALUES (\'evidence\')');
  try {
    const names = await readdir(directory);
    const snapshots = await Promise.all(names.map(async name => [name,await readFile(join(directory!,name))] as const));
    const result = await run();
    expect(result.code).toBe(1); expect(result.stderr).toContain('Unsupported offline records journal');
    expect(await readdir(directory)).toEqual(names);
    for (const [name,bytes] of snapshots) expect(await readFile(join(directory,name))).toEqual(bytes);
  } finally {wal.close()}
  expect(await readdir(directory)).not.toContain('executed');
});
