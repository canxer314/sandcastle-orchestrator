import { randomUUID } from 'node:crypto';
import { acquireControlLock } from '../lock.js';
import { assertDemoIdle } from './demo-safety.js';
import { execFile } from 'node:child_process';
import { access, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';
import { loadConfiguration } from '../config.js';
import { git } from '../execution.js';
import { checkDataSeparation, contains, physicalPath } from '../paths.js';

const exec = promisify(execFile);
const image = 'node:22.22-alpine';
export type Paths = { config: string; data: string; demoRepo: string };
export type Marker = Paths & { layoutVersion: 1; repoId: string; capabilityId: string };
export type Check = { name: string; ok: boolean; detail: string; fix?: string };

async function exists(path: string) {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function nearestDirectory(path: string): Promise<string> {
  if (await exists(path)) return (await stat(path)).isDirectory() ? path : dirname(path);
  return nearestDirectory(dirname(path));
}

function overlaps(a: string, b: string) {
  return contains(a, b) || contains(b, a);
}

export async function separate(paths: Paths) {
  if (paths.config === join(dirname(paths.config), 'package.json')) throw Error('Configuration file conflicts with the generated ESM package.json; choose a separate TypeScript file');
  const app = await physicalPath(resolve(import.meta.dirname, '../..'));
  const configDir = await physicalPath(dirname(paths.config));
  await checkDataSeparation(paths.data, paths.config, { version: 'init', repos: [{ id: 'demo', location: paths.demoRepo }], environments: [], capabilities: [] });
  for (const [a, b] of [[configDir, paths.demoRepo], [configDir, app], [paths.demoRepo, app]]) {
    if (overlaps(a, b)) throw Error(`Resources must be separate (no containment): ${a} and ${b}`);
  }
  for (const path of [configDir, paths.data, paths.demoRepo]) {
    let checkout: string;
    try { checkout = String((await git(await nearestDirectory(path), ['rev-parse', '--show-toplevel'])).stdout).trim(); }
    catch (error) {
      // A broken/inaccessible Git checkout must not turn into permission to write inside it.
      let parent = await nearestDirectory(path);
      while (true) {
        if (await exists(join(parent, '.git'))) throw Error(`Cannot verify existing Git checkout: ${parent}; preserve it and repair Git metadata before init`);
        if (dirname(parent) === parent) break;
        parent = dirname(parent);
      }
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && ((error as { code?: number }).code !== 128 || !(error as { stderr?: string }).stderr?.includes('not a git repository'))) throw Error(`Cannot verify Git checkout separation: ${path}`);
      continue;
    }
    if (path === paths.demoRepo && await physicalPath(checkout) === paths.demoRepo) continue;
    if (overlaps(path, await physicalPath(checkout))) throw Error(`Resource must be separate from an existing Git checkout: ${path} (${checkout})`);
  }
}

export async function select(values: Record<string, unknown>): Promise<{ paths: Paths; marker?: Marker }> {
  const root = join(homedir(), '.sandcastle-orchestrator');
  const paths = {
    config: resolve(String(values.config ?? join(root, 'config/config.ts'))),
    data: resolve(String(values.data ?? join(root, 'data'))),
    demoRepo: resolve(String(values['demo-repo'] ?? join(root, 'demo-repo'))),
  };
  for (const name of ['config', 'data', 'demo-repo']) if (values[name] !== undefined && !String(values[name]).trim()) throw Error(`Invalid --${name}`);
  const markerPath = join(paths.data, 'init.json');
  let marker: Marker | undefined;
  if (await exists(markerPath)) {
    const info = await lstat(markerPath);
    if (!info.isFile() || info.size > 64 * 1024) throw Error(`Invalid initialization marker: ${markerPath}; preserve it and inspect manually`);
    const parsed = JSON.parse(await readFile(markerPath, 'utf8'));
    if (parsed?.layoutVersion !== 1) throw Error(`Unsupported initialization layout version: ${parsed?.layoutVersion}; use a matching CLI version. Preserve ${markerPath}`);
    for (const key of ['config', 'data', 'demoRepo', 'repoId', 'capabilityId']) {
      if (typeof parsed[key] !== 'string' || !parsed[key]) throw Error(`Incomplete initialization marker: ${markerPath} (${key}); preserve resources and inspect manually`);
    }
    for (const key of ['config', 'data', 'demoRepo'] as const) {
      if (!parsed[key].startsWith(sep)) throw Error(`Marker path must be absolute: ${key}`);
      if ((key === 'data' || values[key === 'demoRepo' ? 'demo-repo' : key] !== undefined) && await physicalPath(paths[key]) !== await physicalPath(parsed[key])) throw Error(`Explicit ${key} conflicts with initialization marker: ${paths[key]} != ${parsed[key]}`);
      paths[key] = parsed[key];
    }
    marker = parsed;
  }
  for (const key of ['config', 'data', 'demoRepo'] as const) paths[key] = await physicalPath(paths[key]);
  return { paths, marker };
}

export async function probe(checks: Check[], name: string, binary: string, args: string[], fix: string) {
  try {
    const result = await exec(binary, args, { timeout: 5_000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH } });
    checks.push({ name, ok: true, detail: result.stdout.trim() || result.stderr.trim() || 'Available' });
  } catch {
    checks.push({ name, ok: false, detail: `${name} unavailable or check failed`, fix });
  }
}

