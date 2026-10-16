import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const dirs: string[] = [];
const servers: Server[] = [];
const children = new Set<ChildProcess>();
function cli(args: string[], input = '', deadline = 5000) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {cwd: root});
  children.add(child);
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  const timer = setTimeout(() => child.kill('SIGKILL'), deadline);
  const done = once(child, 'close').then(([code, signal]) => {
    clearTimeout(timer); children.delete(child);
    return {code, signal, stdout, stderr};
  });
  return {child, done, stderr: () => stderr};
}
async function instance(reply: (req: IncomingMessage, res: ServerResponse, message: any) => void = (_req, res) => res.end(JSON.stringify({accepted:true, requestId:'request-1', executionId:'execution-1'}))) {
  const data = await mkdtemp(join(tmpdir(), 'write-')); dirs.push(data);
  const socket = join(data, 'control.sock');
  const messages: any[] = [];
  let received!: () => void;
  const waiting = new Promise<void>(done => received = done);
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => { const message = JSON.parse(body); messages.push(message); reply(req, res, message); received(); });
  });
  servers.push(server);
  await new Promise<void>(done => server.listen(socket, done));
  return {data, socket, messages, waiting};
}
const submit = ['submit', '--repo', 'alpha', '--capability', 'test-commit', '--source', 'manual'];
afterEach(async () => {
  for (const child of children) child.kill('SIGKILL');
  await Promise.all(servers.splice(0).map(server => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); })));
  await Promise.all(dirs.splice(0).map(dir => rm(dir, {recursive:true, force:true})));
});

test('human writes conservatively remain unconfirmed when an established socket closes before the local flush', async () => {
  const data = await mkdtemp(join(tmpdir(), 'write-disconnect-')); dirs.push(data);
  const socket = join(data, 'control.sock');
  let connections = 0;
  const server = createSocketServer(connection => { connections++; connection.destroy(); });
  await new Promise<void>(done => server.listen(socket, done));
  try {
    const result = await cli([...submit, '--human', '--socket', socket, '--input', '{}']).done;
    expect(result.code, result.stderr).toBe(2); expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/unconfirmed/i); expect(result.stderr).toContain(socket);
    expect(connections).toBe(1);
  } finally { await new Promise<void>(done => server.close(() => done())); }
});

test.each([
  ['cancel', ['execution-1', '--reason', 'stop']],
  ['pause', ['--source', 'operator', '--reason', 'backup']],
  ['cleanup', []],
] as const)('human %s never treats an unusable management receipt as confirmation', async (command, args) => {
  for (const body of ['null', '{}', '{"error":"failed"}']) {
    const f = await instance((_req, res) => res.end(body));
    const result = await cli([command, ...args, '--human', '--socket', f.socket]).done;
    expect(result.code, result.stderr).toBe(2); expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/unconfirmed/i); expect(f.messages).toHaveLength(1);
  }
});

test('input errors fail before any request or generated key hint, including file and stdin JSON', async () => {
  const f = await instance();
  const invalid = join(f.data, 'invalid.json'); await writeFile(invalid, 'process.exit(0)');
  for (const [args, input] of [
    [['--input', '{'], ''], [['--input-file', invalid], ''], [['--input-file', '-'], ''],
    [['--input-file', '-'], '{'], [['--input-file', join(f.data, 'missing.json')], ''],
  ] as const) {
    const result = await cli([...submit, '--human', '--socket', f.socket, ...args], input).done;
    expect(result.code, result.stderr).toBe(1); expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('Submission source:');
  }
  expect(f.messages).toEqual([]);
});

test('new write modes reject extra arguments, irrelevant options and offline writes before connecting', async () => {
  const f = await instance();
  for (const args of [
    [...submit, '--human', '--json', '--input', '{}'], [...submit, '--human', '--input', '{}', 'extra'],
    [...submit, '--json', '--input', '{}', '--call', '1'], ['cancel', 'id', '--offline', '--reason', 'stop'],
    ['cleanup', '--human', '--input-file', '-'], ['pause', '--json', '--source', 'operator', '--reason', 'backup', 'extra'],
  ]) {
    const result = await cli([...args, '--socket', f.socket]).done;
    expect(result.code, result.stderr).toBe(1); expect(result.stdout).toBe('');
  }
  expect(f.messages).toEqual([]);
});

test('legacy writes still tolerate irrelevant options and extra positionals without generating keys', async () => {
  const f = await instance();
  const result = await cli([...submit, 'extra', '--socket', f.socket, '--input', 'null', '--attempt', 'unused']).done;
  expect(result.code, result.stderr).toBe(0); expect(result.stderr).toBe('');
  expect(f.messages).toEqual([{command:'submit', submission:{repo:'alpha', capability:'test-commit', input:null, source:'manual'}}]);
});

