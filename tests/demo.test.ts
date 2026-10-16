import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, test } from 'vitest';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const dirs: string[] = [];
const children = new Set<ChildProcess>();
function cli(args: string[], env = process.env) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {cwd:root, env});
  children.add(child);
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  child.stdin.end();
  const done = once(child, 'close').then(([code]) => { children.delete(child); return {code, stdout, stderr}; });
  return {child, done, stderr: () => stderr};
}
async function fixture(run = "echo controlled-test; exit 0", inspect = '{"Running":false,"Status":"exited","ExitCode":0}') {
  const base = await mkdtemp(join(tmpdir(), 'demo-')); dirs.push(base);
  const bin = join(base, 'bin'); await mkdir(bin);
  const calls = join(base, 'calls');
  await writeFile(join(bin, 'docker'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\ncase "$1" in\n--version|info|image) echo controlled;;\nrun) ${run};;\ninspect) echo '${inspect}';;\nstop) exit 0;;\n*) exit 9;;\nesac\n`, {mode:0o700});
  const env = {...process.env, PATH:`${bin}:${process.env.PATH}`};
  const config = join(base, 'config/config.ts'); const data = join(base, 'data'); const repo = join(base, 'repo');
  expect((await cli(['init', '--config', config, '--data', data, '--demo-repo', repo, '--yes', '--json'], env).done).code).toBe(0);
  return {base, bin, calls, env, config, data, repo};
}
afterEach(async () => {
  for (const child of children) child.kill('SIGTERM');
  await Promise.all(dirs.splice(0).map(dir => rm(dir, {recursive:true, force:true})));
});

test('demo uses the committed SHA through CLI/socket, separates evidence and preserves history on rerun', async () => {
  const f = await fixture();
  const sha = (await exec('git', ['-C', f.repo, 'rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(join(f.repo, 'uncommitted'), 'keep me');
  const first = await cli(['demo', '--data', f.data, '--json'], f.env).done;
  expect(first.code, first.stderr).toBe(0);
  const result = JSON.parse(first.stdout);
  expect(result).toMatchObject({testResult:'passed', executionStopped:true, serviceExited:true, sha});
  expect(first.stderr).toContain('仅测已提交版本');
  expect(result.executionId).toEqual(expect.any(String));
  expect(await readFile(result.serviceLog, 'utf8')).toContain('"ready":true');
  const detail = JSON.parse((await cli(['show', result.executionId, '--data', f.data, '--offline']).done).stdout);
  expect(detail.attempts[0]).toMatchObject({actualSha:sha, business:{passed:true, exitCode:0}});
  expect(JSON.parse((await cli(['logs', result.executionId, '--data', f.data, '--offline']).done).stdout)).toMatchObject({stdout:'controlled-test\n', complete:true});
  await writeFile(join(f.repo, 'test.cjs'), 'console.log("new committed version");\n');
  await exec('git', ['-C', f.repo, 'add', 'test.cjs']);
  await exec('git', ['-C', f.repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'New demo version']);
  const second = await cli(['demo', '--data', f.data, '--json'], f.env).done;
  expect(second.code, second.stderr).toBe(0);
  expect(JSON.parse(second.stdout).executionId).not.toBe(result.executionId);
  expect(JSON.parse(second.stdout).sha).not.toBe(sha);
  expect(JSON.parse((await cli(['list', '--data', f.data, '--offline']).done).stdout)).toHaveLength(2);
  expect(await readFile(join(f.repo, 'uncommitted'), 'utf8')).toBe('keep me');
}, 20000);

test('reset requires explicit confirmation and rebuilds only the repo, keeping configuration, logs and records', async () => {
  const f = await fixture();
  const run = await cli(['demo', '--data', f.data, '--json'], f.env).done;
  expect(run.code, run.stderr).toBe(0);
  const original = await readFile(f.config, 'utf8');
  const records = await readFile(join(f.data, 'records.sqlite'));
  const logs = await readdir(join(f.data, 'demo-runs'));
  await writeFile(join(f.repo, 'user-change'), 'discard explicitly');
  const refused = await cli(['init', '--reset-demo', '--data', f.data, '--json'], f.env).done;
  expect(refused.code).toBe(1);
  expect(await readFile(join(f.repo, 'user-change'), 'utf8')).toBe('discard explicitly');
  const reset = await cli(['init', '--reset-demo', '--data', f.data, '--yes', '--json'], f.env).done;
  expect(reset.code, reset.stderr).toBe(0);
  expect(JSON.parse(reset.stdout)).toMatchObject({ok:true, status:'reset'});
  expect(reset.stderr).toContain('discard');
  expect(await readdir(f.repo)).toEqual(expect.arrayContaining(['.git', 'test.cjs']));
  expect(await readdir(f.repo)).not.toContain('user-change');
  expect(await readFile(f.config, 'utf8')).toBe(original);
  expect(await readFile(join(f.data, 'records.sqlite'))).toEqual(records);
  expect(await readdir(join(f.data, 'demo-runs'))).toEqual(logs);
}, 15000);

test('demo distinguishes business failure and contract failure from completed and retains evidence', async () => {
  const f = await fixture('echo failing-test; exit 1', '{"Running":false,"Status":"exited","ExitCode":1}');
  const failed = await cli(['demo', '--data', f.data, '--json'], f.env).done;
  expect(failed.code, failed.stderr).toBe(1);
  expect(JSON.parse(failed.stdout)).toMatchObject({testResult:'failed', executionStopped:true, serviceExited:true});
  await writeFile(f.config, (await readFile(f.config, 'utf8')).replace('return { business: { passed: result.exitCode === 0, exitCode: result.exitCode } };', 'throw Error("invalid interpretation");'));
  const invalid = await cli(['demo', '--data', f.data, '--json'], f.env).done;
  expect(invalid.code, invalid.stderr).toBe(1);
  expect(JSON.parse(invalid.stdout)).toMatchObject({testResult:'runtime-failure', executionStopped:true, serviceExited:true});
  expect(await readFile(JSON.parse(invalid.stdout).testLogs.stdout, 'utf8')).toBe('failing-test\n');
}, 15000);

test('demo and reset refuse an existing service and queued legacy work without dispatching it', async () => {
  const f = await fixture();
  const service = cli(['serve', '--data', f.data, '--config', f.config, '--maintenance', 'paused'], f.env);
  const {call} = await import('../src/control.js');
  const socket = join(f.data, 'control.sock');
  await expect.poll(async () => { try { await call(socket, {command:'list'}); return true; } catch { return false; } }, {timeout:8000}).toBe(true);
  expect((await cli(['demo', '--data', f.data, '--json'], f.env).done).code).toBe(1);
  expect((await cli(['init', '--reset-demo', '--data', f.data, '--yes', '--json'], f.env).done).code).toBe(1);
  await call(socket, {command:'resume', target:'admission', source:'test', reason:'queue only'});
  const sha = (await exec('git', ['-C', f.repo, 'rev-parse', 'HEAD'])).stdout.trim();
  const receipt = await call(socket, {command:'submit', submission:{repo:'demo', capability:'demo-test', input:sha, source:'prior'}}) as any;
  service.child.kill('SIGTERM'); await service.done;
  const blocked = await cli(['demo', '--data', f.data, '--json'], f.env).done;
  expect(blocked.code).toBe(1); expect(blocked.stdout).toContain('queued');
  expect((await cli(['init', '--reset-demo', '--data', f.data, '--yes', '--json'], f.env).done).code).toBe(1);
  expect(JSON.parse((await cli(['show', receipt.executionId, '--data', f.data, '--offline']).done).stdout).execution.status).toBe('queued');
  await expect(readFile(f.calls, 'utf8')).rejects.toMatchObject({code:'ENOENT'});
}, 15000);

test('first Ctrl+C cancels and checks actual stop before exiting 130', async () => {
  const f = await fixture();
  const gate = join(f.base, 'stop');
  await writeFile(join(f.bin, 'docker'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${f.calls}'\ncase "$1" in\n--version|info|image) echo controlled;;\nrun) while [ ! -f '${gate}' ]; do sleep 0.02; done; echo stopped; exit 143;;\nstop) touch '${gate}';;\ninspect) echo '{"Running":false,"Status":"exited","ExitCode":143}';;\nesac\n`, {mode:0o700});
  const running = cli(['demo', '--data', f.data, '--json'], f.env);
  await expect.poll(async () => (await readFile(f.calls, 'utf8').catch(() => '')).includes('run --pull=never'), {timeout:8000}).toBe(true);
  running.child.kill('SIGINT');
  const ended = await running.done;
  expect(ended.code, ended.stdout + ended.stderr).toBe(130);
  expect(JSON.parse(ended.stdout)).toMatchObject({testResult:'cancelled', executionStopped:true, serviceExited:true});
}, 15000);

