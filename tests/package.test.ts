import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, readlink, rm, lstat, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
let directory: string;
let prefix: string;
let cwd: string;
let installed: string;
let bin: string;
let packed: { filename: string; files: { path: string; mode: number }[] };
const children = new Set<ChildProcess>();

async function start(config: string, data: string, path = process.env.PATH, maintenance?: string) {
  const child = spawn(bin, ['serve', '--config', config, '--data', data, ...(maintenance ? ['--maintenance', maintenance] : [])], { cwd, env: {...process.env, PATH:path} });
  children.add(child);
  let stdout = ''; let stderr = '';
  child.stdout!.on('data', chunk => { stdout += chunk; });
  child.stderr!.on('data', chunk => { stderr += chunk; });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`Service not ready: ${stderr}`)), 10_000);
    child.stdout!.on('data', () => {
      if (stdout.includes('\n')) { clearTimeout(timer); resolve(); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(Error(`Service exited before ready: ${stderr}`)); });
  });
  expect(JSON.parse(stdout.trim())).toEqual({ ready: true, socket: join(data, 'control.sock') });
  return child;
}

async function stop(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
  children.delete(child);
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orch-package-'));
  prefix = join(directory, 'prefix');
  cwd = join(directory, 'unrelated');
  await mkdir(cwd);
  const result = await exec('npm', ['pack', '--json', '--pack-destination', directory], { cwd: root });
  [packed] = Object.values(JSON.parse(result.stdout));
  await exec('npm', ['install', '--global', '--prefix', prefix, '--omit=dev', '--no-audit', '--no-fund', join(directory, packed.filename)], { cwd, timeout: 180_000 });
  installed = join(prefix, 'lib/node_modules/@canxer314/sandcastle-orchestrator');
  bin = join(prefix, 'bin/sandcastle-orchestrator');
}, 240_000);