test.each(['not JSON', '{}', 'null', '{"accepted":true}', '{"accepted":false,"requestId":"request-1"}'])('human submit treats unusable receipt %s as uncertain, never as acceptance', async body => {
  const f = await instance((_req, res) => res.end(body));
  const result = await cli([...submit, '--human', '--socket', f.socket, '--input', '{}']).done;
  expect(result.code, result.stderr).toBe(2); expect(result.stdout).toBe('');
  expect(result.stderr).toMatch(/unconfirmed/i); expect(result.stderr).toContain(f.socket);
  expect(f.messages).toHaveLength(1);
});

test('explicit server errors exit 1 while a truncated response remains uncertain', async () => {
  const rejected = await instance((_req, res) => { res.writeHead(400); res.end('{"error":"Deduplication key conflict"}'); });
  const result = await cli([...submit, '--human', '--socket', rejected.socket, '--input', '{}']).done;
  expect(result.code, result.stderr).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).toContain('Deduplication key conflict');
  expect(rejected.messages).toHaveLength(1);
  const truncated = await instance((_req, res) => { res.writeHead(200, {'content-length': '1000', connection:'close'}); res.end('{"accepted":true}'); });
  const uncertain = await cli([...submit, '--human', '--socket', truncated.socket, '--input', '{}']).done;
  expect(uncertain.code, uncertain.stderr).toBe(2); expect(uncertain.stdout).toBe('');
  expect(truncated.messages).toHaveLength(1);
});

test.each([
  ['cancel', 'execution-1', '--reason', ''],
  ['confirm-stop', 'execution-1', '--reason', 'checked'],
  ['resolve', 'execution-1', '--reason', 'checked', '--source', 'operator', '--handling', 'checked'],
  ['retry', 'execution-1', '--reason', 'checked', '--source', 'operator', '--handling', 'checked'],
  ['pause', '--source', 'operator'],
  ['resume', '--source', 'operator', '--reason', 'checked', '--target', 'wrong'],
  ['restore-review', '--source', 'operator', '--reason', 'checked'],
  [...submit, '--input', '{}', '--deduplication-key', ''],
  [...submit, '--input', '{}', '--scheduled-at', '2026-02-30T00:00:00Z'],
])('human %s validates known required fields before sending', async (...args) => {
  const f = await instance();
  const result = await cli([...args, '--human', '--socket', f.socket]).done;
  expect(result.code, result.stderr).toBe(1); expect(result.stdout).toBe('');
  expect(f.messages).toEqual([]);
});

test('human unavailable service is an ordinary error with explicit startup guidance, not an uncertain send', async () => {
  const f = await instance();
  const missing = join(f.data, 'not-running.sock');
  const result = await cli([...submit, '--human', '--socket', missing, '--input', '{}']).done;
  expect(result.code, result.stderr).toBe(1); expect(result.stdout).toBe('');
  expect(result.stderr).toContain('serve'); expect(result.stderr).toMatch(/explicit/i);
  expect(result.stderr).toContain(missing); expect(f.messages).toEqual([]);
});

test.each([
  ['cancel', 'execution-9', '--reason', 'stop'],
  ['pause', '--source', 'operator', '--reason', 'backup'],
  ['cleanup'],
])('uncertain %s checks only its actual known target without fabricated submission keys', async (...args) => {
  const f = await instance(req => req.socket.destroy());
  const result = await cli([...args, '--human', '--data', f.data]).done;
  expect(result.code, result.stderr).toBe(2); expect(result.stdout).toBe('');
  expect(result.stderr).toContain(f.data); expect(result.stderr).toContain(f.socket);
  expect(result.stderr).not.toContain('--deduplication-key'); expect(result.stderr).not.toContain('--source');
  expect(result.stderr).toContain(args[0] === 'cancel' ? "show 'execution-9'" : args[0] === 'pause' ? 'maintenance' : 'list');
  expect(f.messages).toHaveLength(1);
});

