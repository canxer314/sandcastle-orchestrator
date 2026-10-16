import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, {recursive: true, force: true}); });
async function project() {
  const dir = await mkdtemp(join(tmpdir(), 'setup-')); dirs.push(dir);
  const repo = join(dir, 'sample'); const home = join(dir, 'home');
  await mkdir(repo); await mkdir(home);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], {encoding: 'utf8'}).trim();
  git('init', '-q'); await writeFile(join(repo, 'README.md'), '# Sample\n');
  git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'initial');
  return {dir, repo, home, git, sha: git('rev-parse', 'HEAD')};
}
async function cli(args: string[], cwd: string, home: string) {
  const child = spawn(process.execPath, ['--import', join(root, 'node_modules/tsx/dist/loader.mjs'), join(root, 'src/cli.ts'), ...args], {cwd, env: {...process.env, HOME: home}});
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  const [code, signal] = await once(child, 'close'); clearTimeout(timer);
  return {code, signal, stdout, stderr};
}

test('setup pins current committed Git context and generates independent resources without running it', async () => {
  const p = await project();
  await mkdir(join(p.repo, 'nested'));
  await writeFile(join(p.repo, 'README.md'), 'uncommitted');
  await writeFile(join(p.repo, 'config.ts'), 'throw Error("project configuration must not execute")');
  const result = await cli(['setup', '--json', '--yes', '--connection-environment'], join(p.repo, 'nested'), p.home);
  expect(result.code, result.stderr).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.project).toEqual({root: p.repo, sha: p.sha, dirty: true});
  expect(output.connection).toEqual({source: 'environment'});
  expect(output.model).toBe('inherit');
  expect(output.repo).toBe('sample'); expect(output.role).toBe('sample-question');
  expect(output.paths.data).not.toBe(join(p.home, '.sandcastle-orchestrator/data'));
  expect(JSON.parse(await readFile(output.paths.input, 'utf8'))).toEqual({commit: p.sha, question: '说明这个项目的主要模块及调用关系'});
  expect(await readdir(output.paths.data)).toEqual([]);
  expect(output.commands.serve).toContain(output.paths.config);
  expect(output.commands.submit).toContain('--input-file');
  expect(output.commands.submit).toContain('--capability sample-question');
  expect(result.stderr).toContain(p.sha);
  expect(result.stderr).toContain('uncommitted');
  expect(p.git('rev-parse', 'HEAD')).toBe(p.sha);
  expect(await readFile(join(p.repo, 'README.md'), 'utf8')).toBe('uncommitted');
});

test('setup refuses noninteractive ambiguity and protects existing, aliased and project paths even with yes', async () => {
  const p = await project();
  for (const args of [[], ['--yes'], ['--connection-environment'], ['--yes', '--connection-environment', '--reuse-local-claude']]) {
    const result = await cli(['setup', '--json', ...args], p.repo, p.home);
    expect(result.code, result.stderr).toBe(1); expect(result.signal).toBeNull(); expect(result.stdout).toBe('');
  }
  const existing = join(p.dir, 'keep.mts'); await writeFile(existing, 'keep');
  for (const args of [['--config', existing], ['--data', join(p.repo, 'runtime')], ['--input-path', join(p.repo, 'input.json')]]) {
    expect((await cli(['setup', '--yes', '--json', '--connection-environment', ...args], p.repo, p.home)).code).toBe(1);
  }
  expect(await readFile(existing, 'utf8')).toBe('keep');
  const {symlink} = await import('node:fs/promises');
  const dangling = join(p.dir, 'existing-link.mts'); await symlink(join(p.dir, 'missing.mts'), dangling);
  const result = await cli(['setup', '--yes', '--json', '--connection-environment', '--config', dangling], p.repo, p.home);
  expect(result.code, result.stderr).toBe(1);
  await expect(readFile(join(p.dir, 'missing.mts'))).rejects.toMatchObject({code: 'ENOENT'});
});

