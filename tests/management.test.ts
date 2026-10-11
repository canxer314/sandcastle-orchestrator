import { request } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, chmod, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { afterEach, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const children = new Set<ChildProcess>();
const directories: string[] = [];

async function cli(args: string[]) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: root });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const timer = setTimeout(() => child.kill('SIGTERM'), 3000);
  const [code] = await once(child, 'exit');
  clearTimeout(timer);
  return { code, stdout, stderr };
}

async function socketCall(socket: string, message: unknown) {
  return new Promise<{ status: number | undefined; body: any }>((resolve, reject) => {
    const req = request({ socketPath: socket, path: '/', method: 'POST' }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('error', reject);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('Socket request timed out')));
    req.end(JSON.stringify(message));
  });
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'orch-'));
  directories.push(dir);
  const configDir = await mkdtemp(join(tmpdir(), 'orch-config-'));
  directories.push(configDir);
  const config = join(configDir, 'config.ts');
  await writeFile(config, `export default {
    version: 'config-commit-1',
    repos: [{ id: 'alpha', location: '/test/alpha' }, { id: 'beta', location: '/test/beta' }],
    environments: [{ id: 'test' }],
    capabilities: [{ id: 'test-commit', environment: 'test',
      validate(input) { if (typeof input !== 'string') throw new Error('Expected commit text'); return input; },
      async run() { throw new Error('Must not execute in issue 15'); }
    }]
  };`);
  return { dir, config, socket: join(dir, 'control.sock') };
}

async function start(f: Awaited<ReturnType<typeof fixture>>) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'serve', '--data', f.dir, '--config', f.config], { cwd: root });
  children.add(child);
  let output = '';
  let errors = '';
  child.stderr.on('data', data => { errors += data; });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Service did not start: ${output} ${errors}`)), 10000);
    child.stdout.on('data', data => {
      output += data;
      if (output.includes('ready')) { clearTimeout(timer); resolve(); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Service exited ${code}: ${errors}`)); });
  });
  return child;
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

test('socket submissions distinguish missing input from explicit null', async () => {
  const f = await fixture();
  await start(f);
  const submission = { repo: 'alpha', capability: 'test-commit', source: 'manual' };
  const missing = await socketCall(f.socket, { command: 'submit', submission });
  expect(missing).toEqual({ status: 400, body: { error: 'Missing input' } });
  const explicitNull = await socketCall(f.socket, { command: 'submit', submission: { ...submission, input: null } });
  expect(explicitNull.status).toBe(200);
  expect(explicitNull.body).toMatchObject({ accepted: false, reason: 'Expected commit text' });
  const detail = await cli(['show', explicitNull.body.requestId, '--socket', f.socket]);
  expect(JSON.parse(detail.stdout)).toMatchObject({ request: { input: null }, execution: null });
  const accepted = await cli(['submit', '--socket', f.socket, '--repo', 'alpha', '--capability', 'test-commit', '--input', '"sha"', '--source', 'manual']);
  expect(accepted.code, accepted.stderr).toBe(0);
  expect(JSON.parse(accepted.stdout).accepted).toBe(true);
});

test('socket rejects unknown commands instead of returning an existing record', async () => {
  const f = await fixture();
  await start(f);
  const submitted = await cli(['submit', '--socket', f.socket, '--repo', 'alpha', '--capability', 'test-commit', '--input', '"sha"', '--source', 'manual']);
  const receipt = JSON.parse(submitted.stdout);
  const unknown = await socketCall(f.socket, { command: 'delete', id: receipt.requestId });
  expect(unknown).toEqual({ status: 400, body: { error: 'Unknown command' } });
  const detail = await socketCall(f.socket, { command: 'show', id: receipt.requestId });
  expect(detail.status).toBe(200);
  expect(detail.body.request.id).toBe(receipt.requestId);
});