test('second Ctrl+C reports unconfirmed stop, preserves journal and blocks demo/reset', async () => {
  const f = await fixture('echo uncertain-test', '{"Running":true,"Status":"running","ExitCode":0}');
  const running = cli(['demo', '--data', f.data, '--json'], f.env);
  await expect.poll(async () => (await readFile(f.calls, 'utf8').catch(() => '')).includes('stop --timeout -1'), {timeout:8000}).toBe(true);
  running.child.kill('SIGINT');
  await new Promise(resolve => setTimeout(resolve, 70));
  running.child.kill('SIGINT');
  const ended = await running.done;
  expect(ended.code, ended.stderr).toBe(2);
  const result = JSON.parse(ended.stdout);
  expect(result).toMatchObject({status:'unknown', executionStopped:false});
  expect(result.gaps.join(' ')).toContain('未确认停止');
  expect(JSON.parse(await readFile(result.journal, 'utf8')).settled).toBe(false);
  expect(await readFile(result.testLogs.stdout, 'utf8')).toBe('uncertain-test\n');
  const retry = await cli(['demo', '--data', f.data, '--json'], f.env).done;
  expect(retry.code).toBe(1); expect(retry.stdout).toContain('Unresolved demo');
  expect((await cli(['init', '--reset-demo', '--data', f.data, '--yes', '--json'], f.env).done).code).toBe(1);
  expect((await readFile(f.calls, 'utf8')).match(/run --pull=never/g)).toHaveLength(1);
}, 15000);