afterAll(async () => {
  for (const child of children) await stop(child);
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('tarball installs compiled ESM and an executable formal command without the source toolchain', async () => {
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  expect(manifest.name).toBe('@canxer314/sandcastle-orchestrator');
  expect(manifest.bin).toEqual({ 'sandcastle-orchestrator': './dist/cli.js' });
  expect(manifest.type).toBe('module');
  expect(manifest.engines.node).toBe('>=24');
  expect(packed.files.some(file => file.path === 'dist/config.d.ts')).toBe(true);
  expect(packed.files.some(file => /^(src|tests|node_modules|\.claude|\.agents)\//.test(file.path))).toBe(false);
  expect(await readFile(bin, 'utf8')).toMatch(/^#!\/usr\/bin\/env node\n/);
  expect((await stat(bin)).mode & 0o111).not.toBe(0);
  const version = await exec(bin, ['--version'], { cwd, env: { PATH: `${resolve(process.execPath, '..')}:/usr/bin:/bin` } });
  expect(version.stdout).toBe(`${manifest.version}\n`);
  expect(version.stderr).toBe('');
});

test('help and no-argument discovery need neither configuration nor a service', async () => {
  const config = join(cwd, 'must-not-load.ts');
  const data = join(cwd, 'must-not-create');
  await writeFile(config, 'throw new Error("Configuration was executed");');
  const before = await readdir(cwd);
  const commands = ['setup', 'serve', 'submit', 'show', 'list', 'logs', 'artifact', 'cancel', 'confirm-stop', 'resolve', 'retry', 'cleanup', 'pause', 'resume', 'maintenance', 'restore-review', 'init', 'doctor'];
  for (const command of [undefined, ...commands]) {
    const result = await exec(bin, [...(command ? [command] : []), '--help', '--config', config, '--data', data, '--socket', join(data, 'absent.sock')], { cwd });
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('sandcastle-orchestrator');
    expect(result.stdout).toContain('Example:');
    if (command === 'serve') expect(result.stdout).toContain('--maintenance');
    if (command && !['serve', 'setup', 'init', 'doctor'].includes(command)) expect(result.stdout).toContain('--socket');
  }
  const discovery = await exec(bin, [], { cwd });
  for (const command of commands) expect(discovery.stdout).toContain(command);
  expect(discovery.stdout).toMatch(/demo.*unreleased/i);
  expect(await readdir(cwd)).toEqual(before);
});

test('unknown commands retain JSON errors and cannot match inherited object properties', async () => {
  for (const command of ['unknown', 'demo', 'toString', '__proto__']) {
    await expect(exec(bin, [command], { cwd })).rejects.toMatchObject({
      code: 1,
      stdout: '',
      stderr: `${JSON.stringify({ error: 'Unknown command; use setup, serve, submit, show, list, logs, artifact, cancel, confirm-stop, resolve, retry, cleanup, pause, resume, maintenance, restore-review, init or doctor' })}\n`,
    });
    await expect(exec(bin, [command, '--help'], { cwd })).rejects.toMatchObject({
      code: 1,
      stdout: '',
      stderr: `${JSON.stringify({ error: `Unknown command: ${command}` })}\n`,
    });
  }
});

test('external trusted TypeScript keeps tsx syntax and relative imports through installed CLI/socket', async () => {
  const configDir = join(directory, 'config');
  await mkdir(configDir);
  await writeFile(join(configDir, 'package.json'), '{"type":"module"}');
  await writeFile(join(configDir, 'definition.ts'), `
    enum Environment { Local = 'local' }
    class Deployment { constructor(public version: string) {} }
    export const deployment = new Deployment('external-tsx');
    export const environment = Environment.Local;
  `);
  const config = join(configDir, 'config.ts');
  await writeFile(config, `
    import { deployment, environment } from './definition.js';
    export default {
      version: deployment.version, repos: [{id:'example', location:${JSON.stringify(join(directory, 'checkout'))}}],
      environments: [{id: environment}], capabilities: [{
        id:'accept-only', environment,
        validate(input: unknown) { if (input !== 'valid') throw Error('Expected valid input'); },
        run() { throw Error('No execution configured; must remain queued'); }
      }]
    };
  `);
  const data = join(directory, 'external-data');
  const child = await start(config, data);
  const socket = join(data, 'control.sock');
  const receipt = JSON.parse((await exec(bin, ['submit', '--socket', socket, '--repo', 'example', '--capability', 'accept-only', '--input', '"valid"', '--source', 'package-test'], { cwd })).stdout);
  expect(receipt).toMatchObject({ accepted: true, requestId: expect.any(String), executionId: expect.any(String) });
  const detail = JSON.parse((await exec(bin, ['show', receipt.executionId, '--socket', socket], { cwd })).stdout);
  expect(detail.request).toMatchObject({ input: 'valid', source: 'package-test' });
  expect(detail.execution.status).toBe('queued');
  const rejected = await exec(bin, ['submit', '--socket', socket, '--repo', 'example', '--capability', 'accept-only', '--input', 'null', '--source', 'package-test'], { cwd });
  expect(JSON.parse(rejected.stdout)).toMatchObject({ accepted: false, reason: 'Expected valid input' });
  await stop(child);
  await expect(exec(bin, ['list', '--socket', socket], { cwd })).rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('"error"') });
});

test('external ESM config resolves public configuration types and runtime exports from its own dependencies', async () => {
  const project = join(directory, 'advanced');
  await mkdir(project);
  await writeFile(join(project, 'package.json'), '{"private":true,"type":"module"}');
  await exec('npm', ['install', '--no-audit', '--no-fund', join(directory, packed.filename), 'typescript@5.9.3', '@types/node@24.19.1', 'zod@4.6.5'], { cwd: project, timeout: 180_000 });
  const config = join(project, 'config.ts');
  await writeFile(config, `
    import type { Configuration, Role, ExecutionContext, Submission, McpService, McpConnection, McpReference, McpCapability } from '@canxer314/sandcastle-orchestrator';
    import { createPrAnalysisRole, createPrSnapshotTool, configureClaudeMcp } from '@canxer314/sandcastle-orchestrator';
    import { z } from 'zod';
    const scope = {repo:'owner/example', pullRequests:[31]};
    const role: Role = createPrAnalysisRole(scope);
    const tool = createPrSnapshotTool({...scope, path:'/not-read-during-import.json'});
    if (typeof configureClaudeMcp !== 'function' || role.id !== 'pr-analysis' || tool.id !== 'pr-snapshot') throw Error('Missing public values');
    const input = z.string();
    export default {
      version:'advanced-consumer', repos:[], environments:[{id:'local'}],
      roles:[role], tools:[tool], capabilities:[{
        id:'accept-only', environment:'local', validate(value: unknown) { input.parse(value); },
        run(context: ExecutionContext) { return {business:context.input}; }
      }]
    } satisfies Configuration;
    const submission: Submission = {repo:'example', capability:'accept-only', input:'ok', source:'advanced'};
  `);
  await exec(process.execPath, [join(project, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--module', 'NodeNext', '--target', 'ES2023', config], { cwd: project });
  const child = await start(config, join(directory, 'advanced-data'));
  await stop(child);
}, 240_000);

test('compiled layout protects application, config and checkout physical paths before writing data', async () => {
  const configDir = join(directory, 'protected-config');
  const checkout = join(directory, 'protected-checkout');
  await mkdir(configDir); await mkdir(checkout);
  await writeFile(join(configDir, 'package.json'), '{"type":"module"}');
  const config = join(configDir, 'config.ts');
  await writeFile(config, `export default {version:'paths',repos:[{id:'example',location:${JSON.stringify(checkout)}}],environments:[],capabilities:[]};`);
  const alias = join(directory, 'app-alias');
  await symlink(installed, alias);
  const configLinkDir = join(directory, 'config-link');
  await mkdir(configLinkDir);
  const configLink = join(configLinkDir, 'config.ts');
  await symlink(config, configLink);
  const protectedData = [installed, join(installed, 'nested-data'), join(installed, '..'), alias, join(alias, 'nested-data'), configDir, join(configDir, 'nested-data'), checkout, join(checkout, 'nested-data')];
  const before = await Promise.all([installed, configDir, checkout].map(async path => ({ path, mode:(await stat(path)).mode, files:await readdir(path) })));
  for (const data of protectedData) {
    await expect(exec(bin, ['serve', '--config', configLink, '--data', data], { cwd })).rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('separate') });
  }
  for (const entry of before) {
    expect((await stat(entry.path)).mode).toBe(entry.mode);
    expect(await readdir(entry.path)).toEqual(entry.files);
  }
}, 30_000);

test('installed init creates an independent committed demo and reuses complete resources without writing', async () => {
  const home = join(directory, 'onboarding-home');
  const env = { ...process.env, HOME: home };
  const result = await exec(bin, ['init', '--yes', '--json'], { cwd, env });
  expect(result.stderr).toContain('Will create:');
  const initialized = JSON.parse(result.stdout);
  expect(initialized).toMatchObject({ ok: true, status: 'created', paths: {
    config: join(home, '.sandcastle-orchestrator/config/config.ts'),
    data: join(home, '.sandcastle-orchestrator/data'),
    demoRepo: join(home, '.sandcastle-orchestrator/demo-repo'),
  } });
  const { config, data, demoRepo } = initialized.paths;
  expect(JSON.parse(await readFile(join(config, '../package.json'), 'utf8'))).toMatchObject({ type: 'module' });
  const marker = JSON.parse(await readFile(join(data, 'init.json'), 'utf8'));
  expect(marker).toMatchObject({ layoutVersion: 1, config, data, demoRepo, repoId: 'demo', capabilityId: 'demo-test' });
  await exec(process.execPath, ['--test', 'test.cjs'], { cwd: demoRepo });
  const sha = (await exec('git', ['-C', demoRepo, 'rev-parse', '--verify', 'HEAD'])).stdout.trim();
  expect(sha).toMatch(/^[a-f0-9]{40}$/);
  const files = [config, join(config, '../package.json'), join(data, 'init.json'), join(demoRepo, '.git/index')];
  const before = await Promise.all(files.map(async file => ({ content: await readFile(file), mtime: (await stat(file)).mtimeMs })));
  const reused = await exec(bin, ['init', '--data', data, '--yes', '--json'], { cwd, env });
  expect(JSON.parse(reused.stdout)).toMatchObject({ ok: true, status: 'reused' });
  expect(await Promise.all(files.map(async file => ({ content: await readFile(file), mtime: (await stat(file)).mtimeMs })))).toEqual(before);
});

test('installed onboarding rejects unsafe paths and incomplete resources without changing existing files', async () => {
  const base = join(directory, 'onboarding-protection');
  await mkdir(base);
  const config = join(base, 'config/config.ts'); const data = join(base, 'data'); const repo = join(base, 'repo');
  const args = ['--config', config, '--data', data, '--demo-repo', repo];
  await expect(exec(bin, ['init', ...args, '--json'], { cwd })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('--yes') });
  expect(await readdir(base)).toEqual([]);
  await expect(exec(bin, ['init', ...args], { cwd })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('--yes') });
  expect(await readdir(base)).toEqual([]);
  for (const extra of [['extra'], ['--reset-demo'], ['--socket', '/absent'], ['--offline'], ['--human', '--json'], ['--repo', 'other']]) {
    await expect(exec(bin, ['init', ...args, '--yes', ...extra], { cwd })).rejects.toMatchObject({ code: 1 });
    expect(await readdir(base)).toEqual([]);
  }
  for (const unsafe of [join(base, 'config/nested'), join(repo, 'nested'), base, installed, join(installed, 'nested')]) {
    await expect(exec(bin, ['init', ...args, '--data', unsafe, '--yes', '--json'], { cwd })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('separate') });
    expect(await readdir(base)).toEqual([]);
  }
  const collision = join(base, 'config/package.json');
  await expect(exec(bin, ['init', ...args, '--config', collision, '--yes', '--json'], { cwd })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('package.json') });
  expect(await readdir(base)).toEqual([]);
  await expect(exec(bin, ['init', ...args, '--config', join(base, 'config/config.js'), '--yes', '--json'], { cwd })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('.ts or .mts') });
  expect(await readdir(base)).toEqual([]);
  const checkout = join(base, 'business'); await mkdir(checkout); await exec('git', ['init', checkout]);
  await expect(exec(bin, ['init', ...args, '--demo-repo', join(checkout, 'demo'), '--yes', '--json'], { cwd })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('Git checkout') });
  expect(await readdir(checkout)).toEqual(['.git']);
  const broken = join(base, 'broken-business'); await mkdir(broken); await writeFile(join(broken, '.git'), 'gitdir: /missing-git-metadata\n');
  await expect(exec(bin, ['init', ...args, '--demo-repo', join(broken, 'demo'), '--yes', '--json'], { cwd })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('Git checkout') });
  expect(await readdir(broken)).toEqual(['.git']);
  await mkdir(data); await writeFile(join(data, 'keep'), 'evidence');
  await expect(exec(bin, ['init', ...args, '--yes', '--json'], { cwd })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('preserve') });
  expect(await readdir(base)).toEqual(['broken-business', 'business', 'data']);
  expect(await readFile(join(data, 'keep'), 'utf8')).toBe('evidence');
  await expect(exec(bin, ['doctor', ...args, '--json'], { cwd })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('Existing or incomplete resource') });
}, 30_000);