test('submission waits for asynchronous input rejection before saving a receipt', async () => {
  const f = await fixture();
  await writeFile(f.config, `export default { version:'v1', repos:[{id:'alpha',location:'/test/alpha'}], environments:[{id:'test'}], capabilities:[{
    id:'test-commit', environment:'test', async validate() { await new Promise(r => setTimeout(r, 10)); throw new Error('Async input rejected'); }, run() {}
  }] };`);
  await start(f);
  const result = await cli(['submit', '--socket', f.socket, '--repo', 'alpha', '--capability', 'test-commit', '--input', '42', '--source', 'manual']);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ accepted: false, reason: 'Async input rejected' });
  const listed = await cli(['list', '--socket', f.socket]);
  expect(JSON.parse(listed.stdout)).toEqual([]);
});

test.each(['sync', 'async'])('an empty %s validation error rejects the request across service restart', async mode => {
  const f = await fixture();
  await writeFile(f.config, `export default { version:'v1', repos:[{id:'alpha',location:'/test/alpha'}], environments:[{id:'test'}], capabilities:[{
    id:'test-commit', environment:'test', ${mode === 'async' ? 'async ' : ''}validate() { throw new Error(''); }, run() {}
  }] };`);
  const service = await start(f);
  const result = await cli(['submit', '--socket', f.socket, '--repo', 'alpha', '--capability', 'test-commit', '--input', '42', '--source', 'manual']);
  expect(result.code, result.stderr).toBe(0);
  const receipt = JSON.parse(result.stdout);
  expect(receipt).toMatchObject({ accepted: false, reason: '' });
  expect(receipt.executionId).toBeUndefined();
  await stop(service);
  await start(f);
  const detail = await cli(['show', receipt.requestId, '--socket', f.socket]);
  expect(detail.code, detail.stderr).toBe(0);
  expect(JSON.parse(detail.stdout)).toMatchObject({ request: { input: 42, rejection: '' }, execution: null });
  const listed = await cli(['list', '--socket', f.socket]);
  expect(JSON.parse(listed.stdout)).toEqual([]);
});

test('configuration file symlinks also protect the actual configuration directory', async () => {
  const f = await fixture();
  const link = join(f.dir, 'config-link.ts');
  await symlink(f.config, link);
  const result = await cli(['serve', '--data', join(resolve(f.config, '..'), 'runtime'), '--config', link]);
  expect(result.code, result.stderr).toBe(1);
  expect(result.stderr).toContain('separate');
});

test('unknown repo and capability retain explicit rejection records', async () => {
  const f = await fixture();
  await start(f);
  for (const [repo, capability, reason] of [
    ['missing', 'test-commit', 'Unknown repo'],
    ['alpha', 'missing', 'Unknown capability'],
  ]) {
    const result = await cli(['submit', '--socket', f.socket, '--repo', repo, '--capability', capability, '--input', '"sha"', '--source', 'manual']);
    expect(result.code, result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt).toMatchObject({ accepted: false, reason });
    const detail = await cli(['show', receipt.requestId, '--socket', f.socket]);
    expect(JSON.parse(detail.stdout)).toMatchObject({ request: { repo, capability, rejection: reason }, execution: null });
  }
});

test('socket setup failure exits promptly and releases exclusivity for the next start', async () => {
  const f = await fixture();
  await mkdir(f.socket);
  const failed = await cli(['serve', '--data', f.dir, '--config', f.config]);
  expect(failed.code, failed.stderr).toBe(1);
  await rm(f.socket, { recursive: true });
  await start(f);
});