test('preflight failures keep a service log, invalid options do not load configuration', async () => {
  const f = await fixture();
  await writeFile(join(f.bin, 'docker'), '#!/bin/sh\nexit 1\n', {mode:0o700});
  const missing = await cli(['demo', '--data', f.data, '--json'], f.env).done;
  expect(missing.code).toBe(1);
  const result = JSON.parse(missing.stdout);
  expect(result).toMatchObject({acceptance:'not-submitted', executionStopped:true, serviceExited:true});
  expect(await readFile(result.serviceLog, 'utf8')).toContain('docker');
  for (const args of [['--human', '--json'], ['--offline'], ['extra'], ['--yes'], ['--socket', '/tmp/other'], ['--reset-demo']]) {
    const invalid = await cli(['demo', '--data', f.data, ...args], f.env).done;
    expect(invalid.code).toBe(1); expect(invalid.stderr).not.toContain('Loading trusted');
  }
}, 15000);

function faults(f: Awaited<ReturnType<typeof fixture>>, mode: string) {
  return {...f.env, DEMO_TEST_FAULT:mode, NODE_OPTIONS:`${process.env.NODE_OPTIONS ?? ''} --require=${join(root, 'tests/fixtures/demo-faults.cjs')}`};
}

test('a lost submission receipt is reconciled by source/key with one submission', async () => {
  const f = await fixture();
  const run = await cli(['demo', '--data', f.data, '--json'], faults(f, 'lost-receipt')).done;
  expect(run.code, run.stdout + run.stderr).toBe(0);
  const result = JSON.parse(run.stdout);
  expect(result).toMatchObject({acceptance:'accepted', testResult:'passed', executionStopped:true, serviceExited:true});
  const matches = JSON.parse((await cli(['show', '--source', result.source, '--deduplication-key', result.deduplicationKey, '--data', f.data, '--offline']).done).stdout);
  expect(matches).toHaveLength(1);
  expect((await readFile(f.calls, 'utf8')).match(/run --pull=never/g)).toHaveLength(1);
}, 15000);

