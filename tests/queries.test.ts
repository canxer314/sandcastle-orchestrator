import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const dirs: string[] = [];
const servers: Server[] = [];
async function cli(args: string[]) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: root });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  const [code] = await once(child, 'exit');
  clearTimeout(timer);
  return { code, stdout, stderr };
}
async function instance() {
  const data = await mkdtemp(join(tmpdir(), 'query-')); dirs.push(data);
  const socket = join(data, 'control.sock');
  const messages: any[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => { messages.push(JSON.parse(body)); res.end('[]'); });
  });
  servers.push(server);
  await new Promise<void>(done => server.listen(socket, done));
  return { data, socket, messages };
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(done => server.close(() => done()))));
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

test.each([
  ['show', 'id', '--human', '--json'],
  ['serve', '--human'],
  ['cancel', 'id', '--offline'],
  ['artifact', 'id', '--offline', '--name', 'report.txt'],
  ['list', '--offline', '--socket', '/unused'],
  ['list', 'extra', '--json'],
  ['show', 'id', '--source', 'manual', '--deduplication-key', 'key'],
  ['show', '--source', 'manual'],
  ['show', '--deduplication-key', 'key'],
  ['list', '--human', '--attempt', 'unused'],
])('new query options reject invalid combinations before connecting: %j', async (...args) => {
  const result = await cli(args);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).not.toMatch(/ENOENT|ECONNREFUSED/);
});

test('source and key queries send a readonly show message without requiring an identifier', async () => {
  const f = await instance();
  const result = await cli(['show', '--data', f.data, '--source', 'manual', '--deduplication-key', 'key']);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([]);
  expect(f.messages).toEqual([{ command: 'show', source: 'manual', deduplicationKey: 'key' }]);
});

test('human query SIGINT stops only client waiting and returns 130 with the same-instance command', async () => {
  const data = await mkdtemp(join(tmpdir(), 'query-interrupt-')); dirs.push(data);
  const socket = join(data, 'control.sock');
  const messages: any[] = [];
  let received!: () => void;
  const waiting = new Promise<void>(done => received = done);
  const server = createServer((req, res) => {
    let body = ''; req.on('data', chunk => body += chunk);
    req.on('end', () => { messages.push(JSON.parse(body)); received(); res.writeHead(200); res.write('['); });
  });
  servers.push(server); await new Promise<void>(done => server.listen(socket, done));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'show', 'execution-1', '--human', '--socket', socket], {cwd:root});
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  try {
    await waiting;
    const exited = once(child, 'exit'); child.kill('SIGINT'); const [code] = await exited;
    expect(code, stderr).toBe(130);
    expect(stdout).toBe('');
    expect(stderr).toContain('execution-1'); expect(stderr).toContain(socket);
    expect(stderr).toMatch(/not cancel|not cancelled|not canceled/i);
    expect(messages).toEqual([{command:'show',id:'execution-1'}]);
  } finally { child.kill('SIGKILL'); server.closeAllConnections(); }
});

test('human queries enforce a 30-second total deadline even while responses keep arriving', async () => {
  const data = await mkdtemp(join(tmpdir(), 'query-timeout-')); dirs.push(data);
  const socket = join(data, 'control.sock');
  const server = createServer((req, res) => {
    req.resume(); req.on('end', () => {
      res.writeHead(200); res.write('[');
      const timer = setInterval(() => res.write(' '), 100);
      res.once('close', () => clearInterval(timer));
    });
  });
  servers.push(server); await new Promise<void>(done => server.listen(socket, done));
  const started = Date.now();
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'show', 'execution-1', '--human', '--socket', socket], {cwd:root});
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  const guard = setTimeout(() => child.kill('SIGKILL'), 35_000);
  try {
    const [code] = await once(child, 'exit');
    expect(code, stderr).toBe(1); expect(stdout).toBe('');
    expect(Date.now() - started).toBeGreaterThanOrEqual(30_000);
    expect(stderr).toContain('timed out after 30 seconds'); expect(stderr).toContain(socket);
  } finally { clearTimeout(guard); child.kill('SIGKILL'); server.closeAllConnections(); }
}, 40_000);

test('failed human evidence queries retain all selectors in a runnable recheck command', async () => {
  const f = await instance();
  const result = await cli(['artifact', 'execution-1', '--human', '--socket', join(f.data,'missing.sock'), '--name', 'business.json', '--attempt', 'attempt-1', '--call', '2', '--offset', '4']);
  expect(result.code).toBe(1);
  const error = JSON.parse(result.stderr).error;
  expect(error).toContain("--name 'business.json'");
  expect(error).toContain("--attempt 'attempt-1'"); expect(error).toContain("--call '2'"); expect(error).toContain("--offset '4'");
  expect(error).not.toContain('--data');
});

test('queries select the data socket without loading config and accept physical aliases', async () => {
  const f = await instance();
  const alias = `${f.data}-alias`; dirs.push(alias); await symlink(f.data, alias);
  const result = await cli(['list', '--data', f.data, '--config', '/must-not-load.ts']);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([]);
  expect(f.messages).toEqual([{ command: 'list' }]);
  expect((await cli(['list', '--data', alias, '--socket', f.socket])).code).toBe(0);
  const conflict = await cli(['list', '--data', f.data, '--socket', join(f.data, 'other.sock')]);
  expect(conflict.code).toBe(1);
  expect(conflict.stderr).toContain(f.data);
  expect(conflict.stderr).toMatch(/conflict/i);
  expect(f.messages).toHaveLength(2);
});
