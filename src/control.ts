import { createServer, request } from 'node:http';
import { mkdir, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireControlLock } from './lock.js';
import { checkDataSeparation } from './paths.js';
import { showQuery, queryEvidence } from './record-queries.js';
import { Records } from './records.js';
import { serviceLog } from './service-log.js';
import type { Submission } from './config.js';

export async function serve(data: string, configPath: string, maintenanceMode = 'normal') {
  if (!['normal', 'paused', 'restore'].includes(maintenanceMode)) throw Error('Invalid startup maintenance mode');
  const { loadConfiguration } = await import('./config.js');
  const { executeRole } = await import('./roles.js');
  const { execute, cancelExecution } = await import('./execution.js');
  const config = await loadConfiguration(configPath);
  await checkDataSeparation(data, configPath, config);
  process.umask(0o077);
  await mkdir(data, { recursive: true, mode: 0o700 });
  await chmod(data, 0o700);
  const releaseLock = await acquireControlLock(join(data, 'control.lock'));
  let records: Records;
  try {
    records = new Records(join(data, 'records.sqlite'));
    records.startMaintenance(maintenanceMode);
  } catch (error) {
    releaseLock();
    throw error;
  }
  const executionFailed = (executionId: string, error: unknown) => {
    serviceLog('execution_failure', error, executionId);
    try { records.markExecutionFailure(executionId, config.version); }
    catch (saveError) { serviceLog('execution_failure_save_failed', saveError, executionId); }
  };
  let closing = false;
  const dispatch = () => {
    if (closing || records.maintenance().startsPaused) return;
    // ponytail: scan persisted records in the single control writer; add indexed
    // queue queries only if the local history makes this scan expensive.
    const details = records.list();
    const occupied = details.flatMap(detail => detail.attempts
      .filter(attempt => attempt.kind === 'agent' && !attempt.stopConfirmation
        && !['completed','cancelled','resolved','start_failed'].includes(attempt.runState))
      .map(() => String(detail.request.repo)));
    let global = occupied.length;
    const perRepo = new Map<string, number>();
    for (const repo of occupied) perRepo.set(repo, (perRepo.get(repo) ?? 0) + 1);
    for (const detail of details) {
      if (detail.execution?.status !== 'queued') continue;
      if (!config.repos.some(repo => repo.id === detail.request.repo)) continue;
      const capability = config.capabilities.find(capability => capability.id === detail.request.capability);
      const isPrimaryAgent = config.roleBindings?.some(binding => binding.role === detail.request.capability);
      if (config.roles?.some(role => role.id === detail.request.capability) && !isPrimaryAgent) continue;
      if (!isPrimaryAgent && (!records.canStart(String(detail.execution.id)) || !capability?.execution || !config.environments.find(environment => environment.id === capability.environment)?.docker)) continue;
      if (isPrimaryAgent) {
        const repo = config.repos.find(repo => repo.id === detail.request.repo);
        if (!repo || global >= (config.primaryAgentLimit ?? Infinity)
          || (perRepo.get(repo.id) ?? 0) >= (repo.primaryAgentLimit ?? 1)) continue;
      }
      const executionId = String(detail.execution.id);
      // Both entrypoints save beginAttempt synchronously before their first await.
      const execution = isPrimaryAgent ? executeRole(records, config, executionId, data) : execute(records, config, executionId, data);
      if (isPrimaryAgent && records.show(executionId).execution?.status !== 'queued') {
        global++;
        perRepo.set(String(detail.request.repo), (perRepo.get(String(detail.request.repo)) ?? 0) + 1);
      }
      void execution.catch(error => executionFailed(executionId, error)).finally(() => {
        if (!closing && records.show(executionId).execution?.status !== 'queued') {
          try { dispatch(); } catch (error) { serviceLog('dispatch_failure', error); }
        }
      });
    }
  };
  const socket = join(data, 'control.sock');
  const server = createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body);
      let result;
      switch (message?.command) {
        case 'maintenance':
          result = records.maintenance();
          break;
        case 'pause':
        case 'resume':
        case 'restore-review':
          result = records.manageMaintenance(message.command, message.target ?? 'all', {source:message.source, reason:message.reason, handling:message.handling, externalResults:message.externalResults, backupPoint:message.backupPoint});
          if (message.command === 'resume') dispatch();
          break;
        case 'submit':
          if (records.maintenance().admissionPaused) throw Error('Admission is paused');
          if (!message.submission || !Object.hasOwn(message.submission, 'input')) throw new Error('Missing input');
          for (const field of ['repo', 'capability', 'source']) {
            if (typeof message.submission[field] !== 'string' || !message.submission[field]) throw new Error(`Invalid ${field}`);
          }
          for (const field of ['deduplicationKey', 'scheduledAt']) {
            const value = message.submission[field];
            if (value !== undefined && (typeof value !== 'string' || !value)) throw new Error(`Invalid ${field}`);
          }
          if (message.submission.scheduledAt !== undefined) {
            const time = message.submission.scheduledAt;
            const format = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
            const calendar = new Date(`${time.slice(0, 10)}T00:00:00Z`);
            if (!format.test(time) || !Number.isFinite(Date.parse(time))
              || !Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== time.slice(0, 10)) throw new Error('Invalid scheduledAt');
          }
          const submitted = await records.submit(message.submission as Submission, config);
          result = submitted.receipt;
          dispatch();
          break;
        case 'cleanup':
          result = records.cleanup(data);
          break;
        case 'list':
          result = records.list(message.repo, message.status, message.source);
          break;
        case 'logs':
        case 'artifact': {
          result = await queryEvidence(records,data,message);
          break;
        }
        case 'cancel':
          if (typeof message.reason !== 'string' || !message.reason.trim()) throw Error('Missing reason');
          const cancelledDetail = records.show(message.id);
          if(message.attempt && message.attempt !== cancelledDetail.attempts.at(-1)?.id) throw Error('Only the current attempt can be managed');
          result = records.cancel(message.id, message.reason);
          void cancelExecution(records,message.id).catch(error=>serviceLog('management_failure', error, String(message.id)));
          break;
        case 'confirm-stop':
        case 'resolve':
        case 'retry': {
          for (const field of ['source','handling','reason']) if (typeof message[field] !== 'string' || !message[field].trim()) throw Error(`Missing ${field}`);
          const detail = records.show(message.id);
          if (message.attempt && message.attempt !== detail.attempts.at(-1)?.id && !(message.command === 'confirm-stop' && message.call !== undefined)) throw Error('Only the current attempt can be managed');
          if(message.command==='retry') {
            const capability = config.capabilities.find(c=>c.id===detail.request.capability);
            const roleBinding = config.roleBindings?.find(b=>b.role===detail.request.capability);
            if(!config.repos.some(r=>r.id===detail.request.repo) || (!roleBinding && (!capability?.execution || !config.environments.find(e=>e.id===capability.environment)?.docker))) throw Error('Current configuration cannot execute this request');
          }
          const audit = {source:message.source,handling:message.handling,reason:message.reason,externalResults:message.externalResults};
          result = message.command === 'confirm-stop' ? records.confirmStop(message.id,audit,message.call,message.attempt) : records.recover(message.id,audit,message.command==='retry');
          dispatch();
          break;
        }
        case 'show':
          result = showQuery(records, message);
          break;
        default:
          throw new Error('Unknown command');
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(result));
    } catch (error) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Request failed' }));
    }
  });
  try {
    await rm(socket, { force: true });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, () => resolve());
    });
    await chmod(socket, 0o600);
  } catch (error) {
    server.close();
    records.close();
    releaseLock();
    throw error;
  }
  dispatch();
  console.log(JSON.stringify({ ready: true, socket }));
  const shutdown = () => {
    closing = true;
    server.close(async () => {
      records.close();
      await rm(socket, { force: true });
      releaseLock();
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

export function call(socket: string, message: unknown, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, path: '/', method: 'POST', signal }, res => {
      let body = '';
      res.on('error', reject);
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          if (res.statusCode !== 200) reject(new Error(result.error));
          else resolve(result);
        } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify(message));
  });
}