test.each(['no-ready', 'query-stall'])('startup requires owned ready AND a successful query (%s)', async mode => {
  const f = await fixture();
  const run = await cli(['demo', '--data', f.data, '--json'], faults(f, mode)).done;
  expect(run.code, run.stdout + run.stderr).toBe(1);
  const result = JSON.parse(run.stdout);
  expect(result).toMatchObject({acceptance:'not-submitted', serviceExited:true});
  expect(result.executionId).toBeUndefined();
  expect((await readFile(f.calls, 'utf8'))).not.toContain('run --pull');
  expect(await readFile(result.serviceLog, 'utf8')).toContain('"ready":true');
}, 15000);

test('execution budget cancels once and cleanup budget cannot turn unknown into stopped', async () => {
  const f = await fixture('echo uncertain', '{"Running":true,"Status":"running","ExitCode":0}');
  const unknown = await cli(['demo', '--data', f.data, '--json'], faults(f, 'cleanup-timeout')).done;
  expect(unknown.code, unknown.stdout + unknown.stderr).toBe(2);
  expect(JSON.parse(unknown.stdout)).toMatchObject({executionStopped:false, status:'unknown'});
  expect((await readFile(f.calls, 'utf8')).match(/stop --timeout -1/g)).toHaveLength(1);

  const g = await fixture(); const gate = join(g.base, 'stop');
  await writeFile(join(g.bin, 'docker'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${g.calls}'\ncase "$1" in\n--version|info|image) echo controlled;;\nrun) while [ ! -f '${gate}' ]; do sleep 0.02; done; exit 143;;\nstop) touch '${gate}';;\ninspect) echo '{"Running":false,"Status":"exited","ExitCode":143}';;\nesac\n`, {mode:0o700});
  const expired = await cli(['demo', '--data', g.data, '--json'], faults(g, 'execution-timeout')).done;
  expect(expired.code, expired.stdout + expired.stderr).toBe(1);
  expect(JSON.parse(expired.stdout)).toMatchObject({executionStopped:true, serviceExited:true, testResult:'cancelled'});
  expect((await readFile(g.calls, 'utf8')).match(/stop --timeout -1/g)).toHaveLength(1);
}, 15000);

test('Ctrl+C during startup prevents any later submission and closes the owned service', async () => {
  const f = await fixture();
  await writeFile(f.config, (await readFile(f.config, 'utf8')) + '\nif (process.argv[1].includes("demo-service")) await new Promise(resolve => setTimeout(resolve, 600));\n');
  const running = cli(['demo', '--data', f.data, '--json'], f.env);
  await expect.poll(() => running.stderr().includes('starting service'), {timeout:8000}).toBe(true);
  // Let the child install its startup signal handler.
  await new Promise(resolve => setTimeout(resolve, 250));
  running.child.kill('SIGINT');
  const result = await running.done;
  expect(result.code, result.stdout + result.stderr).toBe(130);
  expect(JSON.parse(result.stdout)).toMatchObject({acceptance:'not-submitted', serviceExited:true});
  expect(await readFile(f.calls, 'utf8')).not.toContain('run --pull');
}, 15000);

test('reset path protection and complete-SHA preflight cannot be bypassed by --yes', async () => {
  const f = await fixture();
  const marker = await readFile(join(f.data, 'init.json'), 'utf8');
  const config = await readFile(f.config, 'utf8');
  const conflict = await cli(['init', '--reset-demo', '--yes', '--json', '--data', f.data, '--demo-repo', f.base], f.env).done;
  expect(conflict.code).toBe(1); expect(conflict.stdout).toContain('conflicts');
  expect(await readFile(join(f.data, 'init.json'), 'utf8')).toBe(marker);
  await writeFile(f.config, config.replace('return input as string;', 'return "HEAD";'));
  const bad = await cli(['demo', '--data', f.data, '--json'], f.env).done;
  expect(bad.code).toBe(1); expect(bad.stdout).toContain('full SHA');
  expect(await readFile(f.calls, 'utf8')).not.toContain('run --pull');
}, 15000);

test('no source/key match after a lost receipt remains unknown and never resends', async () => {
  const f = await fixture();
  const run = await cli(['demo', '--data', f.data, '--json'], faults(f, 'lost-no-match')).done;
  expect(run.code, run.stdout + run.stderr).toBe(2);
  const result = JSON.parse(run.stdout);
  expect(result).toMatchObject({acceptance:'unknown', executionStopped:false});
  expect(result.executionId).toBeUndefined();
  expect(result.gaps.join(' ')).toContain('No match is not permission to resend');
  const retry = await cli(['demo', '--data', f.data, '--json'], f.env).done;
  expect(retry.code).toBe(1); expect(retry.stdout).toContain('Unresolved demo');
  const matches = JSON.parse((await cli(['show', '--source', result.source, '--deduplication-key', result.deduplicationKey, '--data', f.data, '--offline']).done).stdout);
  expect(matches).toHaveLength(1);
  expect(((await readFile(f.calls, 'utf8')).match(/run --pull=never/g) ?? []).length).toBeLessThanOrEqual(1);
}, 15000);

test('a child startup failure keeps its own log without fabricating an execution ID', async () => {
  const f = await fixture();
  await writeFile(f.config, (await readFile(f.config, 'utf8')) + '\nif (process.argv[1].includes("demo-service")) throw Error("controlled startup failure");\n');
  const run = await cli(['demo', '--data', f.data, '--json'], f.env).done;
  expect(run.code, run.stdout + run.stderr).toBe(1);
  const result = JSON.parse(run.stdout);
  expect(result).toMatchObject({acceptance:'not-submitted', serviceExited:true});
  expect(result.executionId).toBeUndefined();
  expect(await readFile(result.serviceLog, 'utf8')).toContain('service_failure');
}, 15000);

test('interactive reset preserves a decline and accepts an explicit yes', async () => {
  const f = await fixture();
  await writeFile(join(f.repo, 'change'), 'keep until confirmed');
  const command = `${process.execPath} --import tsx src/cli.ts init --reset-demo --data '${f.data}'`;
  for (const answer of ['n', 'yes']) {
    const child = spawn('script', ['-q', '-e', '-c', command, '/dev/null'], {cwd:root, env:f.env}); children.add(child);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('[y/N]')) child.stdin.end(`${answer}\n`); });
    child.stdin.on('error', () => {});
    const [code] = await once(child, 'close'); children.delete(child);
    expect(code, output).toBe(answer === 'n' ? 1 : 0);
    expect((await readdir(f.repo)).includes('change')).toBe(answer === 'n');
  }
}, 15000);