export async function dependencies(checks: Check[], doctor: boolean) {
  checks.push({ name: 'platform', ok: process.platform === 'linux', detail: `${process.platform}/${process.arch}`, fix: 'Use Linux or WSL with Docker Engine.' });
  checks.push({ name: 'node', ok: Number(process.versions.node.split('.')[0]) >= 24, detail: process.version, fix: 'Install Node.js 24+ from https://nodejs.org/en/download.' });
  await probe(checks, 'git', 'git', ['--version'], 'Install Git (Debian/Ubuntu: sudo apt-get install git).');
  if (doctor) {
    await probe(checks, 'flock', 'flock', ['--version'], 'Install util-linux (Debian/Ubuntu: sudo apt-get install util-linux).');
    await probe(checks, 'docker', 'docker', ['--version'], 'Install Docker Engine: https://docs.docker.com/engine/install/.');
    await probe(checks, 'docker-daemon', 'docker', ['info', '--format', '{{json .ServerVersion}}'], 'Start Docker Engine (sudo systemctl start docker) and ask an administrator to grant access; verify docker info.');
  }
}

export async function verify(paths: Paths, marker: Marker) {
  for (const path of [paths.config, join(dirname(paths.config), 'package.json')]) {
    if (!(await stat(path)).isFile()) throw Error(`Missing regular configuration file: ${path}`);
  }
  if (JSON.parse(await readFile(join(dirname(paths.config), 'package.json'), 'utf8')).type !== 'module') throw Error('Configuration directory must explicitly use ESM (package.json type: module)');
  if (!(await stat(paths.data)).isDirectory() || !(await stat(paths.demoRepo)).isDirectory()) throw Error('Missing data or demo directory');
  const top = String((await git(paths.demoRepo, ['rev-parse', '--show-toplevel'])).stdout).trim();
  if (await physicalPath(top) !== paths.demoRepo) throw Error('Demo repository is not an independent Git root');
  await git(paths.demoRepo, ['rev-parse', '--verify', 'HEAD^{commit}']);
  console.error(`Loading trusted TypeScript configuration (executes code): ${paths.config}`);
  const stdout = process.stdout.write;
  let config;
  try {
    // Trusted config may print diagnostics; keep the CLI result stream machine-readable.
    process.stdout.write = process.stderr.write.bind(process.stderr);
    config = await loadConfiguration(paths.config);
  } finally { process.stdout.write = stdout; }
  await checkDataSeparation(paths.data, paths.config, config);
  const repo = config.repos.find(repo => repo.id === marker.repoId);
  const capability = config.capabilities.find(capability => capability.id === marker.capabilityId);
  if (!repo || await physicalPath(repo.location) !== paths.demoRepo || !capability?.execution) throw Error('Initialization resources do not match the configured demo repo/capability');
  return config;
}

function template(paths: Paths) {
  return `// Trusted TypeScript: loading this file executes host code. No runtime imports required.
export default {
  version: 'demo-config-v1',
  repos: [{ id: 'demo', location: ${JSON.stringify(paths.demoRepo)} }],
  environments: [{ id: 'demo-test', docker: { image: '${image}' } }],
  capabilities: [{
    id: 'demo-test', environment: 'demo-test',
    validate(input: unknown) {
      if (typeof input !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input)) throw Error('Expected a full commit SHA');
    },
    execution: { commit(input: unknown) { return input as string; } },
    async run(context: { exec(argv: string[]): Promise<{ exitCode: number }> }) {
      const result = await context.exec(['node', '--test', '/workspace/test.cjs']);
      return { business: { passed: result.exitCode === 0, exitCode: result.exitCode } };
    },
  }],
};
`;
}

