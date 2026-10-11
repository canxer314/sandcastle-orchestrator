import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { afterEach, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const script = join(root, 'examples', 'external-submission.ts');
const children = new Set<ChildProcess>();
const directories: string[] = [];

async function cli(args: string[]) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: root });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const [code] = await once(child, 'exit');
  return { code, stdout, stderr };
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'orch-external-'));
  directories.push(dir);
  const runtime = join(dir, 'runtime');
  const configDir = join(dir, 'config');
  const submissionDir = join(dir, 'input');
  const { mkdir } = await import('node:fs/promises');
  await Promise.all([mkdir(runtime), mkdir(configDir), mkdir(submissionDir)]);
  const config = join(configDir, 'config.ts');
  await writeFile(config, `export default {
    version: 'external-test',
    repos: [{ id: 'alpha', location: '/test/alpha' }],
    environments: [{ id: 'test' }],
    capabilities: [{ id: 'test-commit', environment: 'test',
      validate(input) { if (typeof input !== 'string') throw new Error('Expected commit text'); },
      run() { throw new Error('Must not execute'); }
    }]
  };`);
  const socket = join(runtime, 'control.sock');
  const service = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'serve', '--data', runtime, '--config', config], { cwd: root });
  children.add(service);
  let output = '';
  let errors = '';
  service.stdout.on('data', data => { output += data; });
  service.stderr.on('data', data => { errors += data; });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Service did not start: ${output} ${errors}`)), 10000);
    service.stdout.on('data', () => {
      if (output.includes('ready')) { clearTimeout(timer); resolve(); }
    });
    service.once('exit', code => { clearTimeout(timer); reject(new Error(`Service exited ${code}: ${errors}`)); });
  });
  return { dir, runtime, submissionDir, socket };
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) { children.delete(child); return; }
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
  children.delete(child);
}

afterEach(async () => {
  await Promise.all([...children].map(stop));
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

test('external submission resends the fixed request idempotently and rejects changed content', async () => {
  const f = await fixture();
  const submission = join(f.submissionDir, 'submission.json');
  await writeFile(submission, JSON.stringify({ repo: 'alpha', capability: 'test-commit', input: 'sha-1', source: 'nightly-test' }));
  const args = ['--socket', f.socket, '--file', submission, '--task', 'nightly-tests', '--scheduled-at', '2026-10-11T02:00:00.000Z'];

  const first = spawn(process.execPath, ['--import', 'tsx', script, ...args], { cwd: root });
  let firstOut = '';
  let firstErr = '';
  first.stdout.on('data', data => { firstOut += data; });
  first.stderr.on('data', data => { firstErr += data; });
  const [firstCode] = await once(first, 'exit');
  expect(firstCode, firstErr).toBe(0);
  const originalReceipt = JSON.parse(firstOut);

  const repeated = spawn(process.execPath, ['--import', 'tsx', script, ...args], { cwd: root });
  let repeatedOut = '';
  let repeatedErr = '';
  repeated.stdout.on('data', data => { repeatedOut += data; });
  repeated.stderr.on('data', data => { repeatedErr += data; });
  const [repeatedCode] = await once(repeated, 'exit');
  expect(repeatedCode, repeatedErr).toBe(0);
  expect(JSON.parse(repeatedOut)).toMatchObject({ requestId: originalReceipt.requestId, executionId: originalReceipt.executionId });

  const listing = await cli(['list', '--socket', f.socket, '--source', 'nightly-test']);
  expect(listing.code, listing.stderr).toBe(0);
  expect(JSON.parse(listing.stdout)).toHaveLength(1);
  expect(JSON.parse(listing.stdout)[0].request).toMatchObject({ input: 'sha-1', source: 'nightly-test', scheduledAt: args.at(-1) });

  await writeFile(submission, JSON.stringify({ repo: 'alpha', capability: 'test-commit', input: 'sha-2', source: 'nightly-test' }));
  const changed = spawn(process.execPath, ['--import', 'tsx', script, ...args], { cwd: root });
  let changedErr = '';
  changed.stderr.on('data', data => { changedErr += data; });
  const [changedCode] = await once(changed, 'exit');
  expect(changedCode, changedErr).not.toBe(0);
  expect(changedErr.toLowerCase()).toContain('conflict');
});

test('external submission returns nonzero for a rejected request', async () => {
  const f = await fixture();
  const submission = join(f.submissionDir, 'submission.json');
  await writeFile(submission, JSON.stringify({ repo: 'alpha', capability: 'test-commit', input: 17, source: 'nightly-test' }));
  const result = spawn(process.execPath, ['--import', 'tsx', script, '--socket', f.socket, '--file', submission, '--task', 'nightly-tests', '--scheduled-at', '2026-10-11T02:00:00.000Z'], { cwd: root });
  let stdout = '';
  let stderr = '';
  result.stdout.on('data', data => { stdout += data; });
  result.stderr.on('data', data => { stderr += data; });
  const [code] = await once(result, 'exit');
  expect(code, stderr).not.toBe(0);
  expect(stdout).toBe('');
  expect(stderr).toContain('Expected commit text');
});
