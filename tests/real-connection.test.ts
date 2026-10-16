import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const realConnectionTest = process.env.ORCH_REAL_CONNECTION === '1' ? test : test.skip;
const image = 'sha256:0bb6dcc78a58bcded4f7da20771bcdb8edb1c65048e9bc7e383d8c4e668bd193';
const docker = (...args: string[]) => execFileSync('docker', args, {encoding: 'utf8', timeout: 15000, env: {PATH: '/usr/local/bin:/usr/bin:/bin'}}).trim();

// Real Docker + original Claude Code, but a test-owned Messages server, never a model service.
realConnectionTest('real container role execution uses live connections, native model selection and safe evidence', async () => {
  docker('image', 'inspect', image, '--format', '{{.Id}}'); // Never pull or substitute an image.
  const directory = await mkdtemp(join(tmpdir(), 'issue-80-real-'));
  const repo = join(directory, 'repo'), data = join(directory, 'data'), configDir = join(directory, 'config');
  await Promise.all([repo, data, configDir].map(path => mkdir(path)));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], {encoding: 'utf8'}).trim();
  git('init', '-q');
  await writeFile(join(repo, 'context.txt'), 'Non-sensitive fixed repository for issue 80.\n');
  git('add', '.'); git('-c', 'user.name=Acceptance', '-c', 'user.email=acceptance@example.invalid', 'commit', '-qm', 'Fixed acceptance context');
  const sha = git('rev-parse', 'HEAD');
  const network = `issue-80-${randomUUID()}`;
  const tokenA = randomUUID(), tokenB = randomUUID(), header = randomUUID();
  const secrets = [tokenA, tokenB, header];
  const receipts: any[] = [];
  const attempts: any[] = [];
  const requests: {model: string; peer: string; path: string; selectedAuth: boolean; selectedHeader: boolean}[] = [];
  let releaseFirst: (() => void) | undefined;
  const endpointServer = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) { res.writeHead(404).end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    const expectedToken = requests.length === 0 ? tokenA : tokenB;
    requests.push({model: input.model, peer: req.socket.remoteAddress!, path: req.url!, selectedAuth: req.headers.authorization === `Bearer ${expectedToken}`, selectedHeader: req.headers['x-acceptance'] === header});
    if (requests.length === 1) await new Promise<void>(resolve => { releaseFirst = resolve; });
    const text = JSON.stringify({summary: 'controlled Messages response', diagnostic: expectedToken, header});
    const message = {id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: input.model, content: [], stop_reason: null, stop_sequence: null, usage: {input_tokens: 10, output_tokens: 0}};
    res.writeHead(200, {'content-type': 'text/event-stream'});
    const event = (type: string, fields: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({type, ...fields})}\n\n`);
    event('message_start', {message});
    event('content_block_start', {index: 0, content_block: {type: 'text', text: ''}});
    event('content_block_delta', {index: 0, delta: {type: 'text_delta', text}});
    event('content_block_stop', {index: 0});
    event('message_delta', {delta: {stop_reason: 'end_turn', stop_sequence: null}, usage: {output_tokens: 20}});
    event('message_stop', {}); res.end();
  });
  const source = join(configDir, 'selected.json'), config = join(configDir, 'config.mts');
  // Deliberately do not inherit host credentials, proxy settings, Docker contexts or HOME.
  const env = {PATH: '/usr/local/bin:/usr/bin:/bin', HOME: directory};
  let stderr = '', stdout = '';
  let control: ReturnType<typeof spawn> | undefined;
  let submissions = 0, networkCreated = false;
  const socket = join(data, 'control.sock');
  const cli = async (...args: string[]) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args, '--socket', socket], {cwd: root, env});
    let out = '', error = '';
    child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
    const [code] = await once(child, 'exit');
    for (const secret of secrets) { expect(out).not.toContain(secret); expect(error).not.toContain(secret); }
    expect(code, error).toBe(0); return JSON.parse(out);
  };
  const safeFiles = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, {withFileTypes: true})) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await safeFiles(file);
      else if (entry.isFile()) for (const secret of secrets) expect((await readFile(file)).includes(Buffer.from(secret)), file).toBe(false);
    }
  };
  try {
    docker('network', 'create', '--internal', ...(process.env.ORCH_CONNECTION_SUBNET ? ['--subnet', process.env.ORCH_CONNECTION_SUBNET] : []), network); networkCreated = true;
    const gateway = docker('network', 'inspect', network, '--format', '{{(index .IPAM.Config 0).Gateway}}');
    endpointServer.listen(0, gateway); await once(endpointServer, 'listening');
    const endpoint = `http://${gateway}:${(endpointServer.address() as {port: number}).port}`;
    const select = (model: string, token: string) => writeFile(source, JSON.stringify({env: {ANTHROPIC_BASE_URL: endpoint, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_MODEL: model, ANTHROPIC_CUSTOM_HEADERS: `X-Acceptance: ${header}`}}));
    await select('backend-a', tokenA);
    await writeFile(config, `import {claudeCode} from ${JSON.stringify(join(root, 'src/connection.ts'))};
export default {version:'issue-80-real-v1',repos:[{id:'repo',location:${JSON.stringify(repo)}}],capabilities:[],
environments:[{id:'readonly',docker:{image:${JSON.stringify(image)},network:${JSON.stringify(network)}}}],
providers:[{id:'inherited',agent:claudeCode(undefined,{permissionMode:'dontAsk'}),connection:{source:'settings',path:${JSON.stringify(source)}}},{id:'explicit',agent:claudeCode('backend-override',{permissionMode:'dontAsk'}),connection:{source:'settings',path:${JSON.stringify(source)}}}],
roles:['inherited','explicit'].map(id=>({id,description:'Controlled connection acceptance',validate(){},buildPrompt(){return 'Return the controlled endpoint response. Do not call tools.'},skills:[],tools:[],validateReport(output){return JSON.parse(output)}})),
roleBindings:['inherited','explicit'].map(id=>({role:id,provider:id,environment:'readonly',commit(){return '${sha}'}}))};`);
    control = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'serve', '--config', config, '--data', data], {cwd: root, env});
    control.stdout!.on('data', chunk => { stdout += chunk; }); control.stderr!.on('data', chunk => { stderr += chunk; });
    await expect.poll(() => stdout, {timeout: 10000}).toContain('ready');
    const submit = async (role: string) => {
      submissions++;
      const receipt = await cli('submit', '--repo', 'repo', '--capability', role, '--input', 'null', '--source', 'issue-80-acceptance');
      receipts.push(receipt); expect(receipt.accepted).toBe(true); return receipt;
    };
    const finish = async (receipt: any) => {
      let detail: any;
      await expect.poll(async () => {
        detail = await cli('show', receipt.executionId);
        return detail.execution.status;
      }, {timeout: 45000, interval: 300}).toMatch(/^(completed|start_failed|unknown)$/);
      const attempt = detail.attempts.at(-1); attempts.push(attempt);
      expect(detail.execution.status, JSON.stringify(attempt)).toBe('completed');
      expect(attempt).toMatchObject({actualSha: sha, exitCode: 0, contract: 'valid', stopConfirmation: {kind: 'agent-exit-marker'}, business: {summary: 'controlled Messages response', diagnostic: '[REDACTED]', header: '[REDACTED]'}});
      expect(attempt.error).toBeUndefined();
      expect(attempt.iterations[0].sessionFilePath).toBeTruthy();
      expect((await readFile(attempt.iterations[0].sessionFilePath, 'utf8'))).toContain('[REDACTED]');
      await cli('logs', receipt.executionId);
      const state = JSON.parse(docker('inspect', attempt.container, '--format', '{{json .HostConfig}}'));
      expect(state.ReadonlyRootfs).toBe(true); expect(state.NetworkMode).toBe(network);
      expect(state.CapDrop).toContain('ALL'); expect(state.SecurityOpt).toContain('no-new-privileges');
      const mounts = JSON.parse(docker('inspect', attempt.container, '--format', '{{json .Mounts}}'));
      expect(mounts.length).toBeGreaterThan(0); expect(mounts.every((mount: any) => !mount.RW)).toBe(true);
      expect(docker('exec', attempt.container, 'git', '-C', '/home/agent/workspace', 'rev-parse', 'HEAD')).toBe(sha);
      expect(docker('top', attempt.container, '-eo', 'pid,comm')).not.toMatch(/claude|node/);
      return attempt;
    };
    const first = await submit('inherited');
    await expect.poll(() => requests.length, {timeout: 45000}).toBe(1);
    await select('backend-b', tokenB); releaseFirst!();
    await finish(first);
    await finish(await submit('inherited'));
    await finish(await submit('explicit'));
    expect(requests.map(request => request.model)).toEqual(['backend-a', 'backend-b', 'backend-override']);
    expect(requests.every(request => request.selectedAuth && request.selectedHeader)).toBe(true);
    const containerIPs = attempts.map(attempt => docker('inspect', attempt.container, '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'));
    expect(requests.map(request => request.peer)).toEqual(containerIPs);
    expect(git('status', '--porcelain')).toBe('');
    for (const secret of secrets) { expect(stdout).not.toContain(secret); expect(stderr).not.toContain(secret); }
    await safeFiles(data);
    const evidence = {baseline: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(), image, sha, requests, attempts: attempts.map(({id, container, exitCode, stopConfirmation, iterations, business}) => ({id, container, exitCode, stopConfirmation, iterations, business})), secretsAbsentFromDataAndSessions: true};
    await safeFiles(join(directory, '.claude'));
    await writeFile(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
    process.stdout.write(`Issue #80 real Docker evidence: ${directory}\n`);
  } finally {
    releaseFirst?.();
    // Missing receipts or process/exit evidence are not permission to kill a live execution.
    let safe = submissions === 0;
    const stopped: {container: string; running: boolean}[] = [];
    try {
      if (submissions > 0 && receipts.length === submissions) {
        const details = await Promise.all(receipts.map(receipt => cli('show', receipt.executionId)));
        safe = details.every(detail => detail.attempts.length === 1 && detail.attempts[0].stopConfirmation?.kind === 'agent-exit-marker' && !/claude|node/.test(docker('top', detail.attempts[0].container, '-eo', 'pid,comm')));
        if (safe) for (const detail of details) {
          const container = detail.attempts[0].container;
          docker('stop', container);
          const running = docker('inspect', container, '--format', '{{.State.Running}}') !== 'false';
          stopped.push({container, running});
          if (running) safe = false;
        }
      }
    } catch { safe = false; }
    if (safe) {
      if (control && control.exitCode === null && control.signalCode === null) { const exited = once(control, 'exit'); control.kill('SIGTERM'); await exited; }
      endpointServer.closeAllConnections(); await new Promise<void>(resolve => endpointServer.close(() => resolve()));
      // Stopped evidence containers remain available for inspection; their network remains attached.
      if (networkCreated && submissions === 0) docker('network', 'rm', network);
      await writeFile(join(directory, 'cleanup.json'), JSON.stringify({stopped, controlExited: !control || control.exitCode !== null || control.signalCode !== null, endpointClosed: true}, null, 2));
    } else {
      process.stderr.write(`Unconfirmed execution: no forced container/control stop; inspect evidence at ${directory}. The test runner may close the controlled endpoint.\n`);
      // ponytail: endpoint lifetime is limited to this worker; use a standalone acceptance process if failure-path retention is required.
      throw Error('Acceptance cleanup unconfirmed; inspect retained container and control service');
    }
  }
}, 180000);