async function createDemoRepo(repo: string) {
  await writeFile(join(repo, 'test.cjs'), "const { test } = require('node:test');\nconst assert = require('node:assert/strict');\ntest('deterministic addition', () => assert.equal(2 + 2, 4));\n", { flag: 'wx', mode: 0o600 });
  await git(repo, ['init', '--template=']);
  await git(repo, ['add', '--', 'test.cjs']);
  await git(repo, ['-c', 'user.name=Sandcastle Demo', '-c', 'user.email=demo@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Initialize deterministic demo']);
}

async function resetDemo(paths: Paths, marker: Marker, yes: boolean) {
  console.error(`Reset will discard ALL demo repository modifications: ${paths.demoRepo}. Configuration, data, records and logs are retained.`);
  const releaseDemo = await acquireControlLock(join(paths.data, 'demo.lock'));
  try {
    const releaseControl = await acquireControlLock(join(paths.data, 'control.lock'));
    try {
      await assertDemoIdle(paths.data);
      await separate(paths);
      await verify(paths, marker);
      const before = await lstat(paths.demoRepo);
      if (!before.isDirectory() || !(await lstat(join(paths.demoRepo, '.git'))).isDirectory()) throw Error('Reset requires an independent demo repository, not a linked worktree');
      const common = String((await git(paths.demoRepo, ['rev-parse', '--git-common-dir'])).stdout).trim();
      if (await physicalPath(resolve(paths.demoRepo, common)) !== join(paths.demoRepo, '.git')) throw Error('Reset refuses shared or external Git metadata');
      if (!yes) {
        const prompt = createInterface({input:process.stdin, output:process.stderr});
        try { if (!/^y(es)?$/i.test((await prompt.question('Discard demo changes and rebuild this repository? [y/N] ')).trim())) throw Error('Reset declined; no resources changed'); }
        finally { prompt.close(); }
      }
      await separate(paths);
      await assertDemoIdle(paths.data);
      const after = await lstat(paths.demoRepo);
      if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino) throw Error('Demo repository changed during confirmation; preserve it');
      const staging = `${paths.demoRepo}.reset-${randomUUID()}`;
      const previous = `${staging}.previous`;
      await mkdir(staging, {mode:0o700});
      try { await createDemoRepo(staging); }
      catch (error) { await rm(staging, {recursive:true, force:true}); throw error; }
      await rename(paths.demoRepo, previous);
      try { await rename(staging, paths.demoRepo); }
      catch (error) { await rename(previous, paths.demoRepo); throw error; }
      await rm(previous, {recursive:true});
    } finally { releaseControl(); }
  } finally { releaseDemo(); }
}