test('startup rejects data directories overlapping configuration or target checkouts before changing permissions', async () => {
  const f = await fixture();
  const checkout = join(f.dir, 'checkout');
  await mkdir(checkout, { mode: 0o755 });
  const alias = join(f.dir, 'alias');
  await symlink(checkout, alias);
  await writeFile(f.config, `export default {version:'v1', repos:[{id:'a',location:${JSON.stringify(checkout)}}], environments:[], capabilities:[]};`);
  for (const data of [checkout, join(checkout, 'runtime'), alias, f.dir]) {
    const result = await cli(['serve', '--data', data, '--config', f.config]);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain('separate');
    expect(result.stdout).not.toContain('ready');
  }
  expect((await stat(checkout)).mode & 0o777).toBe(0o755);
  const configData = await cli(['serve', '--data', resolve(f.config, '..'), '--config', f.config]);
  expect(configData.code).toBe(1);
  expect(configData.stderr).toContain('separate');
});

test('unknown commands and incomplete submissions fail clearly without producing executions', async () => {
  const f = await fixture();
  await start(f);
  const unknown = await cli(['delete', '--socket', f.socket]);
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain('Unknown command');
  const missing = await cli(['show', '--socket', f.socket]);
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain('Missing identifier');
});

test('a transaction failure returns no receipt and does not retain a partial request', async () => {
  const f = await fixture();
  await start(f);
  await chmod(f.dir, 0o500);
  try {
    const failed = await cli(['submit', '--socket', f.socket, '--repo', 'alpha', '--capability', 'test-commit', '--input', '"sha"', '--source', 'manual']);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe('');
  } finally { await chmod(f.dir, 0o700); }
  const listed = await cli(['list', '--socket', f.socket]);
  expect(JSON.parse(listed.stdout)).toEqual([]);
  const accepted = await cli(['submit', '--socket', f.socket, '--repo', 'alpha', '--capability', 'test-commit', '--input', '"sha"', '--source', 'manual']);
  expect(JSON.parse(accepted.stdout).accepted).toBe(true);
});

test('a failed rejection save returns no receipt and can be retried after storage recovers', async () => {
  const f = await fixture();
  await start(f);
  await chmod(f.dir, 0o500);
  try {
    const failed = await cli(['submit', '--socket', f.socket, '--repo', 'alpha', '--capability', 'test-commit', '--input', '42', '--source', 'manual']);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe('');
  } finally { await chmod(f.dir, 0o700); }
  const rejected = await cli(['submit', '--socket', f.socket, '--repo', 'alpha', '--capability', 'test-commit', '--input', '42', '--source', 'manual']);
  expect(rejected.code, rejected.stderr).toBe(0);
  const receipt = JSON.parse(rejected.stdout);
  expect(receipt).toMatchObject({ accepted: false, reason: 'Expected commit text' });
  const detail = await cli(['show', receipt.requestId, '--socket', f.socket]);
  expect(JSON.parse(detail.stdout)).toMatchObject({ request: { input: 42, rejection: 'Expected commit text' }, execution: null });
});

test('runtime files and socket are private even in an existing permissive data directory', async () => {
  const f = await fixture();
  await chmod(f.dir, 0o755);
  await start(f);
  expect((await stat(f.dir)).mode & 0o777).toBe(0o700);
  for (const file of ['control.sock', 'records.sqlite', 'control.lock']) {
    expect((await stat(join(f.dir, file))).mode & 0o777).toBe(0o600);
  }
});

test('unavailable service and unwritable storage fail without an acceptance receipt', async () => {
  const f = await fixture();
  const unavailable = await cli(['submit', '--socket', f.socket, '--repo', 'alpha', '--capability', 'test-commit', '--input', '"sha"', '--source', 'manual']);
  expect(unavailable.code).toBe(1);
  expect(unavailable.stdout).toBe('');
  await writeFile(join(f.dir, 'records.sqlite'), 'not a database');
  const failed = await cli(['serve', '--data', f.dir, '--config', f.config]);
  expect(failed.code).toBe(1);
  expect(failed.stdout).not.toContain('ready');
  await rm(join(f.dir, 'records.sqlite'));
  await start(f);
});

