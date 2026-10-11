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

test('legacy description-only tools still allow serve, role submission and show without MCP', async () => {
  const f = await fixture();
  await writeFile(f.config, `export default {
    version:'legacy-tools', repos:[{id:'alpha',location:'/test/alpha'}], environments:[{id:'test'}], capabilities:[],
    tools:[{id:'notes',description:''},{id:'notes',description:'second description'},{id:'',description:''}],
    roles:[{id:'report',description:'report',validate(input){return input},buildPrompt(){return 'report'},skills:[],tools:['notes',''],validateReport(output){return output}}]
  };`);
  await start(f);
  const submitted = await cli(['submit', '--socket', f.socket, '--repo', 'alpha', '--capability', 'report', '--input', 'null', '--source', 'manual']);
  expect(submitted.code, submitted.stderr).toBe(0);
  const receipt = JSON.parse(submitted.stdout);
  expect(receipt.accepted).toBe(true);
  const detail = await socketCall(f.socket, { command: 'show', id: receipt.requestId });
  expect(detail).toMatchObject({ status: 200, body: { request: { capability: 'report', input: null }, execution: { status: 'queued' } } });
});

test.each(['null', '{}', 'false', '42', "'unused'", '[null, false, 42, {}, {id:42}, {id:""}]'])('unused legacy tools shape %s does not block serve', async tools => {
  const f = await fixture();
  await writeFile(f.config, `export default {
    version:'legacy-shape', repos:[{id:'alpha',location:'/test/alpha'}], environments:[], capabilities:[], tools:${tools}
  };`);
  await start(f);
  expect(await socketCall(f.socket, { command: 'list' })).toEqual({ status: 200, body: [] });
});

test.each([
  { name: 'empty description', tools: "[{id:'run_tests',description:'',capability:'test-commit',inputSchema:z.object({})}]" },
  { name: 'duplicate executable IDs', tools: "[{id:'run_tests',description:'run',capability:'test-commit',inputSchema:z.object({})},{id:'run_tests',description:'run again',capability:'test-commit',inputSchema:z.object({})}]" },
  { name: 'description first collision', tools: "[{id:'run_tests',description:'legacy'},{id:'run_tests',description:'run',capability:'test-commit',inputSchema:z.object({})}]" },
  { name: 'executable first collision', tools: "[{id:'run_tests',description:'run',capability:'test-commit',inputSchema:z.object({})},{id:'run_tests',description:'legacy'}]" },
  { name: 'empty executable ID', tools: "[{id:'',description:'run',capability:'test-commit',inputSchema:z.object({})}]" },
  { name: 'invalid MCP ID', tools: "[{id:'run-tests',description:'run',capability:'test-commit',inputSchema:z.object({})}]" },
])('serve still rejects executable tools with $name', async ({ tools }) => {
  const f = await fixture();
  await writeFile(f.config, `import {z} from '${root}/node_modules/zod/index.js'; export default {
    version:'executable-tools', repos:[{id:'alpha',location:'/test/alpha'}], environments:[{id:'test',docker:{image:'controlled:image'}}],
    capabilities:[{id:'test-commit',environment:'test',validate(){},run(){},execution:{workspace:'readonly',commit(){return 'a'.repeat(40)}}}],
    tools:${tools}
  };`);
  const result = await cli(['serve', '--data', f.dir, '--config', f.config]);
  expect(result.code, result.stderr).toBe(1);
  expect(JSON.parse(result.stderr.trim())).toMatchObject({event:'service_failure',error:'Control service failed'});
  const {loadConfiguration} = await import('../src/config.js');
  await expect(loadConfiguration(f.config)).rejects.toThrow(/Invalid or duplicate tool|Invalid executable tool binding/);
});