test('installed doctor inspects prerequisites before init and initialized templates work through CLI/socket', async () => {
  const base = join(directory, 'onboarding-doctor'); const adapters = join(base, 'bin');
  await mkdir(adapters, { recursive: true });
  const calls = join(base, 'docker-calls');
  await writeFile(join(adapters, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
case "$1" in
  --version) echo 'Docker controlled';;
  info) echo '"controlled"';;
  image) [ "$3" = node:22.22-alpine ] || exit 8; echo '[]';;
  run) echo 'controlled demo test';;
  inspect) echo '{"Running":false,"Status":"exited","ExitCode":0}';;
  *) exit 9;;
esac
`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${adapters}:${process.env.PATH}` };
  const config = join(base, 'config/config.ts'); const data = join(base, 'data'); const repo = join(base, 'repo');
  const args = ['--config', config, '--data', data, '--demo-repo', repo];
  const before = await readdir(base);
  await expect(exec(bin, ['doctor', ...args, '--json'], { cwd, env })).rejects.toMatchObject({ code: 1, stderr: '', stdout: expect.stringContaining('uninitialized') });
  expect(await readdir(base)).toEqual([...before, 'docker-calls']);
  expect((await readFile(calls, 'utf8')).split('\n').filter(Boolean)).toEqual(['--version', 'info --format {{json .ServerVersion}}', 'image inspect node:22.22-alpine']);
  await exec(bin, ['init', ...args, '--yes', '--json'], { cwd, env });
  const result = await exec(bin, ['doctor', '--data', data, '--json'], { cwd, env });
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, paths: { config, data, demoRepo: repo } });
  expect(result.stderr).toContain(`Loading trusted TypeScript configuration (executes code): ${config}`);
  const child = await start(config, data, env.PATH);
  const sha = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
  const receipt = JSON.parse((await exec(bin, ['submit', '--socket', join(data, 'control.sock'), '--repo', 'demo', '--capability', 'demo-test', '--input', JSON.stringify(sha), '--source', 'init-test'], { cwd })).stdout);
  expect(receipt.accepted).toBe(true);
  await expect.poll(async () => JSON.parse((await exec(bin, ['show', receipt.executionId, '--socket', join(data, 'control.sock')], { cwd })).stdout), { timeout: 10_000 }).toMatchObject({ execution: { status: 'completed' }, attempts: [{ actualSha: sha, contract: 'valid', business: { passed: true, exitCode: 0 } }] });
  expect(JSON.parse((await exec(bin, ['logs', receipt.executionId, '--socket', join(data, 'control.sock')], { cwd })).stdout)).toMatchObject({ complete: true, stdout: 'controlled demo test\n' });
  await stop(child);

  // Same physical resources, custom data marker discovery and edits are all allowed.
  const alias = join(base, 'alias'); await symlink(base, alias);
  await writeFile(config, (await readFile(config, 'utf8')).replace('demo-config-v1', 'user-edited') + '\nconsole.log("user configuration diagnostic");\n');
  await writeFile(join(repo, 'user-file'), 'keep my changes');
  await exec('git', ['-C', repo, 'add', '.']);
  await exec('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'user changes']);
  expect(JSON.parse((await exec(bin, ['doctor', '--data', join(alias, 'data'), '--config', join(alias, 'config/config.ts'), '--demo-repo', join(alias, 'repo'), '--json'], { cwd, env })).stdout)).toMatchObject({ ok: true });
  expect(JSON.parse((await exec(bin, ['init', '--data', data, '--yes', '--json'], { cwd, env })).stdout)).toMatchObject({ status: 'reused' });
  await expect(exec(bin, ['doctor', '--data', data, '--config', join(base, 'other/config.ts'), '--json'], { cwd, env })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('conflicts') });
  const markerPath = join(data, 'init.json'); const marker = await readFile(markerPath, 'utf8');
  await writeFile(markerPath, marker.replace('"layoutVersion": 1', '"layoutVersion": 900'));
  await expect(exec(bin, ['init', '--data', data, '--yes', '--json'], { cwd, env })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('matching CLI version') });
  expect(await readFile(markerPath, 'utf8')).toContain('900');
  await writeFile(markerPath, marker);
  await unlink(config);
  await expect(exec(bin, ['init', '--data', data, '--yes', '--json'], { cwd, env })).rejects.toMatchObject({ code: 1 });
  expect(await readFile(markerPath, 'utf8')).toBe(marker);
  expect(await readFile(join(repo, 'user-file'), 'utf8')).toBe('keep my changes');
}, 30_000);

