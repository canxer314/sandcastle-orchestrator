import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { call } from '../src/control.js';

const root = resolve(import.meta.dirname, '..');
const directories: string[] = [];
const children: ChildProcess[] = [];
const gatesToRelease: string[] = [];
async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), 'orch-maintenance-restore-'));
  directories.push(directory);
  return directory;
}
async function start(config: string, data: string, maintenance?: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'serve', '--config', config, '--data', data, ...(maintenance ? ['--maintenance', maintenance] : [])], { cwd: root });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    let output = ''; let errors = '';
    const timer = setTimeout(() => reject(Error(errors || 'Control service not ready')), 10000);
    child.stdout!.on('data', chunk => { output += chunk; if (output.includes('"ready":true')) { clearTimeout(timer); resolve(); } });
    child.stderr!.on('data', chunk => { errors += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(Error(errors || 'Control service exited before ready')); });
  });
  return { child, socket: join(data, 'control.sock') };
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}
afterEach(async () => {
  // Let controlled adapters exit normally even if an assertion fails; never leave gate waiters behind.
  await Promise.all(gatesToRelease.splice(0).map(path => writeFile(path, 'release').catch(() => {})));
  await Promise.all(children.splice(0).map(stop));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const configDirectory = await temporary(); const data = await temporary();
  const independent = await temporary(); const repo = await temporary();
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  git('init'); await writeFile(join(repo, 'context.txt'), 'controlled local maintenance drill'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
  const sha = git('rev-parse', 'HEAD');
  const binary = join(independent, 'docker');
  // Same public Docker/provider substitutes as quota.test.ts, with real local side effects
  // outside DATA/config/backup so restoring SQLite cannot erase the independent audit.
  await writeFile(binary, `#!${process.execPath}
const fs=require('node:fs');const path=require('node:path');
const args=process.argv.slice(2);const home=${JSON.stringify(independent)};
fs.appendFileSync(path.join(home,'adapter-calls.jsonl'),JSON.stringify(args)+'\\n');
if(args[0]==='run'){console.log('controlled-container');process.exit(0)}
const command=args.at(-1)||'';const marker=command.match(/ORCH_EXIT_[a-f0-9]+/);
if(args[0]!=='exec'||!marker)process.exit(0);
const key=command.match(/CONTROLLED_KEY_([a-z-]+)/)[1];
fs.writeFileSync(path.join(home,'started-'+key),'running');
const timer=setInterval(()=>{
 if(!fs.existsSync(path.join(home,'release-'+key)))return;
 clearInterval(timer);
 const receipt=JSON.parse(fs.readFileSync(path.join(home,'receipt-'+key),'utf8'));
 const entry={key,executionId:receipt.executionId,at:new Date().toISOString(),artifact:key+'.txt'};
 fs.writeFileSync(path.join(home,key+'.txt'),'local side effect: '+key+'\\n');
 fs.appendFileSync(path.join(home,'audit.jsonl'),JSON.stringify(entry)+'\\n');
 console.log(JSON.stringify({summary:'done',key}));console.log(marker[0]+':0');
},10);
`, { mode: 0o700 });
  const config = join(configDirectory, 'config.ts');
  await writeFile(config, `export default {version:'maintenance-local-v1',primaryAgentLimit:1,
repos:[{id:'local',location:${JSON.stringify(repo)}}],capabilities:[],
environments:[{id:'env',docker:{image:'controlled:image',binary:${JSON.stringify(binary)},network:'none'}}],
providers:[{id:'controlled',agent:{name:'controlled',env:{},buildPrintCommand({prompt}){const key=prompt.match(/^fixture-key:([a-z-]+)/)[1];return {command:'CONTROLLED_KEY_'+key}},parseStreamLine(line){return [{type:'result',result:line}]}}}],
roles:[{id:'report',description:'controlled local write',validate(){},buildPrompt({input}){return 'fixture-key:'+input.key},skills:[],tools:[],validateReport(output){return JSON.parse(output)}}],
roleBindings:[{role:'report',provider:'controlled',environment:'env',commit(input){return input.sha}}]};`);
  const service = await start(config, data);
  const submit = async (socket: string, key: string) => {
    gatesToRelease.push(join(independent, 'release-'+key));
    const receipt = await call(socket, { command: 'submit', submission: { repo: 'local', capability: 'report', input: { key, sha }, source: 'maintenance-drill' } }) as { executionId: string };
    await writeFile(join(independent, 'receipt-'+key), JSON.stringify(receipt));
    return receipt.executionId;
  };
  const release = (key: string) => writeFile(join(independent, 'release-'+key), 'release');
  const audit = async () => (await readFile(join(independent, 'audit.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { key: string; executionId: string; at: string; artifact: string });
  return { ...service, config, configDirectory, data, independent, submit, release, audit };
}
const show = async (socket: string, id: string) => await call(socket, { command: 'show', id }) as any;
const manage = (socket: string, command: string, reason: string, target = 'all') => call(socket, { command, target, source: 'operator', reason });

test('old snapshot restore reconciles missing executions against independent local writes before cancelling stale queue and resuming without duplicates', async () => {
  const f = await fixture();
  const saved = await f.submit(f.socket, 'saved'); await f.release('saved');
  await expect.poll(async () => (await show(f.socket, saved)).execution.status).toBe('completed');
  await manage(f.socket, 'pause', 'prepare backup queue', 'starts');
  const stale = await f.submit(f.socket, 'stale');
  await manage(f.socket, 'pause', 'consistent offline backup');
  await stop(f.child);
  const backup = await temporary(); const restored = await temporary(); const restoredConfig = await temporary();
  const backupPoint = new Date().toISOString();
  await writeFile(join(backup, 'backup-point.txt'), backupPoint);
  execFileSync('sqlite3', [join(f.data, 'records.sqlite'), `.backup '${join(backup, 'records.sqlite')}'`]);
  expect(execFileSync('sqlite3', [join(backup, 'records.sqlite'), 'PRAGMA integrity_check;'], { encoding: 'utf8' }).trim()).toBe('ok');
  execFileSync('tar', ['--exclude=control.sock', '--exclude=control.lock', '--exclude=records.sqlite', '--exclude=records.sqlite-wal', '--exclude=records.sqlite-shm', '-C', f.data, '-cpf', join(backup, 'evidence.tar'), '.']);
  execFileSync('tar', ['-C', f.configDirectory, '-cpf', join(backup, 'config.tar'), '.']);
  await writeFile(join(backup, 'backup-completed.txt'), new Date().toISOString());

  // Continue on the original data after the backup: the old queued request writes,
  // then an entirely new execution writes. Neither result exists in the snapshot.
  const continued = await start(f.config, f.data);
  await f.release('stale');
  await manage(continued.socket, 'resume', 'continue after backup');
  await expect.poll(async () => (await show(continued.socket, stale)).execution.status).toBe('completed');
  const missing = await f.submit(continued.socket, 'missing'); await f.release('missing');
  await expect.poll(async () => (await show(continued.socket, missing)).execution.status).toBe('completed');
  await manage(continued.socket, 'pause', 'preserve post-backup incident evidence');
  await stop(continued.child);
  const beforeRestore = await f.audit();
  expect(beforeRestore.map(entry => entry.key)).toEqual(['saved', 'stale', 'missing']);

  const began = performance.now();
  await copyFile(join(backup, 'records.sqlite'), join(restored, 'records.sqlite'));
  execFileSync('tar', ['-C', restored, '-xpf', join(backup, 'evidence.tar')]);
  execFileSync('tar', ['-C', restoredConfig, '-xpf', join(backup, 'config.tar')]);
  const service = await start(join(restoredConfig, 'config.ts'), restored, 'restore');
  expect(await call(service.socket, { command: 'maintenance' })).toMatchObject({ admissionPaused: true, startsPaused: true, restorePending: true });
  expect((await show(service.socket, saved)).execution.status).toBe('completed');
  const artifact = await call(service.socket, { command: 'artifact', id: saved, name: 'report.txt' }) as any;
  expect(JSON.parse(Buffer.from(artifact.content, 'base64').toString())).toEqual({ summary: 'done', key: 'saved' });
  expect(await call(service.socket, { command: 'logs', id: saved })).toMatchObject({ availability: 'available', complete: true });
  await expect(show(service.socket, missing)).rejects.toThrow('Execution not found');
  const listed = await call(service.socket, { command: 'list' }) as any[];
  expect(listed.map(detail => detail.execution.id)).toEqual([saved, stale]);
  expect(await show(service.socket, stale)).toMatchObject({ execution: { status: 'queued' }, attempts: [] });
  await expect(manage(service.socket, 'resume', 'not yet audited')).rejects.toThrow('Restore review required');

  const independentAudit = await f.audit();
  const postBackup = independentAudit.filter(entry => entry.key !== 'saved');
  expect(postBackup.map(entry => entry.executionId)).toEqual([stale, missing]);
  for (const entry of postBackup) {
    expect(Date.parse(entry.at)).toBeGreaterThanOrEqual(Date.parse(backupPoint));
    expect(await readFile(join(f.independent, entry.artifact), 'utf8')).toBe(`local side effect: ${entry.key}\n`);
  }
  expect(independentAudit).toEqual(beforeRestore);
  await call(service.socket, { command: 'cancel', id: stale, reason: 'independent audit proves stale queued work already wrote after backup' });
  const externalResults = JSON.stringify({ localOnly: true, postBackup, missingFromSnapshot: missing, conclusion: 'both local artifacts exist; do not resubmit or retry these writes' });
  const handling = 'cancelled stale queue; missing execution reconciled from independent host audit; no replay';
  await call(service.socket, { command: 'restore-review', source: 'operator', reason: 'compared independent audit and local artifacts', backupPoint, handling, externalResults });
  expect(await call(service.socket, { command: 'maintenance' })).toMatchObject({ startsPaused: true, admissionPaused: true, restoreReview: { backupPoint, handling, externalResults } });
  await manage(service.socket, 'resume', 'local side effects reviewed');
  const restoreMilliseconds = Math.round(performance.now()-began);

  // A new completed write is a positive dispatch barrier, not a sleep-based absence check.
  const fresh = await f.submit(service.socket, 'fresh'); await f.release('fresh');
  await expect.poll(async () => (await show(service.socket, fresh)).execution.status).toBe('completed');
  expect(await show(service.socket, stale)).toMatchObject({ execution: { status: 'cancelled' }, attempts: [] });
  expect((await f.audit()).map(entry => entry.key)).toEqual(['saved', 'stale', 'missing', 'fresh']);
  expect((await f.audit()).slice(0, 3)).toEqual(beforeRestore);
  await expect(show(service.socket, missing)).rejects.toThrow('Execution not found');
  console.log(JSON.stringify({ drill: 'issue-27-post-backup-local-writes', performedAt: new Date().toISOString(), backupPoint, restoreMilliseconds, frequency: 'manual on demand; before controlled upgrades; no deployed timer', missingExecution: missing, reconciledExecutions: [stale, missing], intervention: handling, limitations: 'temporary local disk; controlled Docker/provider; no model, container or remote calls; no exactly-once or production RTO claim' }));
}, 30000);

test('maintenance pause preserves a running agent and cooperative cancellation is not stop confirmation', async () => {
  const f = await fixture();
  const id = await f.submit(f.socket, 'live');
  await expect.poll(async () => readFile(join(f.independent, 'started-live'), 'utf8').catch(() => '')).toBe('running');
  await manage(f.socket, 'pause', 'cannot wait indefinitely for local work');
  expect(await show(f.socket, id)).toMatchObject({ execution: { status: 'running' } });
  expect((await show(f.socket, id)).attempts[0].stopConfirmation).toBeUndefined();
  await call(f.socket, { command: 'cancel', id, reason: 'cooperative maintenance stop requested' });
  await expect.poll(async () => (await show(f.socket, id)).attempts[0].cancellationNotification).toBe('published');
  expect((await show(f.socket, id)).execution.status).toBe('unknown');
  expect((await show(f.socket, id)).attempts[0].stopConfirmation).toBeUndefined();
  expect(await f.audit()).toEqual([]);
  const commands = (await readFile(join(f.independent, 'adapter-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(commands.every(args => ['run', 'exec'].includes(args[0]))).toBe(true);
  await f.release('live');
  await expect.poll(async () => (await show(f.socket, id)).execution.status).toBe('cancelled');
  expect((await show(f.socket, id)).attempts[0].stopConfirmation.kind).toBe('agent-exit-marker');
  expect(await call(f.socket, { command: 'maintenance' })).toMatchObject({ startsPaused: true, admissionPaused: true });
}, 20000);