test('service startup failures produce safe timestamped service logs without configuration secrets', async () => {
  const f = await fixture();
  await writeFile(f.config, `throw new Error('Authorization: Bearer startup-secret password=private');`);
  const result = await cli(['serve', '--data', f.dir, '--config', f.config]);
  expect(result.code).toBe(1);
  expect(result.stderr).not.toContain('startup-secret');
  expect(result.stderr).not.toContain('private');
  const event = JSON.parse(result.stderr.trim());
  expect(event).toMatchObject({ event: 'service_failure', error: 'Control service failed' });
  expect(Number.isFinite(Date.parse(event.time))).toBe(true);
});

test('background execution failures write safe service logs linked to the execution', async () => {
  const f = await fixture();
  await writeFile(f.config, `export default {version:'v1',repos:[{id:'alpha',location:'/test/alpha'}],environments:[{id:'test',docker:{image:'unused'}}],capabilities:[{id:'test-commit',environment:'test',validate(){},execution:{commit(){throw Error('Authorization: Bearer execution-secret')}},async run(){}}]};`);
  const child = await start(f);
  let errors = ''; child.stderr!.on('data',data=>errors+=data);
  const receipt = await socketCall(f.socket,{command:'submit',submission:{repo:'alpha',capability:'test-commit',input:'sha',source:'manual'}});
  await expect.poll(()=>errors).toContain('execution_failure');
  expect(errors).not.toContain('execution-secret');
  expect(JSON.parse(errors.trim())).toMatchObject({event:'execution_failure',executionId:receipt.body.executionId,error:'Control service failed'});
  await expect.poll(async()=>(await socketCall(f.socket,{command:'show',id:receipt.body.executionId})).body.execution.status).toBe('start_failed');
  const failure = (await socketCall(f.socket,{command:'show',id:receipt.body.executionId})).body.execution.startFailures[0];
  expect(failure).toMatchObject({configVersion:'v1',classification:'execution_start_failure',reason:'Execution failed before a durable attempt could start',logEvent:'execution_failure'});
  expect(Number.isFinite(Date.parse(failure.recordedAt))).toBe(true);
  await stop(child); await start(f);
  expect((await socketCall(f.socket,{command:'show',id:receipt.body.executionId})).body.execution.startFailures).toEqual([failure]);
  const retry = await socketCall(f.socket,{command:'retry',id:receipt.body.executionId,source:'operator',handling:'checked startup failure',reason:'retry',externalResults:'nothing launched'});
  expect(retry.status).toBe(200);
  await expect.poll(async()=>(await socketCall(f.socket,{command:'show',id:receipt.body.executionId})).body.execution.startFailures?.length).toBe(2);
});

test('failure bookkeeping errors remain visible in safe service logs', async () => {
  const f = await fixture();
  await writeFile(f.config, `export default {version:'v1',repos:[{id:'alpha',location:'/test/alpha'}],environments:[{id:'test',docker:{image:'unused'}}],capabilities:[{id:'test-commit',environment:'test',validate(){},execution:{commit(){throw Error('startup-secret')}},async run(){}}]};`);
  const child = await start(f);
  let errors = ''; child.stderr!.on('data',data=>errors+=data);
  const {DatabaseSync} = await import('node:sqlite');
  const db = new DatabaseSync(join(f.dir,'records.sqlite'));
  db.exec("CREATE TRIGGER no_failure BEFORE UPDATE ON executions BEGIN SELECT RAISE(FAIL,'password=save-secret'); END;");
  try {
    const receipt = await socketCall(f.socket,{command:'submit',submission:{repo:'alpha',capability:'test-commit',input:'sha',source:'manual'}});
    await expect.poll(()=>errors).toContain('execution_failure_save_failed');
    expect(errors).not.toContain('save-secret');
    expect(errors).not.toContain('startup-secret');
    expect(errors).toContain(receipt.body.executionId);
    const detail = (await socketCall(f.socket,{command:'show',id:receipt.body.executionId})).body;
    expect(detail.execution.status).toBe('queued');
    expect(detail.execution.startFailures).toBeUndefined();
  } finally {db.close();}
});