export async function onboarding(command: string, values: Record<string, unknown>) {
  const checks: Check[] = [];
  let paths: Paths | undefined;
  let status = 'blocked';
  let error: string | undefined;
  try {
    // Refuse immediately rather than waiting on stdin in scripts or JSON mode.
    if (command === 'init' && !values.yes && (values.json || !process.stdin.isTTY || !process.stderr.isTTY)) throw Error('init requires --yes in noninteractive or JSON mode; no resources changed');
    await dependencies(checks, command === 'doctor');
    const selected = await select(values); paths = selected.paths;
    await separate(paths);
    if (selected.marker) {
      const config = await verify(paths, selected.marker);
      status = 'reused';
      if (values['reset-demo']) {
        if (checks.some(check => !check.ok)) throw Error('Reset dependencies missing');
        await resetDemo(paths, selected.marker, values.yes === true);
        status = 'reset';
      }
      if (command === 'doctor') {
        const images = new Set(config.environments.flatMap(env => env.docker ? [env.docker.image] : []));
        for (const selectedImage of images) await probe(checks, `image:${selectedImage}`, 'docker', ['image', 'inspect', selectedImage], `Deploy a trusted image manually: docker pull ${selectedImage}. Image presence is not authentication verification.`);
      }
    } else if (values['reset-demo']) {
      throw Error('Reset requires a complete existing initialization marker; no resources changed');
    } else if (command === 'doctor') {
      status = 'uninitialized';
      checks.push({ name: 'initialization', ok: false, detail: 'No initialization marker; configuration was not loaded.', fix: 'Run init with these same resource paths after reviewing them.' });
      await probe(checks, `image:${image}`, 'docker', ['image', 'inspect', image], `Deploy a trusted image manually: docker pull ${image}.`);
      for (const path of [dirname(paths.config), paths.data, paths.demoRepo]) {
        if (await exists(path)) throw Error(`Existing or incomplete resource without initialization marker: ${path}; preserve it and inspect manually or choose new separate paths`);
      }
    } else {
      if (!['.ts', '.mts'].includes(extname(paths.config))) throw Error('New demo configuration must use .ts or .mts so its TypeScript template can be loaded');
      if (checks.some(check => !check.ok)) throw Error('Initialization dependencies missing; follow the repair steps before init');
      for (const path of [dirname(paths.config), paths.data, paths.demoRepo]) {
        if (await exists(path)) throw Error(`Existing or incomplete resource: ${path}; preserve it, inspect manually or choose new separate paths. init never overwrites or repairs resources`);
        await access(await nearestDirectory(path), constants.W_OK | constants.X_OK);
      }
      const plan = [dirname(paths.config), join(dirname(paths.config), 'package.json'), paths.config, paths.data, join(paths.data, 'init.json'), paths.demoRepo, join(paths.demoRepo, 'test.cjs'), join(paths.demoRepo, '.git')];
      console.error(`Will create:\n${plan.map(path => `  ${path}`).join('\n')}`);
      if (!values.yes) {
        const prompt = createInterface({ input: process.stdin, output: process.stderr });
        try { if (!/^y(es)?$/i.test((await prompt.question('Create these demo resources? [y/N] ')).trim())) throw Error('Initialization declined; no resources changed'); }
        finally { prompt.close(); }
      }
      // Recheck after confirmation; exclusive creation never replaces an existing resource.
      await separate(paths);
      for (const path of [dirname(paths.config), paths.data, paths.demoRepo]) if (await exists(path)) throw Error(`Resource appeared during confirmation: ${path}; preserve it`);
      for (const path of [dirname(paths.config), paths.data, paths.demoRepo]) {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await mkdir(path, { mode: 0o700 });
      }
      await writeFile(join(dirname(paths.config), 'package.json'), '{"private":true,"type":"module"}\n', { flag: 'wx', mode: 0o600 });
      await writeFile(paths.config, template(paths), { flag: 'wx', mode: 0o600 });
      await createDemoRepo(paths.demoRepo);
      const marker: Marker = { layoutVersion: 1, ...paths, repoId: 'demo', capabilityId: 'demo-test' };
      await writeFile(join(paths.data, 'init.json'), `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      status = 'created';
    }
    if (command === 'doctor') {
      for (const path of [paths.data, dirname(paths.config), paths.demoRepo]) {
        await access(await nearestDirectory(path), constants.R_OK | constants.W_OK | constants.X_OK);
      }
      checks.push({ name: 'resources', ok: true, detail: status === 'reused' ? 'Marker, trusted configuration and committed Git repository verified; user edits are allowed.' : 'Selected paths are separate and their existing parents accessible.' });
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : 'Onboarding failed';
    checks.push({ name: 'resources', ok: false, detail: error, fix: 'Preserve existing resources. Inspect the reported paths and use matching configuration/layout or choose new separate paths; do not delete evidence to retry.' });
  }
  const ok = !error && checks.every(check => check.ok);
  if (!ok) process.exitCode = 1;
  const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
  const selectors = paths ? ` --data ${quote(paths.data)} --config ${quote(paths.config)} --demo-repo ${quote(paths.demoRepo)}` : '';
  const next = `sandcastle-orchestrator ${status === 'uninitialized' ? 'init' : command === 'doctor' && ok ? 'demo' : 'doctor'}${selectors}`;
  const result = { ok, status, paths, checks, ...(error ? { error } : {}), next, unavailable: 'No service, container or model was started by this command.' };
  if (values.json) console.log(JSON.stringify(result));
  else console.log([
    `${command}: ${ok ? status : 'conditions not met'}`,
    ...(paths ? Object.entries(paths).map(([name, path]) => `${name}: ${path}`) : []),
    ...checks.map(check => `${check.ok ? 'OK' : 'FAIL'} ${check.name}: ${check.detail}${!check.ok && check.fix ? `\n  Fix: ${check.fix}` : ''}`),
    `Next: ${next}`, result.unavailable,
  ].join('\n'));
}