test.each([
  ['cancel', ['execution-1', '--reason', 'stop'], {request:{id:'request-1'}, execution:{id:'execution-1',status:'cancelling'}, attempts:[]}],
  ['confirm-stop', ['execution-1', '--reason', 'checked', '--source', 'operator', '--handling', 'stopped'], {request:{id:'request-1'}, execution:{id:'execution-1',status:'unknown'}, attempts:[]}],
  ['resolve', ['execution-1', '--reason', 'checked', '--source', 'operator', '--handling', 'stopped', '--external-results', 'reviewed'], {request:{id:'request-1'}, execution:{id:'execution-1',status:'resolved'}, attempts:[]}],
  ['retry', ['execution-1', '--reason', 'checked', '--source', 'operator', '--handling', 'stopped', '--external-results', 'reviewed'], {request:{id:'request-1'}, execution:{id:'execution-1',status:'queued'}, attempts:[]}],
  ['cleanup', [], {attempts:[{attemptId:'attempt-1', status:'partial', reason:'file unavailable'}]}],
  ['pause', ['--source', 'operator', '--reason', 'backup'], {admissionPaused:true, startsPaused:true, history:[]}],
  ['resume', ['--source', 'operator', '--reason', 'reviewed'], {admissionPaused:false, startsPaused:false, history:[]}],
  ['restore-review', ['--source', 'operator', '--reason', 'checked', '--handling', 'stopped', '--external-results', 'reviewed', '--backup-point', 'backup-1'], {admissionPaused:true, startsPaused:true, restoreReview:{backupPoint:'backup-1'}, history:[]}],
] as const)('human %s receipts report the operation separately from execution success', async (command, args, receipt) => {
  const f = await instance((_req, res) => res.end(JSON.stringify(receipt)));
  const result = await cli([command, ...args, '--human', '--socket', f.socket]).done;
  expect(result.code, result.stderr).toBe(0); expect(result.stderr).toBe('');
  expect(result.stdout).toContain(`Operation: ${command}`);
  expect(result.stdout).toMatch(/not.*execution success/i);
  expect(result.stdout).toContain(f.socket);
  const next = ['pause','resume','restore-review'].includes(command) ? 'maintenance' : command === 'cleanup' ? 'list' : "show 'execution-1'";
  expect(result.stdout).toContain(`sandcastle-orchestrator ${next}`);
  if (command === 'cancel') expect(result.stdout).toMatch(/not.*stopped/i);
  if (command === 'cleanup') { expect(result.stdout).toContain('partial'); expect(result.stdout).toContain('file unavailable'); }
});

test('human writes enforce a 30-second total deadline even when a partial receipt keeps arriving', async () => {
  const f = await instance((_req, res) => {
    res.writeHead(200); res.write('{');
    const timer = setInterval(() => res.write(' '), 100);
    res.once('close', () => clearInterval(timer));
  });
  const started = Date.now();
  const result = await cli([...submit, '--human', '--socket', f.socket, '--input', '{}'], '', 35_000).done;
  expect(result.code, result.stderr).toBe(2); expect(result.stdout).toBe('');
  expect(Date.now() - started).toBeGreaterThanOrEqual(30_000);
  expect(result.stderr).toContain('30 seconds'); expect(result.stderr).toMatch(/unconfirmed/i);
  expect(result.stderr).toContain(f.messages[0].submission.deduplicationKey);
  expect(f.messages).toHaveLength(1);
}, 40_000);

test('human write SIGINT exits 2 after sending and only stops client waiting', async () => {
  const f = await instance((_req, res) => { res.writeHead(200); res.write('{'); });
  const running = cli(['cancel', 'execution-9', '--reason', 'operator stop', '--human', '--socket', f.socket]);
  await f.waiting; running.child.kill('SIGINT');
  const result = await running.done;
  expect(result.code, result.stderr).toBe(2); expect(result.stdout).toBe('');
  expect(result.stderr).toMatch(/interrupt/i); expect(result.stderr).toMatch(/not.*cancel|not.*undo/i);
  expect(result.stderr).toContain("show 'execution-9'"); expect(result.stderr).toContain(f.socket);
  expect(result.stderr).not.toContain('--deduplication-key');
  expect(f.messages).toEqual([{command:'cancel', id:'execution-9', reason:'operator stop'}]);
});

test('human submit with a lost receipt exits 2 and never resends or invents an execution ID', async () => {
  const f = await instance((req) => req.socket.destroy());
  const result = await cli([...submit, '--human', '--socket', f.socket, '--input', '{}', '--deduplication-key', 'lost-receipt']).done;
  expect(result.code, result.stderr).toBe(2); expect(result.stdout).toBe('');
  expect(result.stderr).toMatch(/unconfirmed|uncertain/i);
  expect(result.stderr).toContain('manual'); expect(result.stderr).toContain('lost-receipt'); expect(result.stderr).toContain(f.socket);
  expect(result.stderr).toContain("show --source 'manual' --deduplication-key 'lost-receipt'");
  expect(result.stderr).toMatch(/not resend|do not resend/i); expect(result.stderr).not.toContain('execution-1');
  expect(f.messages).toHaveLength(1);
});