test('installed onboarding reports missing dependencies without creating resources or pulling images', async () => {
  const base = join(directory, 'onboarding-missing'); const adapters = join(base, 'bin');
  await mkdir(adapters, { recursive: true });
  await symlink(process.execPath, join(adapters, 'node'));
  const env = { ...process.env, PATH: adapters };
  const args = ['--config', join(base, 'config/config.ts'), '--data', join(base, 'data'), '--demo-repo', join(base, 'repo')];
  await expect(exec(bin, ['init', ...args, '--yes', '--json'], { cwd, env })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('apt-get install git') });
  expect(await readdir(base)).toEqual(['bin']);
  await expect(exec(bin, ['doctor', ...args, '--json'], { cwd, env })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('docker pull node:22.22-alpine') });
  expect(await readdir(base)).toEqual(['bin']);
  await symlink((await exec('which', ['git'])).stdout.trim(), join(adapters, 'git'));
  await symlink((await exec('which', ['flock'])).stdout.trim(), join(adapters, 'flock'));
  await writeFile(join(adapters, 'docker'), `#!/bin/sh
case "$1" in
  --version|info) echo controlled;;
  image) exit 1;;
  *) echo forbidden-docker-operation >&2; exit 9;;
esac
`, { mode: 0o700 });
  await exec(bin, ['init', ...args, '--yes', '--json'], { cwd, env });
  let failure: any;
  try { await exec(bin, ['doctor', '--data', join(base, 'data'), '--json'], { cwd, env }); } catch (error) { failure = error; }
  expect(failure.code).toBe(1);
  const report = JSON.parse(failure.stdout);
  expect(report.checks).toContainEqual(expect.objectContaining({ name: 'image:node:22.22-alpine', ok: false, fix: expect.stringContaining('docker pull node:22.22-alpine') }));
  // Absence and incomplete markers must preserve both repository and configuration.
  const config = join(base, 'config/config.ts'); const original = await readFile(config, 'utf8');
  const marker = join(base, 'data/init.json');
  await writeFile(marker, '{"layoutVersion":1}');
  await expect(exec(bin, ['init', ...args, '--yes', '--json'], { cwd, env })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('Incomplete') });
  await unlink(marker);
  await expect(exec(bin, ['init', ...args, '--yes', '--json'], { cwd, env })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('preserve') });
  expect(await readFile(config, 'utf8')).toBe(original);
});