test('the owned service rechecks legacy work under its lock after parent preflight', async () => {
  const f = await fixture();
  const gate = join(f.base, 'release-preflight'); const waiting = join(f.base, 'preflight-waiting');
  await writeFile(f.config, (await readFile(f.config, 'utf8')) + `\nif (process.argv.includes('demo')) { const fs = await import('node:fs/promises'); await fs.writeFile(${JSON.stringify(waiting)}, 'waiting'); while (!await fs.stat(${JSON.stringify(gate)}).catch(() => null)) await new Promise(r => setTimeout(r, 20)); }\n`);
  const running = cli(['demo', '--data', f.data, '--json'], f.env);
  await expect.poll(() => readFile(waiting, 'utf8').catch(() => ''), {timeout:8000}).toBe('waiting');
  const service = cli(['serve', '--data', f.data, '--config', f.config, '--maintenance', 'paused'], f.env);
  const {call} = await import('../src/control.js'); const socket = join(f.data, 'control.sock');
  await expect.poll(async () => { try { await call(socket, {command:'list'}); return true; } catch { return false; } }, {timeout:8000}).toBe(true);
  await call(socket, {command:'resume', target:'admission', source:'test', reason:'queue only'});
  const sha = (await exec('git', ['-C', f.repo, 'rev-parse', 'HEAD'])).stdout.trim();
  await call(socket, {command:'submit', submission:{repo:'demo', capability:'demo-test', input:sha, source:'racing-prior'}});
  service.child.kill('SIGTERM'); await service.done;
  await writeFile(gate, 'continue');
  const ended = await running.done;
  expect(ended.code, ended.stdout + ended.stderr).toBe(1);
  expect(JSON.parse(ended.stdout)).toMatchObject({acceptance:'not-submitted', serviceExited:true});
  expect(await readFile(f.calls, 'utf8')).not.toContain('run --pull');
  const history = JSON.parse((await cli(['list', '--data', f.data, '--offline']).done).stdout);
  expect(history).toHaveLength(1); expect(history[0].execution.status).toBe('queued');
}, 20000);
