import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, expect, test } from 'vitest';
import { call } from '../src/control.js';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const root = resolve(import.meta.dirname, '..');
const dirs: string[] = [];
const children: ChildProcess[] = [];
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  }));
  await Promise.all(servers.splice(0).map(async server => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }));
  await Promise.all(dirs.splice(0).map(dir => rm(dir, {recursive: true, force: true})));
});
async function temporary() { const dir = await mkdtemp(join(tmpdir(), 'orch-connection-')); dirs.push(dir); return dir; }

const fixtureSecrets = ['fixture-token-a', 'fixture-token-b', 'fixture-header-secret', 'stale-token', 'stale-key', 'host-token-must-not-win', 'host-key-must-not-win', 'fixture-conflict-secret'];
async function assertNoSecrets(directory: string) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await assertNoSecrets(path);
    else if (entry.isFile()) {
      const bytes = await readFile(path);
      for (const secret of fixtureSecrets) expect(bytes.includes(Buffer.from(secret)), path).toBe(false);
    }
  }
}

type FixtureOptions = { model?: string; source?: 'settings' | 'environment'; settings?: unknown; missing?: boolean; session?: Buffer; host?: Record<string, string>; holdFirst?: boolean; tool?: boolean; executable?: boolean; managedSettings?: boolean };
async function connectionFixture(options: FixtureOptions = {}) {
  const fixture = await temporary(), data = await temporary(), repo = await temporary();
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
  git('init'); await writeFile(join(repo, 'context.txt'), 'fixed context'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'first');
  const sha = git('rev-parse', 'HEAD');
  const requests: any[] = [];
  let release: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    if (options.holdFirst && requests.length === 1) await new Promise<void>(resolve => { release = resolve; });
    res.end(JSON.stringify({summary: 'controlled endpoint report 中文🧪', diagnostic: requests.at(-1).token ?? requests.at(-1).key}));
  });
  servers.push(server);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  const source = join(fixture, 'selected.json');
  const settings = (model: string, token: string) => ({
    env: {ANTHROPIC_BASE_URL: endpoint, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: `${model}-sonnet`, ANTHROPIC_CUSTOM_HEADERS: 'X-Connection: fixture-header-secret',
      ANTHROPIC_NOT_A_CONNECTION_FIELD: 'do-not-project'},
    hooks: {SessionStart: [{command: 'must-not-run'}]}, permissions: {allow: ['Bash(*)']},
  });
  const select = (model: string, token: string) => writeFile(source, JSON.stringify(settings(model, token)));
  if (!options.missing) await writeFile(source, typeof options.settings === 'string' ? options.settings : JSON.stringify(options.settings ?? settings('backend-a', 'fixture-token-a')));
  const sessionSource = join(fixture, 'session-source');
  if (options.session) await writeFile(sessionSource, options.session);
  // The runtime env transport is deliberately secret-bearing and outside the data directory.
  const docker = join(fixture, 'docker'), calls = join(fixture, 'calls.jsonl');
  await writeFile(docker, `#!${process.execPath}
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const args=process.argv.slice(2);
const state=${JSON.stringify(join(fixture, 'runtime.json'))};
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(args[0]==='run') {
  const env={PATH:process.env.PATH};
  for(let i=0;i<args.length;i++)if(args[i]==='--env'){const value=args[++i],at=value.indexOf('=');if(at<0)env[value]=process.env[value];else env[value.slice(0,at)]=value.slice(at+1);}
  fs.writeFileSync(state,JSON.stringify(env));console.log('controlled-container');
} else if(args[0]==='exec') {
  const command=args.at(-1);
  if(command.includes('ORCH_CONNECTION_CHECK')) process.stdout.write(${JSON.stringify(options.managedSettings ? 'unsupported' : 'ready')});
  else if(args.includes('cat')&&args.includes('--')) {
    const bytes=fs.readFileSync(${JSON.stringify(sessionSource)});
    // Separate writes force a credential to straddle transport chunks.
    process.stdout.write(bytes.subarray(0,8192));setTimeout(()=>process.stdout.end(bytes.subarray(8192)),30);
  } else if(command.includes('ORCH_EXIT_')) {
    const env=JSON.parse(fs.readFileSync(state));
    ${options.tool ? `env.ORCHESTRATOR_TOOL_SOCKET=${JSON.stringify(join(data,'attempts'))}+ '/' + args[args.indexOf('--workdir')+2].slice(5,-2) + '/tools/tools.sock';` : ''}
    const result=spawnSync('sh',['-c',command],{env,input:fs.readFileSync(0),encoding:'utf8'});
    const output=Buffer.from(result.stdout||'');
    const split=output.indexOf(Buffer.from('中'))+1;
    process.stdout.write(output.subarray(0,split));
    setTimeout(()=>{process.stdout.write(output.subarray(split));process.stderr.write(result.stderr||'');process.exit(result.status??1);},30);
  } else if(args.includes('rev-parse')||command.includes('rev-parse'))console.log(${JSON.stringify(sha)});
}
`, {mode: 0o700});
  await writeFile(join(fixture, 'claude'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(join(root, 'node_modules/tsx/dist/loader.mjs'))} ${JSON.stringify(join(root, 'tests/fixtures/connection-harness.ts'))} "$@"\n`, {mode: 0o700});
  const config = join(fixture, 'config.mts');
  await writeFile(config, `import {claudeCode} from ${JSON.stringify(join(root, 'src/connection.ts'))};
import {join} from 'node:path';
${options.executable ? `import {z} from ${JSON.stringify(join(root, 'node_modules/zod/index.js'))};` : ''}
const agent=claudeCode(${JSON.stringify(options.model) ?? 'undefined'},{captureSessions:${!!options.session}});
${options.session ? "agent.sessionStorage={async captureToHost({hostCwd,handle}){await handle.copyFileOut('/home/agent/session',join(hostCwd,'captured-session'))},hostSessionFilePath(cwd){return join(cwd,'captured-session')},async readHostSession(){return undefined}};" : ''}
export default {version:'connection-fixture-v1',repos:[{id:'repo',location:${JSON.stringify(repo)}}],environments:[{id:'env',docker:{image:'controlled:image',binary:${JSON.stringify(docker)},network:'bridge',env:{PATH:${JSON.stringify(`${fixture}:/usr/bin:/bin`)},${options.tool ? "ORCHESTRATOR_TOOL_SOCKET:'/controlled/tools.sock'," : ''}ANTHROPIC_AUTH_TOKEN:'stale-token',ANTHROPIC_API_KEY:'stale-key',ANTHROPIC_MODEL:'stale-model'}}}],capabilities:${options.executable ? `[{id:'inspect-capability',environment:'env',validate(){},execution:{workspace:'readonly',commit(){return '${sha}'}},run(){throw Error('Rejected input must not execute')}}]` : '[]'},
providers:[{id:'claude',agent,${options.executable ? "mcp:'claude-code'," : ''}connection:${JSON.stringify(options.source === 'environment' ? {source: 'environment'} : {source: 'settings', path: source})}}],
${options.executable ? "tools:[{id:'inspect',description:'Inspect executable tool',capability:'inspect-capability',inputSchema:z.object({token:z.string()}).strict()}]," : options.tool ? "tools:[{id:'inspect',description:'Inspect tool',async read(input){return {diagnostic:input.token}}}]," : ''}
roles:[{id:'report',description:'Read-only report',validate(){},buildPrompt(){return 'Inspect the fixed repository'},skills:[],tools:${options.tool || options.executable ? "['inspect']" : '[]'},validateReport(output){return JSON.parse(output)}}],
roleBindings:[{role:'report',provider:'claude',environment:'env',commit(){return '${sha}'}}]};`);
  // Allowlist the child environment: never inherit real provider credentials, proxies or opt-ins.
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'serve', '--config', config, '--data', data], {cwd: root,
    env: {PATH: `${fixture}:/usr/bin:/bin`, HOME: fixture, ORCH_REAL_MCP: '', ORCH_REAL: '',
      ANTHROPIC_AUTH_TOKEN: 'host-token-must-not-win', ANTHROPIC_API_KEY: 'host-key-must-not-win',
      ...(options.source === 'environment' ? {ANTHROPIC_BASE_URL: endpoint} : {}), ...options.host}});
  children.push(child);
  let stderr = ''; child.stderr!.on('data', chunk => { stderr += chunk; });
  const socket = join(data, 'control.sock');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(stderr || 'not ready')), 10000);
    child.stdout!.on('data', chunk => { if (String(chunk).includes('ready')) { clearTimeout(timer); resolve(); } });
    child.once('exit', () => { clearTimeout(timer); reject(Error(stderr || 'service exited')); });
  });
  const submit = () => call(socket, {command: 'submit', submission: {repo: 'repo', capability: 'report', input: null, source: 'fixture'}}) as Promise<any>;
  const detail = (receipt: any) => call(socket, {command: 'show', id: receipt.executionId}) as Promise<any>;
  const settled = async (receipt: any, status = 'completed') => {
    await expect.poll(async () => (await detail(receipt)).execution.status, {timeout: 10000}).toBe(status);
    return detail(receipt);
  };
  const safe = async (receipts: any[]) => {
    for (const receipt of receipts) {
      const evidence = JSON.stringify({detail: await detail(receipt), logs: await call(socket, {command: 'logs', id: receipt.executionId})});
      for (const secret of fixtureSecrets) expect(evidence).not.toContain(secret);
    }
    for (const secret of fixtureSecrets) {
      expect(stderr).not.toContain(secret);
      expect(await readFile(calls, 'utf8').catch(() => '')).not.toContain(secret);
    }
    await assertNoSecrets(data);
  };
  return {data, fixture, requests, endpoint, source, calls, select, submit, detail, settled, safe, release: () => release?.()};
}

test('role execution reads the selected live connection once per attempt and inherits its model', async () => {
  const f = await connectionFixture({holdFirst: true});
  const first = await f.submit();
  try {
    await expect.poll(() => f.requests.length).toBe(1);
    await f.select('backend-b', 'fixture-token-b');
    expect(f.requests[0]).toMatchObject({modelArgument: null, settingSources: '', model: 'backend-a', sonnet: 'backend-a-sonnet', token: 'fixture-token-a', headers: 'X-Connection: fixture-header-secret'});
    expect(f.requests[0].key).toBeUndefined(); expect(f.requests[0].unrelated).toBeUndefined();
  } finally { f.release(); }
  await f.settled(first);
  const second = await f.submit(); await f.settled(second);
  expect(f.requests).toHaveLength(2);
  expect(f.requests[1]).toMatchObject({modelArgument: null, model: 'backend-b', token: 'fixture-token-b'});
  for (const receipt of [first, second]) expect((await f.detail(receipt)).attempts[0].business).toEqual({summary: 'controlled endpoint report 中文🧪', diagnostic: '[REDACTED]'});
  await f.safe([first, second]);
}, 30000);

test('role tool observations filter known credentials before persistence', async () => {
  const f = await connectionFixture({tool:true});
  const receipt = await f.submit(); const detail = await f.settled(receipt);
  const observation=JSON.parse((await readFile(join(detail.attempts[0].workspace,'..','artifacts','observations.jsonl'),'utf8')).trim());
  expect(observation).toMatchObject({tool:'inspect',input:{token:'[REDACTED]'},result:{diagnostic:'[REDACTED]'}});
  await f.safe([receipt]);
},20000);

test('executable MCP tool rejects known connection secrets before recording a call', async () => {
  const f = await connectionFixture({executable: true, holdFirst: true});
  const receipt = await f.submit();
  const client = new Client({name: 'connection-acceptance', version: '1'});
  try {
    await expect.poll(() => f.requests.length, {timeout: 10000}).toBe(1);
    const detail = await f.detail(receipt);
    const directory = detail.attempts[0].mcpDirectory;
    expect(directory).toBeTruthy();
    await client.connect(new StdioClientTransport({command: process.execPath, args: [join(directory, 'bridge.cjs'), join(directory, 'tools.sock')]}));
    const result = await client.callTool({name: 'inspect', arguments: {token: 'fixture-token-a'}});
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('fixture-token-a');
    expect((await f.detail(receipt)).attempts[0].toolCalls).toEqual([]);
    await f.safe([receipt]);
  } finally {
    await client.close();
    f.release();
  }
  const detail = await f.settled(receipt);
  expect(detail.attempts[0].toolCalls).toEqual([]);
  await f.safe([receipt]);
}, 20000);

test('container managed settings fail closed before contacting the selected endpoint', async () => {
  const f = await connectionFixture({managedSettings: true});
  const receipt = await f.submit();
  const detail = await f.settled(receipt, 'unknown');
  expect(detail.attempts[0].error).toMatch(/managed settings/i);
  expect(detail.attempts[0].container).toMatch(/^orch-/);
  expect(f.requests).toHaveLength(0);
  const calls = await readFile(f.calls, 'utf8');
  expect(calls).toContain('ORCH_CONNECTION_CHECK');
  expect(calls).not.toContain('ORCH_EXIT_');
  await f.safe([receipt]);
}, 20000);

test('explicit provider model reaches the CLI unchanged, including shell quotes', async () => {
  const model = `backend 'quoted' "double" ; $(must-not-run)`;
  const f = await connectionFixture({model});
  const receipt = await f.submit(); await f.settled(receipt);
  expect(f.requests[0]).toMatchObject({modelArgument: model, model: 'backend-a'});
  await f.safe([receipt]);
}, 20000);

test('environment connection uses only explicitly authorized host connection fields', async () => {
  const f = await connectionFixture({source: 'environment', host: {ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: 'host-authorized-model'}});
  const receipt = await f.submit(); await f.settled(receipt);
  expect(f.requests[0]).toMatchObject({modelArgument: null, model: 'host-authorized-model', token: 'host-token-must-not-win'});
  expect(f.requests[0].key).toBeUndefined();
  expect(f.requests[0].headers).toBeUndefined();
  expect((await f.detail(receipt)).attempts[0].business.diagnostic).toBe('[REDACTED]');
  await f.safe([receipt]);
}, 20000);

test.each([false, true])('settings top-level model fallback respects env precedence: %s', async override => {
  const f = await connectionFixture();
  await writeFile(f.source, JSON.stringify({model: 'top-level-model', env: {ANTHROPIC_BASE_URL: f.endpoint, ANTHROPIC_AUTH_TOKEN: 'fixture-token-a', ...(override ? {ANTHROPIC_MODEL: 'env-model'} : {})}}));
  const receipt = await f.submit(); await f.settled(receipt);
  expect(f.requests[0]).toMatchObject({modelArgument: null, model: override ? 'env-model' : 'top-level-model'});
  await f.safe([receipt]);
}, 20000);

const conflicts = [
  ['helper', {apiKeyHelper: 'echo fixture-conflict-secret'}],
  ['OAuth', {env: {CLAUDE_CODE_OAUTH_TOKEN: 'fixture-conflict-secret'}}],
  ['cloud', {env: {CLAUDE_CODE_USE_BEDROCK: '1'}}],
  ['disabled TLS verification', {env: {NODE_TLS_REJECT_UNAUTHORIZED: '0'}}],
  ['malformed JSON', '{"env":"fixture-conflict-secret"'],
  ['malformed env', {env: 'fixture-conflict-secret'}],
  ['malformed field', {env: {ANTHROPIC_MODEL: 42}}],
  ['custom authorization header', {env: {ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer fixture-conflict-secret'}}],
  ['custom API key header', {env: {ANTHROPIC_CUSTOM_HEADERS: 'x-api-key: fixture-conflict-secret'}}],
  ['malformed custom header', {env: {ANTHROPIC_CUSTOM_HEADERS: 'fixture-conflict-secret'}}],
  ['conflicting auth', {env: {ANTHROPIC_API_KEY: 'fixture-conflict-secret'}}],
] as const;
test.each(conflicts)('selected %s conflict fails before Docker with safe evidence', async (_name, conflict) => {
  const f = await connectionFixture();
  const valid = {ANTHROPIC_BASE_URL: f.endpoint, ANTHROPIC_AUTH_TOKEN: 'fixture-token-a'};
  const selected: any = conflict;
  await writeFile(f.source, typeof selected === 'string' ? selected : JSON.stringify({...selected, env: typeof selected.env === 'object' ? {...valid, ...selected.env} : 'env' in selected ? selected.env : valid}));
  const receipt = await f.submit(); await f.settled(receipt, 'start_failed');
  const detail = await f.detail(receipt);
  expect(detail.attempts[0].error).toMatch(/selected|connection|settings/i);
  expect(await readFile(f.calls, 'utf8').catch(() => '')).toBe('');
  expect(f.requests).toHaveLength(0);
  await f.safe([receipt]);
}, 20000);

test('missing selected settings fail closed rather than falling back to host identity', async () => {
  const f = await connectionFixture({missing: true});
  const receipt = await f.submit(); await f.settled(receipt, 'start_failed');
  expect((await f.detail(receipt)).attempts[0].error).toMatch(/settings unavailable|settings.*invalid/i);
  expect(await readFile(f.calls, 'utf8').catch(() => '')).toBe('');
  expect(f.requests).toHaveLength(0);
  await f.safe([receipt]);
}, 20000);

test.each(['split-secret', 'binary'])('native provider session export preserves safe %s bytes through the role seam', async mode => {
  const session = mode === 'binary' ? Buffer.from([0, 255, 254, 128, 1, 10, 13, 240, 159, 146, 169]) : Buffer.from('x'.repeat(8185) + 'fixture-token-a' + '\nfixture-header-secret\nend');
  const f = await connectionFixture({session});
  const receipt = await f.submit(); const detail = await f.settled(receipt);
  expect(detail.attempts[0].error).toBeUndefined();
  const path = detail.attempts[0].iterations[0].sessionFilePath;
  expect(path).toBe(join(detail.attempts[0].workspace, 'captured-session'));
  const exported = await readFile(path);
  const expected = mode === 'binary' ? session : Buffer.from(session.toString().replaceAll('fixture-token-a', '[REDACTED]').replaceAll('fixture-header-secret', '[REDACTED]'));
  expect(exported.equals(expected)).toBe(true);
  expect(await readFile(f.calls, 'utf8')).toContain('"cat","--","/home/agent/session"');
  await f.safe([receipt]);
}, 20000);