test('installed init asks on a terminal, preserves a decline and resolves relative paths from cwd', async () => {
  const base = join(directory, 'onboarding-interactive'); await mkdir(base);
  const command = `'${bin}' init --config config/config.ts --data data --demo-repo repo`;
  const interact = async (answer: string) => {
    const child = spawn('script', ['-q', '-e', '-c', command, '/dev/null'], { cwd: base });
    children.add(child);
    let output = ''; let answered = false;
    child.stdout.on('data', chunk => {
      output += chunk;
      if (!answered && output.includes('[y/N]')) { answered = true; child.stdin.end(`${answer}\n`); }
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(Error(`Confirmation timed out: ${output}`)); }, 10_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    children.delete(child);
    return { code, output };
  };
  expect(await interact('no')).toMatchObject({ code: 1, output: expect.stringContaining('declined') });
  expect(await readdir(base)).toEqual([]);
  expect(await interact('yes')).toMatchObject({ code: 0, output: expect.stringContaining(join(base, 'config/config.ts')) });
  expect(JSON.parse(await readFile(join(base, 'data/init.json'), 'utf8'))).toMatchObject({ data: join(base, 'data'), demoRepo: join(base, 'repo') });
}, 30_000);

test('installed CLI retains fixed-SHA evidence and a paused queue across reinstall and local version replacement with a controlled Docker adapter', async () => {
  const checkout = join(directory, 'execution-checkout');
  const configDir = join(directory, 'execution-config');
  const adapterDir = join(directory, 'controlled-bin');
  const data = join(directory, 'execution-data');
  await mkdir(checkout); await mkdir(configDir); await mkdir(adapterDir);
  await exec('git', ['init', checkout], { cwd });
  await writeFile(join(checkout, 'test.sh'), 'echo packaged-test\n');
  await exec('git', ['-C', checkout, 'add', '.'], { cwd });
  await exec('git', ['-C', checkout, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'], { cwd });
  const sha = (await exec('git', ['-C', checkout, 'rev-parse', 'HEAD'], { cwd })).stdout.trim();
  await writeFile(join(adapterDir, 'docker'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'run') {
  const mount = args.find(arg => arg.startsWith('type=bind,src=') && arg.endsWith(',dst=/artifacts'));
  fs.writeFileSync(mount.slice('type=bind,src='.length, -',dst=/artifacts'.length) + '/report.txt', 'controlled artifact\\n');
  console.log('packaged-test'); console.error('controlled-stderr'); process.exit(0);
}
if (args[0] === 'inspect') { console.log('{"Running":false,"Status":"exited","ExitCode":0}'); process.exit(0); }
process.exit(1);
`, {mode:0o700});
  const config = join(configDir, 'config.ts');
  // No package.json: existing tsx CommonJS-compatible configuration remains supported.
  await writeFile(config, `export default {
    version:'packaged-execution', repos:[{id:'example',location:${JSON.stringify(checkout)}}],
    environments:[{id:'test',docker:{image:'controlled:test'}}], capabilities:[{
      id:'test-commit',environment:'test',validate(input: unknown){if(typeof input!=='string')throw Error('SHA required');},
      execution:{commit(input: unknown){return input as string;}},
      async run(ctx: any){const result=await ctx.exec(['sh','/workspace/test.sh']);return {business:{passed:result.exitCode===0},artifacts:['report.txt']};}
    }]
  };`);
  const child = await start(config, data, `${adapterDir}:${process.env.PATH}`);
  const socket = join(data, 'control.sock');
  const receipt = JSON.parse((await exec(bin, ['submit', '--socket', socket, '--repo', 'example', '--capability', 'test-commit', '--input', JSON.stringify(sha), '--source', 'package-test'], { cwd })).stdout);
  expect(receipt.accepted).toBe(true);
  await expect.poll(async () => JSON.parse((await exec(bin, ['show', receipt.executionId, '--socket', socket], { cwd })).stdout), {timeout:10_000}).toMatchObject({
    execution:{status:'completed'}, attempts:[{actualSha:sha, configVersion:'packaged-execution', runState:'completed', contract:'valid', business:{passed:true}}]
  });
  const logs = JSON.parse((await exec(bin, ['logs', receipt.executionId, '--socket', socket], { cwd })).stdout);
  expect(logs).toMatchObject({complete:true, stdout:'packaged-test\n', stderr:'controlled-stderr\n'});
  const cli = async (...args: string[]) => JSON.parse((await exec(bin, args, {cwd})).stdout);
  const manage = (command: string, target = 'all') => cli(command, '--socket', socket, '--target', target, '--source', 'operator', '--reason', 'packaged lifecycle check');
  const saved = await cli('show', receipt.executionId, '--socket', socket);
  const artifact = await cli('artifact', receipt.executionId, '--name', 'report.txt', '--socket', socket);
  expect(Buffer.from(artifact.content, 'base64').toString()).toBe('controlled artifact\n');
  await manage('pause', 'starts');
  const queued = await cli('submit', '--socket', socket, '--repo', 'example', '--capability', 'test-commit', '--input', JSON.stringify(sha), '--source', 'package-test');
  expect(queued.accepted).toBe(true);
  await manage('pause');
  await stop(child);
  // init layout is not interpreted by serve or the package manager.
  await writeFile(join(data, 'init.json'), '{"layoutVersion":"preserve-opaque-marker"}\n');
  const before = await Promise.all([data, configDir, checkout].map(resourceSnapshot));
  const replacement = await localVersionTarball();
  for (const args of [['uninstall', '@canxer314/sandcastle-orchestrator'], ['install', replacement.path], ['install', join(directory, packed.filename)]]) {
    await exec('npm', [...args, '--global', '--prefix', prefix, '--omit=dev', '--no-audit', '--no-fund'], {cwd, timeout:180_000});
    expect(await Promise.all([data, configDir, checkout].map(resourceSnapshot))).toEqual(before);
    if (args[0] === 'uninstall') continue;
    // Offline reading is also safe on the retained records before any service starts.
    expect(await cli('show', receipt.executionId, '--data', data, '--offline')).toEqual(saved);
    expect(await cli('logs', receipt.executionId, '--data', data, '--offline')).toEqual(logs);
    expect(await Promise.all([data, configDir, checkout].map(resourceSnapshot))).toEqual(before);
  }
  const restarted = await start(config, data, `${adapterDir}:${process.env.PATH}`, 'paused');
  expect(await cli('maintenance', '--socket', socket)).toMatchObject({admissionPaused:true, startsPaused:true});
  expect(await cli('show', receipt.executionId, '--socket', socket)).toEqual(saved);
  expect(await cli('artifact', receipt.executionId, '--name', 'report.txt', '--socket', socket)).toEqual(artifact);
  expect(await cli('list', '--socket', socket)).toHaveLength(2);
  expect(await cli('show', queued.executionId, '--socket', socket)).toMatchObject({execution:{status:'queued'}, attempts:[]});
  await manage('resume');
  await expect.poll(() => cli('show', queued.executionId, '--socket', socket), {timeout:10_000}).toMatchObject({execution:{status:'completed'}, attempts:[{configVersion:'packaged-execution', actualSha:sha}]});
  expect(await cli('show', receipt.executionId, '--socket', socket)).toEqual(saved);
  await stop(restarted);
}, 240_000);

async function resourceSnapshot(path: string): Promise<unknown> {
  const info = await lstat(path);
  const metadata = { mode: info.mode, mtime: info.mtimeMs };
  if (info.isSymbolicLink()) return { ...metadata, target: await readlink(path) };
  if (info.isDirectory()) {
    const entries: Record<string, unknown> = {};
    for (const name of (await readdir(path)).sort()) entries[name] = await resourceSnapshot(join(path, name));
    return { ...metadata, entries };
  }
  return { ...metadata, bytes: (await readFile(path)).toString('base64') };
}

async function localVersionTarball() {
  const alternate = await mkdtemp(join(directory, 'alternate-package-'));
  // Only the version differs; this is npm replacement evidence, not a historical release.
  await exec('tar', ['-xzf', join(directory, packed.filename), '-C', alternate], { cwd });
  const manifestPath = join(alternate, 'package/package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.version = `${manifest.version}-lifecycle-test.84`;
  await writeFile(manifestPath, JSON.stringify(manifest));
  const [replacement] = Object.values(JSON.parse((await exec('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', alternate], { cwd: join(alternate, 'package') })).stdout)) as {filename:string}[];
  return { path: join(alternate, replacement.filename), version: manifest.version };
}

test('npm install, uninstall, reinstall and local version replacement preserve default and custom user resources', async () => {
  const home = join(directory, 'lifecycle-home');
  const resources = join(directory, 'custom-resources');
  const lifecyclePrefix = join(directory, 'lifecycle-prefix');
  const lifecycleBin = join(lifecyclePrefix, 'bin/sandcastle-orchestrator');
  await mkdir(home); await mkdir(resources);
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  for (const hook of ['preinstall', 'install', 'postinstall', 'preuninstall', 'uninstall', 'postuninstall']) {
    expect(manifest.scripts?.[hook]).toBeUndefined();
  }
  const replacement = await localVersionTarball();

  for (const base of [join(home, '.sandcastle-orchestrator'), resources]) {
    for (const [name, content] of Object.entries({
      'config/config.ts': 'throw Error("Install must not execute trusted configuration");\n',
      'config/dependency.ts': 'export const userSetting = "keep";\n',
      'data/init.json': '{"layoutVersion":"opaque-user-marker","custom":true}\n',
      'data/records.sqlite': 'opaque preservation sentinel; not a database fixture\n',
      'data/attempts/saved/workspace/edited.txt': 'uncommitted attempt work\n',
      'data/attempts/saved/artifacts/report.txt': 'retained evidence\n',
      'data/attempts/saved/stdout.log': 'retained stdout\n',
      'data/attempts/saved/stderr.log': 'retained stderr\n',
      'inputs/question.json': '{"question":"keep this input"}\n',
      'setup/config.ts': 'throw Error("Do not load setup configuration");\n',
      'setup/data/init.json': '{"custom":"setup resources"}\n',
      'setup/input.json': '{"question":"setup input"}\n',
    })) {
      const target = join(base, name);
      await mkdir(resolve(target, '..'), {recursive:true, mode:0o700});
      await writeFile(target, content, {mode:0o600});
    }
    for (const name of ['demo-repo', 'real-repo']) {
      const repo = join(base, name);
      await mkdir(repo);
      await exec('git', ['init', repo], { cwd });
      await writeFile(join(repo, 'tracked.txt'), 'committed fixture\n');
      await exec('git', ['-C', repo, 'add', '.'], { cwd });
      await exec('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'], { cwd });
      await writeFile(join(repo, 'tracked.txt'), 'user edit must survive\n');
      await writeFile(join(repo, 'untracked.txt'), 'untracked work\n');
    }
    await symlink(join(base, 'inputs'), join(base, 'input-alias'));
  }
  // Synthetic host state only. Never inspect the operator's private configuration.
  for (const name of ['.claude/settings.json', '.cc-switch/config.json', '.docker/config.json']) {
    const path = join(home, name);
    await mkdir(resolve(path, '..'), {recursive:true});
    await writeFile(path, '{"synthetic":"must remain unchanged"}\n', {mode:0o600});
  }
  const guards = join(directory, 'lifecycle-guards');
  const calls = join(directory, 'unexpected-lifecycle-calls');
  await mkdir(guards);
  for (const name of ['docker', 'sandcastle-orchestrator', 'systemctl', 'gh']) {
    await writeFile(join(guards, name), `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(name)} >> ${JSON.stringify(calls)}\nexit 99\n`, {mode:0o700});
  }
  const before = await Promise.all([home, resources].map(resourceSnapshot));
  const env = {...process.env, HOME:home, PATH:`${guards}:${process.env.PATH}`, npm_config_cache:join(directory, 'lifecycle-cache'), npm_config_userconfig:join(directory, 'absent.npmrc')};
  const npm = async (...args: string[]) => {
    await exec('npm', [...args, '--global', '--prefix', lifecyclePrefix, '--no-audit', '--no-fund'], {cwd, env, timeout:180_000});
    expect(await Promise.all([home, resources].map(resourceSnapshot))).toEqual(before);
    await expect(lstat(calls)).rejects.toMatchObject({code:'ENOENT'});
  };
  const original = join(directory, packed.filename);
  await npm('install', original);
  expect((await exec(lifecycleBin, ['--version'], {cwd, env})).stdout).toBe(`${manifest.version}\n`);
  await npm('uninstall', manifest.name);
  await expect(lstat(lifecycleBin)).rejects.toMatchObject({code:'ENOENT'});
  await npm('install', original);
  await npm('install', replacement.path);
  expect((await exec(lifecycleBin, ['--version'], {cwd, env})).stdout).toBe(`${replacement.version}\n`);
  await npm('install', original);
  expect((await exec(lifecycleBin, ['--version'], {cwd, env})).stdout).toBe(`${manifest.version}\n`);
}, 240_000);

test('readonly tutorial works as a package consumer through submit, show and report artifacts', async () => {
  const project = join(directory, 'readonly-tutorial');
  const checkout = join(directory, 'tutorial-checkout');
  const data = join(directory, 'tutorial-data');
  await mkdir(project); await mkdir(checkout);
  await writeFile(join(project, 'package.json'), '{"private":true,"type":"module"}');
  await exec('npm', ['install', '--no-audit', '--no-fund', join(directory, packed.filename), '@ai-hero/sandcastle@0.12.0', 'zod@4.6.5', 'typescript@5.9.3', '@types/node@24.19.1'], {cwd:project, timeout:180_000});
  await writeFile(join(project, 'config.ts'), await readFile(join(root, 'examples/readonly-role/config.ts')));
  await writeFile(join(project, 'composition.ts'), await readFile(join(root, 'examples/readonly-role/composition.ts')));
  await exec('git', ['init', checkout], {cwd});
  await writeFile(join(checkout, 'README.md'), '# Authorized fixture\n');
  await exec('git', ['-C', checkout, 'add', '.'], {cwd});
  await exec('git', ['-C', checkout, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'], {cwd});
  const git = async (...args: string[]) => (await exec('git', ['-C', checkout, ...args], {cwd})).stdout;
  const sha = (await git('rev-parse', 'HEAD')).trim();
  const before = await git('status', '--porcelain=v1', '--untracked-files=all');
  const report = {summary:'The fixture has a README.', evidence:['README.md:1'], limitations:['Controlled adapter, not a model conclusion.']};
  const docker = join(project, 'docker');
  const calls = join(project, 'docker-calls');
  const gate = join(project, 'tool-gate');
  const release = join(project, 'tool-release');
  await writeFile(docker, `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
case "$1" in
run) case "$*" in *--detach*) echo controlled-container;; *) echo '["README.md"]';; esac;;
exec) case "$*" in
*ORCH_EXIT_*) if [ -f ${JSON.stringify(gate)} ]; then while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.02; done; fi; marker=$(printf '%s' "$*" | grep -o 'ORCH_EXIT_[a-f0-9]*' | head -1); printf '%s\\n%s:0\\n' '${JSON.stringify(report)}' "$marker";;
*rev-parse*) echo ${sha};;
esac;;
inspect) echo '{"Running":false,"Status":"exited","ExitCode":0}';;
esac
`, {mode:0o700});
  // Only the provider and Docker facility are controlled; the tutorial role is unchanged.
  const wrapper = join(project, 'controlled.ts');
  await writeFile(wrapper, `
    Object.assign(process.env, {
      TUTORIAL_REPO:${JSON.stringify(checkout)}, TUTORIAL_IMAGE:'controlled:image',
      TUTORIAL_MODEL:'controlled-model', TUTORIAL_CONNECTION:${JSON.stringify(join(project, 'not-read.json'))},
      TUTORIAL_CONFIG_VERSION:'tutorial-consumer'
    });
    const {default: config} = await import('./config.js');
    config.environments[0]!.docker = {...config.environments[0]!.docker!, binary:${JSON.stringify(docker)}, network:'none'};
    config.providers![0]!.agent = {name:'controlled', env:{}, captureSessions:false,
      buildPrintCommand(){return {command:'controlled-agent'};},
      parseStreamLine(line: string){return [{type:'result', result:line}];}
    };
    delete config.providers![0]!.connection;
    export default config;
  `);
  await exec(process.execPath, [join(project, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--module', 'NodeNext', '--target', 'ES2023', join(project, 'config.ts'), join(project, 'composition.ts'), wrapper], {cwd:project});
  const child = await start(wrapper, data);
  const socket = join(data, 'control.sock');
  const cli = async (...args: string[]) => JSON.parse((await exec(bin, [...args, '--socket', socket], {cwd})).stdout);
  const submit = (input: unknown) => cli('submit', '--repo', 'tutorial', '--capability', 'repository-question', '--input', JSON.stringify(input), '--source', 'tutorial-test');
  expect(await submit({sha:'HEAD', question:'What is here?'})).toMatchObject({accepted:false});
  expect(await submit({sha, question:''})).toMatchObject({accepted:false});
  expect(await submit({sha, question:'What is here?', command:'publish'})).toMatchObject({accepted:false});
  const receipt = await submit({sha, question:'What is here?'});
  expect(receipt.accepted).toBe(true);
  await expect.poll(() => cli('show', receipt.executionId), {timeout:15_000}).toMatchObject({
    request:{repo:'tutorial', capability:'repository-question', input:{sha, question:'What is here?'}},
    execution:{status:'completed'}, attempts:[{
      kind:'agent', actualSha:sha, workspaceMode:'readonly', configVersion:'tutorial-consumer',
      provider:'question-provider', runState:'completed', exitCode:0, contract:'valid', business:report,
    }],
  });
  const artifact = await cli('artifact', receipt.executionId, '--name', 'report.txt');
  expect(artifact).toMatchObject({availability:'available', actualSha:sha, encoding:'base64'});
  expect(JSON.parse(Buffer.from(artifact.content, 'base64').toString())).toEqual(report);
  expect(await cli('logs', receipt.executionId)).toMatchObject({complete:true});
  const commands = await readFile(calls, 'utf8');
  expect(commands).toContain('--read-only');
  expect(commands).toContain(',readonly');
  expect(commands).toContain('--network none');
  expect(commands).not.toContain('dst=/implementation');
  expect((await git('rev-parse', 'HEAD')).trim()).toBe(sha);
  expect(await git('status', '--porcelain=v1', '--untracked-files=all')).toBe(before);
  expect(await readFile(join(checkout, 'README.md'), 'utf8')).toBe('# Authorized fixture\n');
  await stop(child);

  const composed = join(project, 'controlled-composition.ts');
  await writeFile(composed, `import './controlled.js'; export {default} from './composition.js';`);
  const composedChild = await start(composed, data, `${project}:${process.env.PATH}`);
  expect(await cli('submit', '--repo', 'tutorial', '--capability', 'list-root', '--input', '{"command":"publish"}', '--source', 'tutorial-test')).toMatchObject({accepted:false});
  const listing = await cli('submit', '--repo', 'tutorial', '--capability', 'list-root', '--input', JSON.stringify(sha), '--source', 'tutorial-test');
  expect(listing.accepted).toBe(true);
  await expect.poll(() => cli('show', listing.executionId), {timeout:15_000}).toMatchObject({
    execution:{status:'completed'}, attempts:[{actualSha:sha, contract:'valid', business:{actualSha:sha, entries:['README.md']}}],
  });
  await writeFile(gate, 'wait for controlled tool call');
  const composedReceipt = await submit({sha, question:'What is here?'});
  expect(composedReceipt.accepted).toBe(true);
  let detail: any;
  await expect.poll(async () => {
    detail = await cli('show', composedReceipt.executionId);
    return detail.attempts[0]?.mcpDirectory;
  }, {timeout:15_000}).toBeTruthy();
  await expect.poll(() => readFile(calls, 'utf8'), {timeout:15_000}).toContain("--mcp-config '/orchestrator-mcp/config.json'");
  const client = new Client({name:'tutorial-controlled-harness', version:'1'});
  try {
    await client.connect(new StdioClientTransport({command:process.execPath, args:[
      join(detail.attempts[0].mcpDirectory, 'bridge.cjs'),
      join(detail.attempts[0].mcpDirectory, 'tools.sock'),
    ]}));
    expect((await client.listTools()).tools.map(tool => tool.name)).toContain('list_root');
    const result = await client.callTool({name:'list_root', arguments:{}}) as any;
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      runState:'completed', contract:'valid', actualSha:sha,
      business:{actualSha:sha, entries:['README.md']},
    });
  } finally {
    await client.close();
    await writeFile(release, 'tool completed');
  }
  await expect.poll(() => cli('show', composedReceipt.executionId), {timeout:15_000}).toMatchObject({
    execution:{status:'completed'}, attempts:[{actualSha:sha, contract:'valid', business:report, toolCalls:[{
      id:'1', tool:'list_root', capability:'list-root', actualSha:sha, runState:'completed', contract:'valid',
    }]}],
  });
  expect(await cli('logs', composedReceipt.executionId, '--call', '1')).toMatchObject({complete:true, stdout:'["README.md"]\n'});
  const composedReport = await cli('artifact', composedReceipt.executionId, '--name', 'report.txt');
  expect(JSON.parse(Buffer.from(composedReport.content, 'base64').toString())).toEqual(report);
  await stop(composedChild);
}, 240_000);

test('installed setup generates consumable external config with inherited model and explicit file submission', async () => {
  const repo = join(directory, 'setup-project'); const home = join(directory, 'setup-home');
  await mkdir(repo); await mkdir(home);
  await exec('git', ['init', '-q', repo], {cwd});
  await writeFile(join(repo, 'README.md'), '# Package setup fixture\n');
  await exec('git', ['-C', repo, 'add', '.'], {cwd});
  await exec('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], {cwd});
  const sha = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'], {cwd})).stdout.trim();
  const generated = await exec(bin, ['setup', '--project', repo, '--yes', '--json', '--connection-environment'], {cwd, env: {...process.env, HOME: home}});
  const setup = JSON.parse(generated.stdout);
  expect(setup.project.sha).toBe(sha);
  expect(setup.commands.serve).toContain(setup.paths.config);
  expect(setup.commands.submit).toContain('--input-file');
  const config = await readFile(setup.paths.config, 'utf8');
  expect(config).toContain(new URL('dist/index.js', `file://${installed}/`).href);
  expect(config).not.toContain(root);
  const child = spawn(bin, ['serve', '--config', setup.paths.config, '--data', setup.paths.data, '--maintenance', 'paused'], {cwd});
  children.add(child); let errors = '';
  child.stderr!.on('data', chunk => errors += chunk);
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(Error(errors || 'not ready')), 10000);
    child.stdout!.on('data', chunk => {if (String(chunk).includes('ready')) {clearTimeout(timer); done();}});
    child.once('exit', () => {clearTimeout(timer); reject(Error(errors));});
  });
  await exec(bin, ['resume', '--data', setup.paths.data, '--target', 'admission', '--source', 'package-setup', '--reason', 'validate admission only', '--json'], {cwd});
  // Starts remain paused: no real connections or Docker.
  const receipt = JSON.parse((await exec(bin, ['submit', '--data', setup.paths.data, '--repo', setup.repo, '--capability', setup.role, '--source', 'package-setup', '--input-file', setup.paths.input, '--json'], {cwd})).stdout);
  expect(receipt.accepted).toBe(true);
  const detail = JSON.parse((await exec(bin, ['show', receipt.executionId, '--data', setup.paths.data], {cwd})).stdout);
  expect(detail).toMatchObject({request: {input: {commit: sha, question: '说明这个项目的主要模块及调用关系'}}, execution: {status: 'queued'}, attempts: []});
  await stop(child);
}, 20000);