test('exclusive control service survives a competing start and restarts after a crash', async () => {
  const f = await fixture();
  const service = await start(f);
  const competing = await cli(['serve', '--data', f.dir, '--config', f.config]);
  expect(competing.code).toBe(1);
  expect(competing.stderr).toContain('already running');
  const before = await cli(['list', '--socket', f.socket]);
  expect(before.code, before.stderr).toBe(0);
  const exited = once(service, 'exit');
  service.kill('SIGKILL');
  await exited;
  children.delete(service);
  await start(f);
  const after = await cli(['list', '--socket', f.socket]);
  expect(after.code, after.stderr).toBe(0);
});

test('invalid definitions are rejected at startup with clear configuration errors', async () => {
  const f = await fixture();
  for (const [config, reason] of [
    [`{ version: 'v1', repos: [{id:'a', location:'/a'}, {id:'a', location:'/b'}], environments: [], capabilities: [] }`, 'Duplicate repo id'],
    [`{ version: 'v1', repos: [], environments: [], capabilities: [{id:'test', environment:'missing', validate: x => x, run: () => {}}] }`, 'Unknown environment'],
  ]) {
    await writeFile(f.config, `export default ${config};`);
    const result = await cli(['serve', '--data', f.dir, '--config', f.config]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(reason);
    expect(result.stdout).not.toContain('ready');
  }
});

test('list filters queued executions by repo and status, keeping identical submissions independent', async () => {
  const f = await fixture();
  await start(f);
  const receipts = [];
  for (const repo of ['alpha', 'alpha', 'beta']) {
    const result = await cli(['submit', '--socket', f.socket, '--repo', repo, '--capability', 'test-commit', '--input', '"same"', '--source', 'timer']);
    receipts.push(JSON.parse(result.stdout));
  }
  expect(new Set(receipts.map(r => r.executionId)).size).toBe(3);
  const listed = await cli(['list', '--socket', f.socket, '--repo', 'alpha', '--status', 'queued']);
  expect(JSON.parse(listed.stdout).map((r: { execution: { id: string } }) => r.execution.id)).toEqual(receipts.slice(0, 2).map(r => r.executionId));
  const empty = await cli(['list', '--socket', f.socket, '--status', 'completed']);
  expect(JSON.parse(empty.stdout)).toEqual([]);
});

test('invalid input is retained as a rejected request without an execution', async () => {
  const f = await fixture();
  await start(f);
  const result = await cli(['submit', '--socket', f.socket, '--repo', 'alpha', '--capability', 'test-commit', '--input', '42', '--source', 'manual']);
  expect(result.code, result.stderr).toBe(0);
  const receipt = JSON.parse(result.stdout);
  expect(receipt).toMatchObject({ accepted: false, reason: 'Expected commit text' });
  expect(receipt.executionId).toBeUndefined();
  const detail = await cli(['show', receipt.requestId, '--socket', f.socket]);
  expect(JSON.parse(detail.stdout)).toMatchObject({ request: { input: 42, rejection: 'Expected commit text' }, execution: null, attempts: [] });
});

test('CLI accepts a request and queries the queued execution after service restart', async () => {
  const f = await fixture();
  let service = await start(f);
  const submitted = await cli(['submit', '--socket', f.socket, '--repo', 'alpha', '--capability', 'test-commit', '--input', '"abc123"', '--source', 'manual']);
  expect(submitted.code, submitted.stderr).toBe(0);
  const receipt = JSON.parse(submitted.stdout);
  expect(receipt).toMatchObject({ accepted: true, requestId: expect.any(String), executionId: expect.any(String) });
  await stop(service);
  service = await start(f);
  const detail = await cli(['show', receipt.executionId, '--socket', f.socket]);
  expect(detail.code, detail.stderr).toBe(0);
  expect(JSON.parse(detail.stdout)).toMatchObject({
    request: { id: receipt.requestId, repo: 'alpha', capability: 'test-commit', input: 'abc123', source: 'manual' },
    execution: { id: receipt.executionId, status: 'queued' },
    attempts: []
  });
}, 20000);