test('uncaught control service faults exit with safe evidence instead of leaking exception text', async () => {
  const f = await fixture();
  await writeFile(f.config, `setTimeout(() => { throw Error('Bearer runtime-secret'); }, 300); export default {version:'v1',repos:[],environments:[],capabilities:[]};`);
  const result = await cli(['serve','--data',f.dir,'--config',f.config]);
  expect(result.code).toBe(1);
  expect(result.stderr).not.toContain('runtime-secret');
  const events = result.stderr.trim().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  expect(events).toContainEqual(expect.objectContaining({event:'service_crash',error:'Control service failed'}));
});

test('external attention query uses CLI JSON, exposes minimal fields and fails visibly when unavailable', async () => {
  const f = await fixture();
  const service = await start(f);
  const submission = await socketCall(f.socket, {command:'submit', submission:{repo:'alpha',capability:'test-commit',input:'secret-input',source:'secret-source'}});
  const runQuery = async () => {
    const child = spawn(process.execPath, ['--import','tsx','examples/query-attention.ts','--socket',f.socket,'--repo','alpha'], {cwd:root});
    let stdout = ''; let stderr = '';
    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => stderr += data);
    const [code] = await once(child,'exit');
    return {code,stdout,stderr};
  };
  const healthy = await runQuery();
  expect(healthy.code).toBe(0);
  expect(JSON.parse(healthy.stdout)).toEqual({version:1,available:true,items:[]});
  expect(healthy.stdout).not.toContain('secret');
  await stop(service);
  const unavailable = await runQuery();
  expect(unavailable.code).toBe(1);
  expect(unavailable.stdout).toBe('');
  expect(JSON.parse(unavailable.stderr)).toEqual({version:1,available:false,error:'Control query failed'});
  expect(submission.body.accepted).toBe(true);
});

