import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
let directory: string;
let prefix: string;
let cwd: string;
let installed: string;
let bin: string;
let packed: { filename: string; files: { path: string; mode: number }[] };
const children = new Set<ChildProcess>();

async function start(config: string, data: string, path = process.env.PATH) {
  const child = spawn(bin, ['serve', '--config', config, '--data', data], { cwd, env: {...process.env, PATH:path} });
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
  const commands = ['serve', 'submit', 'show', 'list', 'logs', 'artifact', 'cancel', 'confirm-stop', 'resolve', 'retry', 'cleanup', 'pause', 'resume', 'maintenance', 'restore-review'];
  for (const command of [undefined, ...commands]) {
    const result = await exec(bin, [...(command ? [command] : []), '--help', '--config', config, '--data', data, '--socket', join(data, 'absent.sock')], { cwd });
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('sandcastle-orchestrator');
    expect(result.stdout).toContain('Example:');
    if (command === 'serve') expect(result.stdout).toContain('--maintenance');
    if (command && command !== 'serve') expect(result.stdout).toContain('--socket');
  }
  const discovery = await exec(bin, [], { cwd });
  for (const command of commands) expect(discovery.stdout).toContain(command);
  expect(discovery.stdout).toMatch(/init.*doctor.*demo.*setup.*unreleased/i);
  expect(await readdir(cwd)).toEqual(before);
  await expect(exec(bin, ['init', '--help'], { cwd })).rejects.toMatchObject({ code: 1 });
});

test('unknown commands retain JSON errors and cannot match inherited object properties', async () => {
  for (const command of ['unknown', 'init', 'toString', '__proto__']) {
    await expect(exec(bin, [command], { cwd })).rejects.toMatchObject({
      code: 1,
      stdout: '',
      stderr: `${JSON.stringify({ error: 'Unknown command; use serve, submit, show, list, logs, artifact, cancel, confirm-stop, resolve, retry, cleanup, pause, resume, maintenance or restore-review' })}\n`,
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

test('installed CLI completes a fixed-SHA capability using only a controlled Docker adapter', async () => {
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
  await writeFile(join(adapterDir, 'docker'), `#!/bin/sh
if [ "$1" = run ]; then echo packaged-test; echo controlled-stderr >&2; exit 0; fi
if [ "$1" = inspect ]; then echo '{"Running":false,"Status":"exited","ExitCode":0}'; exit 0; fi
exit 1
`, {mode:0o700});
  const config = join(configDir, 'config.ts');
  // No package.json: existing tsx CommonJS-compatible configuration remains supported.
  await writeFile(config, `export default {
    version:'packaged-execution', repos:[{id:'example',location:${JSON.stringify(checkout)}}],
    environments:[{id:'test',docker:{image:'controlled:test'}}], capabilities:[{
      id:'test-commit',environment:'test',validate(input: unknown){if(typeof input!=='string')throw Error('SHA required');},
      execution:{commit(input: unknown){return input as string;}},
      async run(ctx: any){const result=await ctx.exec(['sh','/workspace/test.sh']);return {business:{passed:result.exitCode===0}};}
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
  await stop(child);
}, 30_000);
