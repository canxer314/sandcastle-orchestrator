import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { call } from '../src/control.js';

const root = resolve(import.meta.dirname, '..');
const directories: string[] = [];
const children: ChildProcess[] = [];
async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), 'orch-quota-'));
  directories.push(directory);
  return directory;
}
async function start(config: string, data: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'serve', '--config', config, '--data', data], { cwd: root });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    let output = ''; let errors = '';
    const timer = setTimeout(() => reject(Error(errors || 'not ready')), 10000);
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('ready')) { clearTimeout(timer); resolve(); } });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.once('exit', () => { clearTimeout(timer); reject(Error(errors)); });
  });
  return { socket: join(data, 'control.sock'), child };
}
async function stop(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
}
afterEach(async () => {
  await Promise.all(children.splice(0).map(stop));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function fixture(global = 2, repoLimit?: number, liveGate = false) {
  const configDirectory = await temporary(); const data = await temporary(); const gates = await temporary();
  const repos: {id: string; location: string; sha: string}[] = [];
  for (const id of ['alpha', 'beta']) {
    const location = await temporary();
    const git = (...args: string[]) => execFileSync('git', ['-C', location, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    git('init'); await writeFile(join(location, 'context.txt'), id); git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'first');
    repos.push({ id, location, sha: git('rev-parse', 'HEAD') });
  }
  const docker = join(gates, 'docker');
  await writeFile(docker, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(join(gates, 'calls'))}\ncase "$1" in\nrun) echo controlled-container;;\nexec) case "$*" in *ORCH_EXIT_*) ${liveGate ? `while [ ! -f ${JSON.stringify(join(gates, 'agent-end'))} ]; do sleep 0.02; done; ` : ''}marker=$(printf '%s' "$*" | grep -o 'ORCH_EXIT_[a-f0-9]*' | head -1); printf '{"summary":"done"}\\n%s:0\\n' "$marker";; esac;;\nesac\n`, { mode: 0o700 });
  const config = join(configDirectory, 'config.ts');
  await writeFile(config, `import {access,writeFile} from 'node:fs/promises';
export default {version:'quota-v1',primaryAgentLimit:${global},repos:${JSON.stringify(repos.map(({ id, location }) => ({ id, location, ...(repoLimit === undefined ? {} : { primaryAgentLimit: repoLimit }) })))},environments:[{id:'env',docker:{image:'controlled:image',binary:${JSON.stringify(docker)},network:'none'}}],
capabilities:[{id:'deterministic',environment:'env',validate(){},execution:{commit(input){return input.sha}},run(){return {done:true}}}],
providers:[{id:'controlled',agent:{name:'controlled',env:{},buildPrintCommand(){return {command:'controlled-agent'}},parseStreamLine(line){return [{type:'result',result:line}]}}}],
roles:[{id:'report',description:'report',validate(){},async buildPrompt({input}){await writeFile(${JSON.stringify(gates)}+'/prepared-'+input.key,'started');while(true){try{await access(${JSON.stringify(gates)}+'/'+input.key);break}catch{}await new Promise(r=>setTimeout(r,20))}return 'report'},skills:[],tools:[],validateReport(output){return JSON.parse(output)}}],
roleBindings:[{role:'report',provider:'controlled',environment:'env',commit(input){return input.sha}}]};`);
  const service = await start(config, data);
  const submit = async (repo: string, key: string, capability = 'report') => {
    const receipt = await call(service.socket, { command: 'submit', submission: { repo, capability, input: { key, sha: repos.find(r => r.id === repo)!.sha }, source: 'manual' } }) as any;
    return String(receipt.executionId);
  };
  const show = async (id: string) => await call(service.socket, { command: 'show', id }) as any;
  const release = async (key: string) => writeFile(join(gates, key), 'go');
  return { ...service, config, data, gates, submit, show, release };
}

test('oldest eligible primary agents skip a full repo, count preparation, and do not block deterministic work', async () => {
  const f = await fixture();
  const first = await f.submit('alpha', 'first');
  const second = await f.submit('alpha', 'second');
  const other = await f.submit('beta', 'other');
  const later = await f.submit('beta', 'later');
  expect((await f.show(first)).execution.status).toBe('starting');
  expect((await f.show(second)).execution.status).toBe('queued');
  expect((await f.show(other)).execution.status).toBe('starting');
  expect((await f.show(later)).execution.status).toBe('queued');
  const deterministic = await f.submit('alpha', 'deterministic', 'deterministic');
  await expect.poll(async () => (await f.show(deterministic)).execution.status).toBe('completed');
  await f.release('other');
  await expect.poll(async () => (await f.show(later)).execution.status).toBe('starting');
  expect((await f.show(second)).execution.status).toBe('queued');
  await f.release('first');
  await expect.poll(async () => (await f.show(second)).execution.status).toBe('starting');
}, 20000);

test('concurrent submissions honor global and explicit repo limits and preserve oldest queue order', async () => {
  const f = await fixture(2, 2);
  await Promise.all(Array.from({ length: 6 }, (_, index) => f.submit(index % 2 ? 'beta' : 'alpha', `race-${index}`)));
  const details = await call(f.socket, { command: 'list' }) as any[];
  expect(details.map(detail => detail.execution.status)).toEqual(['starting', 'starting', 'queued', 'queued', 'queued', 'queued']);
  await f.release(details[1].request.input.key);
  await expect.poll(async () => (await f.show(String(details[2].execution.id))).execution.status).toBe('starting');
  expect((await f.show(String(details[3].execution.id))).execution.status).toBe('queued');
}, 20000);

test('restart retains unknown quota; cancellation does not release it and manual confirmation starts queued work', async () => {
  const f = await fixture(1);
  const first = await f.submit('alpha', 'first');
  const waiting = await f.submit('beta', 'waiting');
  await call(f.socket, { command: 'cancel', id: first, reason: 'stop requested' });
  expect((await f.show(waiting)).execution.status).toBe('queued');
  await stop(f.child);
  const restarted = await start(f.config, f.data);
  const show = async (id: string) => await call(restarted.socket, { command: 'show', id }) as any;
  expect((await show(first)).execution.status).toBe('unknown');
  const attempt = (await show(first)).attempts[0];
  await rm(attempt.stopDirectory, {recursive:true, force:true});
  await call(restarted.socket, {command:'cancel', id:first, reason:'notification cannot be delivered'});
  await expect.poll(async () => (await show(first)).attempts[0].cancellationNotification).toBe('failed');
  expect((await show(waiting)).execution.status).toBe('queued');
  await call(restarted.socket, { command: 'confirm-stop', id: first, source: 'operator', handling: 'verified', reason: 'old entrypoint ended', externalResults: 'no external work' });
  await expect.poll(async () => (await show(waiting)).execution.status).toBe('starting');
  expect((await show(first)).attempts[0].stopConfirmation.kind).toBe('manual');
}, 20000);

test('startup scans queued work without restarting an unknown attempt; only its repo remains blocked', async () => {
  const f = await fixture(1);
  const first = await f.submit('alpha', 'first');
  const sameRepo = await f.submit('alpha', 'same');
  const other = await f.submit('beta', 'other');
  await stop(f.child);
  const original = await readFile(f.config, 'utf8');
  await writeFile(f.config, original.replace('primaryAgentLimit:1', 'primaryAgentLimit:2'));
  const restarted = await start(f.config, f.data);
  const show = async (id: string) => await call(restarted.socket, { command: 'show', id }) as any;
  await expect.poll(async () => (await show(other)).execution.status).toBe('starting');
  expect((await show(sameRepo)).execution.status).toBe('queued');
  expect((await show(first)).attempts).toHaveLength(1);
}, 20000);

test('attempt save failure never starts preparation or execution and does not consume quota', async () => {
  const f = await fixture(1);
  const db = new DatabaseSync(join(f.data, 'records.sqlite'));
  db.exec("CREATE TRIGGER no_attempt BEFORE INSERT ON attempts BEGIN SELECT RAISE(FAIL, 'attempt save blocked'); END;");
  const failed = await f.submit('alpha', 'failed');
  await expect.poll(async () => (await f.show(failed)).execution.status).toBe('start_failed');
  expect((await f.show(failed)).attempts).toEqual([]);
  expect(await readFile(join(f.gates, 'calls'), 'utf8').catch(() => '')).toBe('');
  expect(await readFile(join(f.gates, 'prepared-failed'), 'utf8').catch(() => '')).toBe('');
  db.exec('DROP TRIGGER no_attempt'); db.close();
  const next = await f.submit('beta', 'next');
  expect((await f.show(next)).execution.status).toBe('starting');
}, 20000);

test('live noncooperative cancelled agent retains its quota, including failed notification, until trusted end', async () => {
  const f = await fixture(2, undefined, true);
  const first = await f.submit('alpha', 'live');
  await f.release('live');
  await expect.poll(async () => (await f.show(first)).execution.status).toBe('running');
  const queued = await f.submit('alpha', 'queued');
  const attempt = (await f.show(first)).attempts[0];
  await rm(attempt.stopDirectory, {recursive:true, force:true});
  await call(f.socket, {command:'cancel', id:first, reason:'stop requested'});
  await expect.poll(async () => (await f.show(first)).attempts[0].cancellationNotification).toBe('failed');
  const other = await f.submit('beta', 'other');
  const full = await f.submit('beta', 'full');
  expect((await f.show(queued)).execution.status).toBe('queued');
  expect((await f.show(other)).execution.status).toBe('starting');
  expect((await f.show(full)).execution.status).toBe('queued');
  await f.release('agent-end');
  await expect.poll(async () => (await f.show(first)).execution.status).toBe('cancelled');
  await expect.poll(async () => (await f.show(queued)).execution.status).toBe('starting');
  expect((await f.show(full)).execution.status).toBe('queued');
}, 20000);

test('failed end save retains quota across restart until manual stop confirmation', async () => {
  const f = await fixture(1);
  const first = await f.submit('alpha', 'first');
  const waiting = await f.submit('beta', 'waiting');
  await expect.poll(async () => readFile(join(f.gates, 'prepared-first'), 'utf8').catch(() => '')).toBe('started');
  const db = new DatabaseSync(join(f.data, 'records.sqlite'));
  db.exec("CREATE TRIGGER no_end BEFORE UPDATE ON attempts WHEN NEW.run_state IN ('completed','unknown') BEGIN SELECT RAISE(FAIL, 'end save blocked'); END;");
  await f.release('first');
  await expect.poll(async () => String((await f.show(first)).attempts[0].persistenceError)).toContain('end save blocked');
  expect((await f.show(waiting)).execution.status).toBe('queued');
  await stop(f.child); db.exec('DROP TRIGGER no_end'); db.close();
  const restarted = await start(f.config, f.data);
  const show = async (id: string) => await call(restarted.socket, {command:'show', id}) as any;
  expect((await show(first)).execution.status).toBe('unknown');
  expect((await show(waiting)).execution.status).toBe('queued');
  await call(restarted.socket, {command:'confirm-stop', id:first, source:'operator', handling:'verified', reason:'trusted external inspection', externalResults:'no writes'});
  await expect.poll(async () => (await show(waiting)).execution.status).toBe('starting');
}, 20000);