test.each(['empty','items','invalid','missing-jq','missing-channel'])('documented notification bridge handles %s without silently swallowing errors', async mode => {
  const f = await fixture();
  const {readFile} = await import('node:fs/promises');
  const readme = await readFile(join(root,'README.md'),'utf8');
  const snippet = readme.slice(readme.indexOf('umask 077\nsummary=$(mktemp)')).split('```')[0];
  const bin = join(f.dir,'bin'); await mkdir(bin);
  const marker = join(f.dir,'notified');
  await writeFile(join(bin,'node'), '#!/bin/sh\nprintf "%s\\n" \'{"version":1,"available":true,"items":[]}\'\n', {mode:0o700});
  await writeFile(join(bin,'notify-summary'), mode==='missing-channel'?'#!/bin/sh\nexit 127\n':`#!/bin/sh\ncat > ${JSON.stringify(marker)}\n`, {mode:0o700});
  if(mode !== 'missing-jq') await writeFile(join(bin,'jq'), `#!/bin/sh\n${mode==='invalid'?'exit 4':['items','missing-channel'].includes(mode)?'echo 1; exit 0':'echo 0; exit 0'}\n`, {mode:0o700});
  else await writeFile(join(bin,'jq'),'#!/bin/sh\nexit 127\n',{mode:0o700});
  const script = join(f.dir,'bridge.sh');await writeFile(script,snippet);
  const child=spawn('/bin/bash',[script],{env:{...process.env,PATH:`${bin}:/usr/bin:/bin`,DATA:f.dir}});
  let errors='';child.stderr.on('data',d=>errors+=d);
  const [code]=await once(child,'exit');
  expect(code,errors).toBe(['empty','items'].includes(mode)?0:1);
  const notified=await readFile(marker,'utf8').catch(()=>null);
  expect(notified!==null).toBe(mode==='items');
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

test.each(['repo', 'capability', 'source'])('socket rejects malformed %s fields without creating executions', async field => {
  const f = await fixture();
  await start(f);
  const submission = { repo: 'alpha', capability: 'test-commit', input: 'sha', source: 'manual' };
  for (const value of [42, '', null, false, {}, [], undefined]) {
    const result = await socketCall(f.socket, { command: 'submit', submission: { ...submission, [field]: value } });
    expect(result).toEqual({ status: 400, body: { error: `Invalid ${field}` } });
  }
  const listed = await cli(['list', '--socket', f.socket]);
  expect(JSON.parse(listed.stdout)).toEqual([]);
  const accepted = await socketCall(f.socket, { command: 'submit', submission });
  expect(accepted.status).toBe(200);
  expect(accepted.body.accepted).toBe(true);
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

test.each([false, true])('original input survives validator mutation and restart when rejected=%s', async rejected => {
  const f = await fixture();
  await writeFile(f.config, `export default { version:'v1', repos:[{id:'alpha',location:'/test/alpha'}], environments:[{id:'test'}], capabilities:[{
    id:'test-commit', environment:'test', async validate(input) {
      input.commit = 'normalized';
      await new Promise(r => setTimeout(r, 10));
      input.options.push('added');
      ${rejected ? "throw new Error('Rejected after normalization');" : ''}
    }, run() { throw new Error('Must not execute in issue 15'); }
  }] };`);
  const service = await start(f);
  const result = await cli(['submit', '--socket', f.socket, '--repo', 'alpha', '--capability', 'test-commit', '--input', '{"commit":"original","options":["submitted"]}', '--source', 'manual']);
  expect(result.code, result.stderr).toBe(0);
  const receipt = JSON.parse(result.stdout);
  expect(receipt.accepted).toBe(!rejected);
  await stop(service);
  await start(f);
  const detail = await cli(['show', receipt.requestId, '--socket', f.socket]);
  expect(detail.code, detail.stderr).toBe(0);
  expect(JSON.parse(detail.stdout)).toMatchObject({
    request: { input: { commit: 'original', options: ['submitted'] }, source: 'manual' },
    execution: rejected ? null : { id: receipt.executionId, status: 'queued' },
  });
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

test('concurrent keyed submissions return one durable receipt and conflicting content fails', async () => {
  const f = await fixture();
  const service = await start(f);
  const submission = { repo: 'alpha', capability: 'test-commit', input: 'sha', source: 'nightly', deduplicationKey: 'task:2026-10-11', scheduledAt: '2026-10-11T00:00:00Z' };
  const results = await Promise.all(Array.from({ length: 8 }, () => socketCall(f.socket, { command: 'submit', submission })));
  expect(results.every(r => r.status === 200 && r.body.accepted)).toBe(true);
  expect(new Set(results.map(r => r.body.executionId)).size).toBe(1);
  const receipt = results[0].body;
  await stop(service);
  await start(f);
  expect((await socketCall(f.socket, { command: 'submit', submission })).body).toEqual(receipt);
  const conflict = await socketCall(f.socket, { command: 'submit', submission: { ...submission, input: 'new-sha' } });
  expect(conflict).toEqual({ status: 400, body: { error: 'Deduplication key conflict' } });
  const listed = await socketCall(f.socket, { command: 'list' });
  expect(listed.body).toHaveLength(1);
  expect(listed.body[0]).toMatchObject({ request: { input: 'sha', deduplicationKey: submission.deduplicationKey, scheduledAt: submission.scheduledAt }, execution: { status: 'queued' } });
});

test('keys are source scoped, new triggers overlap, and malformed metadata is rejected', async () => {
  const f = await fixture();
  await start(f);
  const args = ['submit', '--socket', f.socket, '--repo', 'alpha', '--capability', 'test-commit', '--input', '"sha"', '--deduplication-key', 'task:slot', '--scheduled-at', '2026-10-11T00:00:00Z'];
  const first = await cli([...args, '--source', 'cron']);
  expect(first.code, first.stderr).toBe(0);
  const receipt = JSON.parse(first.stdout);
  expect(JSON.parse((await cli([...args, '--source', 'cron'])).stdout)).toEqual(receipt);
  expect(JSON.parse((await cli([...args, '--source', 'other'])).stdout).executionId).not.toBe(receipt.executionId);
  const next = await socketCall(f.socket, { command: 'submit', submission: { repo: 'alpha', capability: 'test-commit', input: 'sha', source: 'cron', deduplicationKey: 'task:next' } });
  expect(next.body.executionId).not.toBe(receipt.executionId);
  const listed = await cli(['list', '--socket', f.socket, '--source', 'cron']);
  expect(JSON.parse(listed.stdout)).toHaveLength(2);
  expect(JSON.parse(listed.stdout).every((r: any) => r.execution.status === 'queued' && r.attempts.length === 0)).toBe(true);
  for (const field of ['deduplicationKey', 'scheduledAt']) {
    for (const value of ['', null, 1, {}, false, ...(field === 'scheduledAt' ? ['yesterday', '2026-10-11', '2026-02-30T00:00:00Z', '2026-10-11T24:00:00Z'] : [])]) {
      expect(await socketCall(f.socket, { command: 'submit', submission: { repo: 'alpha', capability: 'test-commit', input: 'sha', source: 'cron', [field]: value } })).toEqual({ status: 400, body: { error: `Invalid ${field}` } });
    }
  }
});

test('a failed keyed save leaves its key available after storage recovers', async () => {
  const f = await fixture();
  await start(f);
  const submission = { repo: 'alpha', capability: 'test-commit', input: 'sha', source: 'cron', deduplicationKey: 'slot' };
  await chmod(f.dir, 0o500);
  try { expect((await socketCall(f.socket, { command: 'submit', submission })).status).toBe(400); }
  finally { await chmod(f.dir, 0o700); }
  const accepted = await socketCall(f.socket, { command: 'submit', submission });
  expect(accepted.body.accepted).toBe(true);
  expect((await socketCall(f.socket, { command: 'submit', submission })).body).toEqual(accepted.body);
  expect((await socketCall(f.socket, { command: 'list' })).body).toHaveLength(1);
});

test('key comparison uses original JSON content and every changed request field conflicts', async () => {
  const f = await fixture();
  await writeFile(f.config, `export default { version:'v1', repos:[{id:'alpha',location:'/test/alpha'}, {id:'beta',location:'/test/beta'}], environments:[{id:'test'}], capabilities:[{
    id:'test-commit', environment:'test', async validate(input) { await new Promise(r => setTimeout(r, 20)); input.sha = 'mutated'; }, run() {}
  }] };`);
  await start(f);
  const submission = { repo: 'alpha', capability: 'test-commit', input: { sha: 'original', range: [1, 2] }, source: 'timer', deduplicationKey: 'slot', scheduledAt: '2026-10-11T00:00:00Z' };
  const responses = await Promise.all(Array.from({ length: 5 }, () => socketCall(f.socket, { command: 'submit', submission })));
  expect(new Set(responses.map(r => r.body.requestId)).size).toBe(1);
  const reordered = await socketCall(f.socket, { command: 'submit', submission: { ...submission, input: { range: [1, 2], sha: 'original' } } });
  expect(reordered.body).toEqual(responses[0].body);
  for (const change of [{ repo: 'beta' }, { capability: 'missing' }, { input: { sha: 'different', range: [1, 2] } }, { input: { sha: 'original', range: [2, 1] } }, { scheduledAt: '2026-10-12T00:00:00Z' }]) {
    expect(await socketCall(f.socket, { command: 'submit', submission: { ...submission, ...change } })).toEqual({ status: 400, body: { error: 'Deduplication key conflict' } });
  }
  const detail = await socketCall(f.socket, { command: 'show', id: responses[0].body.requestId });
  expect(detail.body.request.input).toEqual({ sha: 'original', range: [1, 2] });
});

test('accepted keys survive configuration changes, while rejected submissions do not reserve keys', async () => {
  const f = await fixture();
  const service = await start(f);
  const submission = { repo: 'alpha', capability: 'test-commit', input: 'sha', source: 'timer', deduplicationKey: 'slot' };
  const rejected = await socketCall(f.socket, { command: 'submit', submission: { ...submission, input: 42 } });
  expect(rejected.body.accepted).toBe(false);
  expect((await socketCall(f.socket, { command: 'show', id: rejected.body.requestId })).body.request.deduplicationKey).toBe('slot');
  const accepted = await socketCall(f.socket, { command: 'submit', submission });
  expect(accepted.body.accepted).toBe(true);
  await stop(service);
  await writeFile(f.config, `export default { version:'v2', repos:[], environments:[], capabilities:[] };`);
  await start(f);
  expect((await socketCall(f.socket, { command: 'submit', submission })).body).toEqual(accepted.body);
});

test('existing pre-key databases remain readable and writable after upgrade', async () => {
  const f = await fixture();
  const legacyRoot = await mkdtemp(join(tmpdir(), 'orch-legacy-'));
  directories.push(legacyRoot);
  const { execFileSync } = await import('node:child_process');
  await mkdir(join(legacyRoot, 'src'));
  for (const file of ['cli.ts', 'control.ts', 'config.ts', 'records.ts', 'paths.ts', 'lock.ts']) {
    await writeFile(join(legacyRoot, 'src', file), execFileSync('git', ['show', `35d4200:src/${file}`], { cwd: root }));
  }
  await writeFile(join(legacyRoot, 'package.json'), '{"type":"module"}');
  await symlink(join(root, 'node_modules'), join(legacyRoot, 'node_modules'));
  const legacy = spawn(process.execPath, ['--import', 'tsx', join(legacyRoot, 'src/cli.ts'), 'serve', '--data', f.dir, '--config', f.config], { cwd: root });
  children.add(legacy);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Legacy service did not start')), 5000);
    legacy.stdout.on('data', chunk => { if (String(chunk).includes('ready')) { clearTimeout(timer); resolve(); } });
    legacy.once('exit', () => { clearTimeout(timer); reject(new Error('Legacy service exited')); });
  });
  const submission = { repo: 'alpha', capability: 'test-commit', input: 'old-sha', source: 'manual' };
  const old = await socketCall(f.socket, { command: 'submit', submission });
  expect(old.body.accepted).toBe(true);
  await stop(legacy);
  await start(f);
  expect((await socketCall(f.socket, { command: 'show', id: old.body.requestId })).body).toMatchObject({ request: { input: 'old-sha', deduplicationKey: null, scheduledAt: null }, execution: { id: old.body.executionId, status: 'queued' } });
  expect((await socketCall(f.socket, { command: 'submit', submission: { ...submission, deduplicationKey: 'new-key' } })).body.accepted).toBe(true);
  expect((await socketCall(f.socket, { command: 'list' })).body).toHaveLength(2);
});

test('explicit execution exposes saved attempt facts through CLI', async () => {
  const f = await fixture();
  await writeFile(f.config, `export default { version:'config-v2', repos:[{id:'alpha',location:'/test/alpha'}],
    environments:[{id:'test',docker:{image:'node:22.22-alpine'}}], capabilities:[{
      id:'test-commit',environment:'test',validate(){}, execution:{commit(input){return input}},
      async run(ctx){return {business:{passed:true}}}
    }] };`);
  await start(f);
  const submitted = await socketCall(f.socket, { command:'submit', submission:{repo:'alpha',capability:'test-commit',input:'a'.repeat(40),source:'manual'} });
  expect(submitted.body.accepted).toBe(true);
  let detail: any;
  for (let i=0;i<50;i++) {
    detail = JSON.parse((await cli(['show',submitted.body.executionId,'--socket',f.socket])).stdout);
    if (detail.attempts.length && detail.execution.status !== 'starting') break;
    await new Promise(r=>setTimeout(r,20));
  }
  expect(detail.attempts).toHaveLength(1);
  expect(detail.attempts[0]).toMatchObject({configVersion:'config-v2',capability:'test-commit',environment:'test',runState:'start_failed'});
  const query = spawn(process.execPath,['--import','tsx','examples/query-attention.ts','--socket',f.socket],{cwd:root});
  let output = ''; query.stdout.on('data',data=>output+=data);
  const [code] = await once(query,'exit');
  expect(code).toBe(0);
  expect(JSON.parse(output).items).toEqual([{requestId:submitted.body.requestId,executionId:submitted.body.executionId,status:'start_failed',attemptId:detail.attempts[0].id,reasons:['failed']}]);
});