test('human rejection exits 1, explicit keys are preserved, and JSON rejection still exits 0', async () => {
  const f = await instance((_req, res) => res.end(JSON.stringify({accepted:false, requestId:'rejected-1', reason:'Unknown repo'})));
  const key = "delivery ' exact";
  const human = await cli([...submit, '--human', '--socket', f.socket, '--input', '{}', '--deduplication-key', key]).done;
  expect(human.code, human.stderr).toBe(1);
  expect(human.stdout).toContain('rejected'); expect(human.stdout).toContain('Unknown repo');
  expect(human.stdout).toContain("show 'rejected-1'");
  expect(human.stdout).not.toContain('undefined');
  expect(human.stderr).toContain(JSON.stringify(key));
  expect(f.messages[0].submission.deduplicationKey).toBe(key);
  const json = await cli([...submit, '--json', '--socket', f.socket, '--input', '{}']).done;
  expect(json.code, json.stderr).toBe(0); expect(json.stderr).toBe('');
  expect(JSON.parse(json.stdout)).toMatchObject({accepted:false});
  expect(f.messages[1].submission).not.toHaveProperty('deduplicationKey');
});

test('human submit reports acceptance, the actual execution and a same-instance query, generating a key before send', async () => {
  let stderrAtSend = '';
  let running: ReturnType<typeof cli>;
  const f = await instance((_req, res) => { stderrAtSend = running.stderr(); res.end(JSON.stringify({accepted:true, requestId:'request-1', executionId:'execution-1'})); });
  running = cli([...submit, '--human', '--data', f.data, '--input', '{}', '--config', '/must-not-load.ts']);
  const result = await running.done;
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain('accepted'); expect(result.stdout).toMatch(/not.*execution success/i);
  expect(result.stdout).toContain('execution-1'); expect(result.stdout).toContain("show 'execution-1'");
  expect(result.stdout).toContain(f.data); expect(result.stdout).toContain(f.socket);
  const key = f.messages[0].submission.deduplicationKey;
  expect(key).toMatch(/^[0-9a-f-]{36}$/);
  expect(stderrAtSend).toContain('manual'); expect(stderrAtSend).toContain(key);
  expect(stderrAtSend).toContain(`--source 'manual' --deduplication-key '${key}'`);
  expect(stderrAtSend).toContain(f.data); expect(stderrAtSend).toContain(f.socket);
  const second = await cli([...submit, '--human', '--data', f.data, '--input', '{}']).done;
  expect(second.code, second.stderr).toBe(0);
  expect(f.messages[1].submission.deduplicationKey).not.toBe(key);
});

test('file input rejects conflicting inline input and extra arguments before reading or connecting', async () => {
  const f = await instance();
  const input = join(f.data, 'input.json'); await writeFile(input, '{}');
  for (const extra of [['--input', '{}'], ['unexpected'], ['--offline'], ['--attempt', 'unused']]) {
    const result = await cli([...submit, '--socket', f.socket, '--input-file', input, ...extra]).done;
    expect(result.code, result.stderr).toBe(1); expect(result.stdout).toBe('');
    expect(result.stderr).not.toMatch(/ENOENT|ECONNREFUSED/);
  }
  expect(f.messages).toEqual([]);
});

test('submit reads JSON from stdin and requires no extra schema or SHA option', async () => {
  const f = await instance();
  const result = await cli([...submit, '--socket', f.socket, '--input-file', '-'], '\n["fixed-sha", {"question":"why?"}]\n').done;
  expect(result.code, result.stderr).toBe(0);
  expect(f.messages[0].submission.input).toEqual(['fixed-sha', {question:'why?'}]);
  expect(f.messages[0].submission).not.toHaveProperty('deduplicationKey');
});

test('submit parses a JSON file without executing it and preserves the JSON receipt and absent key', async () => {
  const f = await instance();
  const input = join(f.data, 'input.json');
  await writeFile(input, '{"question":"explain modules", "commit":"fixed-sha"}');
  const result = await cli([...submit, '--socket', f.socket, '--input-file', input]).done;
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({accepted:true, requestId:'request-1', executionId:'execution-1'});
  expect(result.stderr).toBe('');
  expect(f.messages).toEqual([{command:'submit', submission:{repo:'alpha', capability:'test-commit', source:'manual', input:{question:'explain modules', commit:'fixed-sha'}}}]);
});
