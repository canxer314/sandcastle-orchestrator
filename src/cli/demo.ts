import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { call, ControlCallError } from '../control.js';
import { git } from '../execution.js';
import { acquireControlLock } from '../lock.js';
import { select, separate, verify, dependencies, probe, type Check } from './onboarding.js';
import { assertDemoIdle, stopped, type Detail } from './demo-safety.js';
import { queryCommand } from './human.js';

// Budgets apply to the demo client, never to daily capability execution.
const STARTUP = 30_000;
const EXECUTION = 300_000;
const CLEANUP = 30_000;

export async function demo(values: Record<string, unknown>) {
  const runId = randomUUID();
  const source = 'sandcastle-demo';
  const result: Record<string, any> = {runId, source, deduplicationKey:runId, acceptance:'not-submitted', testResult:'not-run', executionStopped:true, serviceExited:true, gaps:[]};
  let child: ChildProcess | undefined;
  let ready = false;
  let exited = false;
  let interrupted = 0;
  let active: AbortController | undefined;
  let releaseDemo: (() => void) | undefined;
  let journal: string | undefined;
  let serviceLog: Awaited<ReturnType<typeof open>> | undefined;
  let detail: Detail | undefined;
  let cleanupDeadline: number | undefined;
  let failed = false;
  const interrupt = () => { interrupted++; active?.abort(); };
  process.on('SIGINT', interrupt);
  const save = async (settled = false) => {
    if (!journal) return;
    const temporary = `${journal}.tmp`;
    await writeFile(temporary, `${JSON.stringify({...result, settled}, null, 2)}\n`, {mode:0o600});
    await rename(temporary, journal);
  };
  const gap = (error: unknown) => result.gaps.push(error instanceof Error ? error.message : String(error));
  const checkWait = (deadline: number, cleanup = false) => {
    if (interrupted >= (cleanup ? 2 : 1)) throw Error('Demo interrupted');
    if (Date.now() >= deadline) throw Error('Demo wait budget expired');
  };
  const request = async (message: unknown, deadline: number, cleanup = false) => {
    checkWait(deadline, cleanup);
    const controller = new AbortController(); active = controller;
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
    try { return await call(result.socket, message, controller.signal); }
    finally { clearTimeout(timer); if (active === controller) active = undefined; }
  };
  const pause = async (deadline: number, cleanup = false) => {
    checkWait(deadline, cleanup);
    await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
  };
  const captureLogs = async (deadline: number, cleanup = false) => {
    const logs = await request({command:'logs', id:result.executionId, attempt:result.attemptId}, deadline, cleanup) as any;
    result.testLogs = {
      ...(logs.stdout !== null ? {stdout:join(result.data, 'attempts', result.attemptId, 'stdout.log')} : {}),
      ...(logs.stderr !== null ? {stderr:join(result.data, 'attempts', result.attemptId, 'stderr.log')} : {}),
      complete:logs.complete, availability:logs.availability, truncated:logs.truncated,
    };
  };
  const observe = async (deadline: number, cleanup = false) => {
    detail = await request({command:'show', id:result.executionId}, deadline, cleanup) as Detail;
    result.executionStopped = stopped(detail);
    result.executionStatus = detail.execution?.status;
    const attempt = detail.attempts.at(-1);
    if (attempt) {
      result.attemptId = attempt.id;
      if (!['starting', 'running'].includes(attempt.runState)) {
        try { await captureLogs(deadline, cleanup); } catch (error) { gap(error); }
      }
    }
    if (!result.executionStopped) result.testResult = 'unknown';
    else if (detail.execution?.status === 'cancelled') result.testResult = 'cancelled';
    else if (detail.execution?.status === 'start_failed' || attempt?.contract === 'error') result.testResult = 'runtime-failure';
    else if (detail.execution?.status === 'completed' && attempt?.actualSha === result.sha && attempt.contract === 'valid'
      && attempt.containerState?.Running === false && attempt.containerState?.Status === 'exited'
      && Number.isInteger(attempt.business?.exitCode) && attempt.business.exitCode === attempt.containerState.ExitCode
      && attempt.business.passed === (attempt.business.exitCode === 0)) result.testResult = attempt.business.passed ? 'passed' : 'failed';
    else result.testResult = 'unknown';
  };
  try {
    const {paths, marker} = await select(values);
    Object.assign(result, paths, {socket:join(paths.data, 'control.sock')});
    if (!marker) throw Error('No initialization marker; run init first');
    await separate(paths);
    releaseDemo = await acquireControlLock(join(paths.data, 'demo.lock'));
    await mkdir(join(paths.data, 'demo-runs'), {recursive:true, mode:0o700});
    result.serviceLog = join(paths.data, 'demo-runs', `${runId}.service.log`);
    serviceLog = await open(result.serviceLog, 'wx', 0o600);
    // Check while locked, then repeat inside the child under its own control lock.
    const releaseControl = await acquireControlLock(join(paths.data, 'control.lock'));
    try { await assertDemoIdle(paths.data); } finally { releaseControl(); }
    const checks: Check[] = [];
    await dependencies(checks, true);
    const config = await verify(paths, marker);
    const capability = config.capabilities.find(c => c.id === marker.capabilityId)!;
    const environment = config.environments.find(e => e.id === capability.environment);
    if (!environment?.docker || config.roleBindings?.some(b => b.role === marker.capabilityId)) throw Error('Demo requires a deterministic Docker capability, not an agent role');
    await probe(checks, `image:${environment.docker.image}`, 'docker', ['image', 'inspect', environment.docker.image], `Prepare the trusted image manually: docker pull ${environment.docker.image}`);
    if (checks.some(c => !c.ok)) throw Error(checks.filter(c => !c.ok).map(c => `${c.detail}. ${c.fix}`).join('\n'));
    result.sha = String((await git(paths.demoRepo, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout).trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result.sha)) throw Error('Expected full commit SHA');
    await capability.validate(result.sha);
    if (capability.execution!.commit(result.sha) !== result.sha) throw Error('Demo capability must execute the selected full SHA');
    const tree = String((await git(paths.demoRepo, ['ls-tree', '-rz', '--full-tree', result.sha])).stdout);
    if (tree.split('\0').filter(Boolean).some(entry => !/^(100644|100755) blob /.test(entry))) throw Error('Execution snapshot does not support symlinks or submodules');
    if (String((await git(paths.demoRepo, ['status', '--porcelain'])).stdout).trim()) console.error('仅测已提交版本 / Only the committed version will be tested; working tree changes are preserved.');
    if (interrupted) throw Error('Demo interrupted before startup');
    journal = join(paths.data, 'demo-runs', `${runId}.json`);
    result.journal = journal;
    await save();
    console.error(`Demo: starting service; log: ${result.serviceLog}`);
    const startDeadline = Date.now() + STARTUP;
    child = fork(new URL(`./demo-service.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url), [paths.data, paths.config, runId], {
      detached:true, stdio:['ignore', serviceLog.fd, serviceLog.fd, 'ipc'],
    });
    result.serviceExited = false;
    result.servicePid = child.pid;
    child.on('message', message => { if ((message as any)?.ready === true && (message as any).runId === runId) ready = true; });
    child.on('error', error => { gap(error); exited = true; });
    child.on('exit', (code, signal) => { exited = true; result.serviceExit = {code, signal}; });
    await save();
    while (!ready) {
      if (exited) throw Error('Demo service exited before ready; inspect service log');
      await pause(startDeadline);
    }
    await request({command:'list'}, startDeadline);
    checkWait(startDeadline);
    console.error('Demo: service ready and read-only socket query verified; submitting once');
    // Persist uncertainty before sending: a crash/lost receipt cannot permit blind resubmission.
    result.acceptance = 'unknown'; result.executionStopped = false; result.testResult = 'unknown';
    await save();
    const executeDeadline = Date.now() + EXECUTION;
    let submitted = false;
    try {
      checkWait(executeDeadline);
      submitted = true;
      const receipt = await request({command:'submit', submission:{repo:marker.repoId, capability:marker.capabilityId, input:result.sha, source, deduplicationKey:runId}}, executeDeadline) as any;
      if (receipt.accepted === true && typeof receipt.executionId === 'string') {
        result.acceptance = 'accepted'; result.executionId = receipt.executionId; result.requestId = receipt.requestId;
      } else if (receipt.accepted === false) {
        result.acceptance = 'rejected'; result.requestId = receipt.requestId; result.executionStopped = true; result.testResult = 'not-run';
        throw Error(`Demo submission rejected: ${receipt.reason}`);
      } else throw Error('Invalid submission receipt');
    } catch (error) {
      if (!submitted) { result.acceptance = 'not-submitted'; result.executionStopped = true; result.testResult = 'not-run'; }
      if (error instanceof ControlCallError && (!error.sent || error.rejected)) {
        result.acceptance = error.rejected ? 'rejected' : 'not-submitted'; result.executionStopped = true; result.testResult = 'not-run';
      }
      if (result.acceptance !== 'unknown') throw error;
      gap(error);
      cleanupDeadline = Date.now() + CLEANUP;
      const matches = await request({command:'show', source, deduplicationKey:runId}, cleanupDeadline, true) as Detail[];
      const accepted = matches.filter(d => d.execution);
      if (accepted.length === 1) {
        result.acceptance = 'accepted'; result.executionId = accepted[0].execution!.id; result.requestId = accepted[0].request.id;
        if (!interrupted) cleanupDeadline = undefined;
      } else if (matches.length && accepted.length === 0) {
        result.acceptance = 'rejected'; result.executionStopped = true; result.testResult = 'not-run';
        throw Error('Read-only source/key query confirms rejection');
      } else throw Error('Acceptance unknown: no unique accepted record. No match is not permission to resend');
    }
    await save();
    console.error(`Demo: execution ${result.executionId}; waiting for result and stop evidence`);
    do {
      await observe(cleanupDeadline ?? executeDeadline, !!cleanupDeadline);
      if (result.executionStopped || detail?.execution?.status === 'unknown') break;
      if (cleanupDeadline) throw Error('Receipt recovered; entering bounded cancellation and cleanup');
      await pause(cleanupDeadline ?? executeDeadline, !!cleanupDeadline);
    } while (true);
  } catch (error) { failed = true; gap(error); }
  finally {
    cleanupDeadline ??= Date.now() + CLEANUP;
    if (child) {
      console.error('Demo: checking stop evidence and closing this service');
      try {
        if (result.executionId && !result.executionStopped && !exited) {
          await request({command:'cancel', id:result.executionId, reason:interrupted ? 'Demo interrupted' : 'Demo wait ended'}, cleanupDeadline, true);
          do {
            await observe(cleanupDeadline, true);
            if (result.executionStopped) break;
            await pause(cleanupDeadline, true);
          } while (true);
        }
      } catch (error) { gap(error); }
      if (result.attemptId && !exited) {
        try {
          await captureLogs(cleanupDeadline, true);
        } catch (error) { gap(error); }
      }
      // SIGTERM asks only our child to close. It is never used as execution stop evidence.
      if (!exited) child.kill('SIGTERM');
      try { while (!exited) await pause(cleanupDeadline, true); } catch (error) { gap(error); }
      result.serviceExited = exited;
      if (child.connected) child.disconnect();
      child.unref();
    }
    if (result.acceptance === 'unknown' || !result.executionStopped || !result.serviceExited || result.testResult === 'unknown') {
      result.status = 'unknown'; result.exitCode = 2;
      if (!result.executionStopped) gap('未确认停止 / Execution stop is unconfirmed; cancellation receipt, service exit and missing socket are not stop evidence');
    } else {
      result.status = interrupted ? 'interrupted' : !failed && result.testResult === 'passed' ? 'passed' : 'failed';
      result.exitCode = interrupted ? 130 : result.status === 'passed' ? 0 : 1;
    }
    if (result.data) {
      result.inspect = queryCommand('show', {id:result.executionId, source, deduplicationKey:runId, data:result.data, offline:true});
      result.instructions = 'Inspect retained records and service/attempt logs. Verify container and capability stop independently before using confirm-stop/resolve. Never start serve merely to inspect evidence or resend an uncertain submission. See docs/demo.md for journal reconciliation.';
    }
    try {
      await serviceLog?.appendFile(`\nDemo client result: ${JSON.stringify(result)}\n`);
      await save(result.status !== 'unknown');
    } catch (error) { gap(error); result.status = 'unknown'; result.exitCode = 2; }
    await serviceLog?.close();
    releaseDemo?.();
    process.removeListener('SIGINT', interrupt);
  }
  process.exitCode = result.exitCode;
  if (values.json) console.log(JSON.stringify(result));
  else console.log([
    `Demo: ${result.status}`, `Test: ${result.testResult}`, `Execution stopped: ${result.executionStopped}`, `This service exited: ${result.serviceExited}`,
    ...['sha', 'executionId', 'attemptId', 'servicePid', 'socket', 'serviceLog', 'journal'].filter(k => result[k] !== undefined).map(k => `${k}: ${result[k]}`),
    ...(result.testLogs ? [`Test logs: ${JSON.stringify(result.testLogs)}`] : []),
    ...result.gaps.map((g: string) => `Evidence/diagnostic: ${g}`), ...(result.inspect ? [`Inspect: ${result.inspect}`, result.instructions] : []),
  ].join('\n'));
}
