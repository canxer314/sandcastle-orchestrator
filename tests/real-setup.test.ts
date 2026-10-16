import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const exec = promisify(execFile);
const realSetup = process.env.ORCH_REAL_SETUP === '1' ? test : test.skip;

// Opt-in authorizes image build/downloads and real Docker, never private settings or a model API.
realSetup('generated setup commands produce a fixed-SHA readonly report in Docker with the explicitly selected image', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'issue-82-container-'));
  const home = join(directory, 'home'), repo = join(directory, 'sample'), prefix = join(directory, 'prefix');
  await mkdir(home); await mkdir(repo);
  const env = {PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, HOME: home};
  const secrets: string[] = [];
  const redact = (text: string) => secrets.reduce((output, secret) => output.replaceAll(secret, '[REDACTED]'), text);
  const run = async (binary: string, args: string[], cwd = directory, timeout = 30000) => {
    try {return (await exec(binary, args, {cwd, env, timeout, maxBuffer: 8 * 1024 * 1024})).stdout.trim();}
    catch {throw Error('Acceptance command failed; inspect retained resources without publishing credentials');}
  };
  const docker = (...args: string[]) => run('docker', args);
  const git = (...args: string[]) => run('git', ['-C', repo, ...args]);
  await git('init', '-q');
  await writeFile(join(repo, 'README.md'), '# Fixed sample\nThe entry module calls describeProject. Committed marker: SETUP_PINNED_82.\n');
  await git('add', '.'); await git('-c', 'user.name=Acceptance', '-c', 'user.email=acceptance@example.invalid', 'commit', '-qm', 'fixed context');
  const sha = await git('rev-parse', 'HEAD');
  await writeFile(join(repo, 'README.md'), 'Uncommitted marker: SETUP_DIRTY_82\n');
  // Build with already installed development dependencies, then pack without invoking Corepack in the isolated HOME.
  await run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], root);
  await chmod(join(root, 'dist/cli.js'), 0o755);
  const packed = Object.values(JSON.parse(await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], root, 120000)))[0] as {filename: string};
  await run('npm', ['install', '--global', '--prefix', prefix, '--omit=dev', '--no-audit', '--no-fund', ...(process.env.ORCH_SETUP_NPM_CACHE ? ['--offline', '--cache', process.env.ORCH_SETUP_NPM_CACHE] : []), join(directory, packed.filename)], directory, 180000);
  const bin = join(prefix, 'bin/sandcastle-orchestrator');
  const token = randomUUID(), header = randomUUID();
  secrets.push(token, header);
  const source = join(directory, 'synthetic-settings.json');
  const gateway = JSON.parse(await docker('network', 'inspect', 'bridge'))[0].IPAM.Config[0].Gateway;
  const requests: {peer: string; model: string; authenticated: boolean; readCommittedFile: boolean}[] = [];
  const report = 'README.md: the entry module calls describeProject. Fixed marker SETUP_PINNED_82. Controlled endpoint analysis, not test evidence.';
  const endpoint = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {res.writeHead(404).end(); return;}
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      const results = input.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []).filter((block: any) => block.type === 'tool_result');
      const committed = results.some((block: any) => JSON.stringify(block.content).includes('SETUP_PINNED_82') && !JSON.stringify(block.content).includes('SETUP_DIRTY_82'));
      requests.push({peer: req.socket.remoteAddress!, model: input.model, authenticated: req.headers.authorization === `Bearer ${token}` && req.headers['x-acceptance'] === header, readCommittedFile: committed});
      if (requests.length > 4) {res.writeHead(400).end(); return;}
      const tool = !committed;
      const content = tool ? {type: 'tool_use', id: 'tool_setup_read', name: 'Read', input: {file_path: '/home/agent/workspace/README.md'}} : {type: 'text', text: `${report}\nCredential echo: ${token}; ${header}`};
      res.writeHead(200, {'content-type': 'text/event-stream'});
      const event = (type: string, fields: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({type, ...fields})}\n\n`);
      event('message_start', {message: {id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: input.model, content: [], stop_reason: null, stop_sequence: null, usage: {input_tokens: 20, output_tokens: 0}}});
      event('content_block_start', {index: 0, content_block: tool ? {...content, input: {}} : {type: 'text', text: ''}});
      event('content_block_delta', {index: 0, delta: tool ? {type: 'input_json_delta', partial_json: JSON.stringify(content.input)} : {type: 'text_delta', text: content.text}});
      event('content_block_stop', {index: 0});
      event('message_delta', {delta: {stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null}, usage: {output_tokens: 40}});
      event('message_stop', {}); res.end();
    } catch {res.writeHead(500).end();}
  });
  endpoint.listen(0, gateway); await once(endpoint, 'listening');
  await writeFile(source, JSON.stringify({env: {ANTHROPIC_BASE_URL: `http://${gateway}:${(endpoint.address() as {port: number}).port}`, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_MODEL: 'controlled-setup-backend', ANTHROPIC_CUSTOM_HEADERS: `X-Acceptance: ${header}`}}), {mode: 0o600});
  const cliEnv = {...env, PATH: `${join(prefix, 'bin')}:${env.PATH}`};
  const shell = async (command: string, timeout = 30000) => {
    let result;
    try {result = await exec('sh', ['-c', command], {cwd: directory, env: cliEnv, timeout, maxBuffer: 16 * 1024 * 1024});}
    catch (error) {
      await writeFile(join(directory, 'command-error.log'), redact(String((error as {stderr?: string}).stderr ?? 'Command failed')));
      throw Error(`Acceptance command failed; redacted diagnostics: ${join(directory, 'command-error.log')}`);
    }
    for (const secret of secrets) if ((result.stdout + result.stderr).includes(secret)) throw Error('Credential found in command output; raw diagnostics withheld');
    return result;
  };
  let control: ReturnType<typeof spawn> | undefined;
  let setup: any, receipt: any, detail: any;
  let submitted = false, safe = false;
  let serviceOut = '', serviceError = '';
  const scan = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, {withFileTypes: true})) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await scan(file);
      else if (entry.isFile()) for (const secret of secrets) expect((await readFile(file)).includes(Buffer.from(secret)), file).toBe(false);
    }
  };
  try {
    setup = JSON.parse(await run(bin, ['setup', '--project', repo, '--connection-settings', source, ...(process.env.ORCH_SETUP_IMAGE ? ['--image', process.env.ORCH_SETUP_IMAGE] : []), '--question', 'Read README.md and name the committed marker and call relationship.', '--yes', '--json']));
    expect(setup.project).toEqual({root: repo, sha, dirty: true});
    expect(setup.model).toBe('inherit');
    expect(await readdir(setup.paths.data)).toEqual([]);
    await writeFile(join(directory, 'setup.json'), JSON.stringify(setup, null, 2));
    const recipe = await readFile(setup.paths.dockerfile, 'utf8');
    expect(recipe).toContain('@anthropic-ai/claude-code@2.1.296');
    if (!process.env.ORCH_SETUP_IMAGE) {
      const build = await shell(setup.commands.prepareImage, 600000);
      await writeFile(join(directory, 'build.log'), build.stdout + build.stderr);
    }
    const image = await docker('image', 'inspect', setup.image, '--format', '{{.Id}}');
    const version = (await shell(setup.commands.checkImage)).stdout.trim();
    expect(version).toBe('2.1.296 (Claude Code)');
    control = spawn('sh', ['-c', `exec ${setup.commands.serve}`], {cwd: directory, env: cliEnv});
    control.stdout!.on('data', chunk => serviceOut += chunk); control.stderr!.on('data', chunk => serviceError += chunk);
    await expect.poll(() => serviceOut, {timeout: 15000}).toContain('ready');
    submitted = true;
    const submission = await shell(setup.commands.submit);
    await writeFile(join(directory, 'submission.txt'), submission.stdout + submission.stderr);
    const list = JSON.parse(await run(bin, ['list', '--data', setup.paths.data]));
    expect(list).toHaveLength(1); receipt = {executionId: list[0].execution.id};
    await expect.poll(async () => {
      detail = JSON.parse(await run(bin, ['show', receipt.executionId, '--data', setup.paths.data]));
      return detail.attempts.at(-1)?.stopConfirmation?.kind;
    }, {timeout: 90000, interval: 500}).toBe('agent-exit-marker');
    const attempt = detail.attempts[0];
    expect(attempt).toMatchObject({actualSha: sha, workspaceMode: 'readonly', exitCode: 0, contract: 'valid', tools: []});
    expect(attempt.business.report).toContain(report);
    expect(attempt.business.report).toContain('[REDACTED]');
    const shown = await run(bin, ['show', receipt.executionId, '--data', setup.paths.data, '--human']);
    expect(shown).toContain(report);
    await writeFile(join(directory, 'report.txt'), shown);
    const mounts = JSON.parse(await docker('inspect', attempt.container, '--format', '{{json .Mounts}}'));
    expect(mounts.length).toBeGreaterThan(0); expect(mounts.every((mount: any) => !mount.RW)).toBe(true);
    const hostConfig = JSON.parse(await docker('inspect', attempt.container, '--format', '{{json .HostConfig}}'));
    expect(hostConfig.ReadonlyRootfs).toBe(true); expect(hostConfig.NetworkMode).toBe('bridge');
    expect(hostConfig.CapDrop).toContain('ALL'); expect(hostConfig.SecurityOpt).toContain('no-new-privileges');
    expect(await docker('exec', attempt.container, 'git', '-C', '/home/agent/workspace', 'rev-parse', 'HEAD')).toBe(sha);
    expect(await docker('exec', attempt.container, 'cat', '/home/agent/workspace/README.md')).toContain('SETUP_PINNED_82');
    const ip = await docker('inspect', attempt.container, '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}');
    expect(requests.some(request => request.readCommittedFile)).toBe(true);
    expect(requests.every(request => request.peer === ip && request.authenticated && request.model === 'controlled-setup-backend')).toBe(true);
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toContain('SETUP_DIRTY_82');
    await scan(setup.paths.data); await scan(home);
    for (const secret of secrets) expect((serviceOut + serviceError + shown + JSON.stringify(setup)).includes(secret), 'Credentials absent from service/report/setup output').toBe(false);
    await writeFile(join(directory, 'evidence.json'), JSON.stringify({baseline: await run('git', ['rev-parse', 'HEAD'], root), sha, image, imageSelection: setup.image, recommendedImageBuilt: !process.env.ORCH_SETUP_IMAGE, version, recipeSha256: createHash('sha256').update(recipe).digest('hex'), package: packed.filename, requests, attempt: {id: attempt.id, container: attempt.container, actualSha: attempt.actualSha, stopConfirmation: attempt.stopConfirmation, report: attempt.business.report}, secretsAbsent: true}, null, 2));
    console.log(`Issue #82 container acceptance evidence: ${directory}`);
  } finally {
    try {
      safe = !submitted;
      if (receipt) {
        detail = JSON.parse(await run(bin, ['show', receipt.executionId, '--data', setup.paths.data]));
        const attempt = detail.attempts[0];
        safe = attempt?.stopConfirmation?.kind === 'agent-exit-marker' && !/claude|node/.test(await docker('top', attempt.container, '-eo', 'pid,comm'));
        if (safe) {await docker('stop', attempt.container); safe = await docker('inspect', attempt.container, '--format', '{{.State.Running}}') === 'false';}
      }
      if (safe) {
        if (control && control.exitCode === null && control.signalCode === null) {const exited = once(control, 'close'); control.kill('SIGTERM'); await exited;}
        endpoint.closeAllConnections(); await new Promise<void>(done => endpoint.close(() => done()));
        await writeFile(join(directory, 'cleanup.json'), JSON.stringify({safe: true, container: detail?.attempts[0]?.container, controlExited: !control || control.exitCode !== null || control.signalCode !== null, endpointClosed: true}, null, 2));
      }
    } finally {
      if (!safe) {
        // ponytail: endpoint belongs to this worker; failure-path retention is not certified by this success-path check.
        console.error(`Unconfirmed execution; do not force-stop. Inspect ${directory}. Worker exit may close the controlled endpoint.`);
        throw Error('Acceptance stop not confirmed; preserve container/control evidence');
      }
    }
  }
}, 900000);