test('setup generated configuration serves and submits a fixed read-only question through existing CLI/socket runner', async () => {
  const p = await project();
  const settings = join(p.dir, 'connection.json');
  await writeFile(settings, JSON.stringify({env: {ANTHROPIC_BASE_URL: 'http://192.0.2.10:8080', ANTHROPIC_AUTH_TOKEN: 'fixture-secret', ANTHROPIC_MODEL: 'backend-model'}}));
  const result = await cli(['setup', '--project', p.repo, '--yes', '--json', '--connection-settings', settings, '--question', 'What does README say?'], p.dir, p.home);
  expect(result.code, result.stderr).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(result.stdout + result.stderr + await readFile(output.paths.config, 'utf8')).not.toContain('fixture-secret');
  const bin = join(p.dir, 'bin'); await mkdir(bin);
  const capture = join(p.dir, 'docker-calls');
  // System-boundary adapter: execute the real CLI/socket/role/provider, but never invoke Docker or a model.
  await writeFile(join(bin, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(capture)}
case "$1" in
run) echo controlled-container;;
exec) case "$*" in
*ORCH_CONNECTION_CHECK*) printf ready;;
*ORCH_EXIT_*) marker=$(printf '%s' "$*" | grep -o 'ORCH_EXIT_[a-f0-9]*' | head -1); printf '%s\\n' '{"type":"result","subtype":"success","result":"README.md describes Sample. This is analysis, not test evidence."}' "$marker:0";;
*rev-parse*) echo ${p.sha};;
esac;;
cp) exit 1;;
inspect) echo '{"Running":true,"Status":"running"}';;
esac
`, {mode: 0o700});
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'serve', '--config', output.paths.config, '--data', output.paths.data], {cwd: root, env: {...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: p.home}});
  let errors = '';
  child.stderr.on('data', chunk => errors += chunk);
  try {
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => reject(Error(errors || 'Service not ready')), 10000);
      child.stdout.on('data', chunk => {if (String(chunk).includes('ready')) {clearTimeout(timer); done();}});
      child.once('exit', () => {clearTimeout(timer); reject(Error(errors));});
    });
    const submitted = await cli(['submit', '--data', output.paths.data, '--repo', output.repo, '--capability', output.role, '--source', 'setup-acceptance', '--input-file', output.paths.input, '--human'], p.dir, p.home);
    expect(submitted.code, submitted.stderr).toBe(0);
    const {call} = await import('../src/control.js');
    const socket = join(output.paths.data, 'control.sock');
    const executions = await call(socket, {command: 'list'}) as any[];
    const id = executions[0].execution.id;
    await expect.poll(async () => (await call(socket, {command: 'show', id}) as any).attempts.at(-1)?.contract, {timeout: 10000}).toBe('valid');
    const detail = await call(socket, {command: 'show', id}) as any;
    expect(detail.attempts[0]).toMatchObject({actualSha: p.sha, workspaceMode: 'readonly', tools: [], contract: 'valid', business: {report: 'README.md describes Sample. This is analysis, not test evidence.'}});
    const report = await cli(['show', id, '--data', output.paths.data, '--human'], p.dir, p.home);
    expect(report.code, report.stderr).toBe(0); expect(report.stdout).toContain('README.md describes Sample.');
    const calls = await readFile(capture, 'utf8');
    expect(calls).toContain('--network bridge'); expect(calls).toContain('readonly'); expect(calls).not.toContain('--model');
    expect(calls).not.toContain('fixture-secret');
    expect(p.git('status', '--porcelain')).toBe('');
  } finally { const stopped = once(child, 'close'); child.kill('SIGTERM'); await stopped; }
}, 25000);

test('setup never follows dangling output links or Git fsmonitor commands from the target project', async () => {
  const p = await project();
  const {symlink} = await import('node:fs/promises');
  const link = join(p.dir, 'config-link.mts'); await symlink(join(p.dir, 'new-config.mts'), link);
  const marker = join(p.dir, 'fsmonitor-ran');
  const monitor = join(p.dir, 'monitor'); await writeFile(monitor, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, {mode: 0o700});
  p.git('config', 'core.fsmonitor', monitor);
  const result = await cli(['setup', '--yes', '--json', '--connection-environment', '--config', link], p.repo, p.home);
  expect(result.code, result.stderr).toBe(1);
  await expect(readFile(marker)).rejects.toMatchObject({code: 'ENOENT'});
  await expect(readFile(join(p.dir, 'new-config.mts'))).rejects.toMatchObject({code: 'ENOENT'});
});

test('setup supports explicit paths, reference-only and local-source consent without reading connection secrets', async () => {
  const p = await project();
  const paths = {config: join(p.dir, 'advanced', 'reference.mts'), data: join(p.dir, 'advanced-data'), input: join(p.dir, 'question.json')};
  await mkdir(join(p.home, '.claude'));
  await writeFile(join(p.home, '.claude', 'settings.json'), 'invalid PRIVATE-CONNECTION-MUST-NOT-BE-READ');
  const args = ['setup', '--project', p.repo, '--json', '--yes', '--reuse-local-claude', '--reference-only', '--name', 'other', '--config', paths.config, '--data', paths.data, '--input-path', paths.input, '--model', 'custom-backend', '--image', 'custom:image', '--question', 'Read README'];
  const result = await cli(args, p.dir, p.home);
  expect(result.code, result.stderr).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output).toMatchObject({paths: {...paths, dockerfile: join(p.dir, 'advanced', 'Dockerfile')}, referenceOnly: true, repo: 'other', role: 'other-question', model: 'custom-backend', image: 'custom:image', connection: {source: 'settings'}});
  expect(output.connection.path).toBe(join(p.home, '.claude', 'settings.json'));
  const config = await readFile(paths.config, 'utf8');
  expect(config).toContain('custom-backend'); expect(config).not.toContain('PRIVATE-CONNECTION');
  expect((await cli(args, p.dir, p.home)).code).toBe(1);
  expect(await readFile(paths.config, 'utf8')).toBe(config);
});

test('interactive setup displays the selected project/version/resources and waits for explicit write confirmation', async () => {
  const p = await project();
  const invocation = [process.execPath, '--import', join(root, 'node_modules/tsx/dist/loader.mjs'), join(root, 'src/cli.ts'), 'setup', '--project', p.repo].map(value => `'${value.replaceAll("'", "'\\''")}'`).join(' ');
  const child = spawn('script', ['--quiet', '--return', '--command', invocation, '/dev/null'], {cwd: p.dir, env: {...process.env, HOME: p.home}});
  let output = ''; let answered = 0;
  child.stdout.on('data', chunk => {
    output += chunk;
    const prompts = ['Resource name', 'Connection:', 'Read-only question', 'Confirm project/version'];
    if (output.includes(prompts[answered])) {
      child.stdin.write(answered === 3 ? 'yes\n' : '\n'); answered++;
    }
  });
  child.stderr.resume();
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  const [code] = await once(child, 'close'); clearTimeout(timer);
  expect(code, output).toBe(0);
  expect(answered).toBe(4); expect(output).toContain(p.sha); expect(output).toContain('Prepared sample');
  const input = JSON.parse(await readFile(join(p.home, '.sandcastle-orchestrator/projects/sample/input.json'), 'utf8'));
  expect(input.commit).toBe(p.sha);
});

test('setup supplies a pinned image recipe and concrete preparation commands without running them', async () => {
  const p = await project();
  const result = await cli(['setup', '--yes', '--json', '--connection-environment'], p.repo, p.home);
  expect(result.code, result.stderr).toBe(0);
  const output = JSON.parse(result.stdout);
  const recipe = await readFile(output.paths.dockerfile, 'utf8');
  expect(recipe).toContain('FROM node:24.21.0-bookworm-slim');
  expect(recipe).toContain('@anthropic-ai/claude-code@2.1.296');
  expect(output.commands.prepareImage).toContain(output.paths.dockerfile);
  expect(output.commands.prepareImage).toContain(' < ');
  expect(output.commands.prepareImage).toContain(' - < ');
  expect(output.commands.checkImage).toContain('--pull=never');
});

test('setup-only options are rejected by other commands rather than silently ignored', async () => {
  const p = await project();
  const result = await cli(['submit', '--yes', '--repo', 'sample', '--capability', 'sample-question', '--source', 'manual', '--input', '{}', '--socket', join(p.dir, 'missing.sock')], p.repo, p.home);
  expect(result.code).toBe(1); expect(result.stderr).toContain('--yes is only supported for setup');
});

test('reference-only generates merge files without creating or modifying deployment data', async () => {
  const p = await project();
  const data = join(p.dir, 'existing-data'); await mkdir(data); await writeFile(join(data, 'keep'), 'history');
  const result = await cli(['setup', '--yes', '--json', '--connection-environment', '--reference-only', '--data', data], p.repo, p.home);
  expect(result.code, result.stderr).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.referenceOnly).toBe(true);
  expect(await readdir(data)).toEqual(['keep']); expect(await readFile(join(data, 'keep'), 'utf8')).toBe('history');
  const nextData = join(p.dir, 'not-created');
  const next = await cli(['setup', '--yes', '--json', '--connection-environment', '--reference-only', '--name', 'other-reference', '--data', nextData], p.repo, p.home);
  expect(next.code, next.stderr).toBe(0);
  await expect(readdir(nextData)).rejects.toMatchObject({code: 'ENOENT'});
});
