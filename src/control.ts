import { createServer, request } from 'node:http';
import { mkdir, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireControlLock } from './lock.js';
import { checkDataSeparation } from './paths.js';
import { Records } from './records.js';
import { executeRole } from './roles.js';
import { execute, readArtifact, cancelExecution } from './execution.js';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { serviceLog } from './service-log.js';
import { loadConfiguration, type Submission } from './config.js';

export async function serve(data: string, configPath: string) {
  const config = await loadConfiguration(configPath);
  await checkDataSeparation(data, configPath, config);
  process.umask(0o077);
  await mkdir(data, { recursive: true, mode: 0o700 });
  await chmod(data, 0o700);
  const releaseLock = await acquireControlLock(join(data, 'control.lock'));
  let records: Records;
  try {
    records = new Records(join(data, 'records.sqlite'));
  } catch (error) {
    releaseLock();
    throw error;
  }
  const executionFailed = (executionId: string, error: unknown) => {
    serviceLog('execution_failure', error, executionId);
    try { records.markExecutionFailure(executionId); }
    catch (saveError) { serviceLog('execution_failure_save_failed', saveError, executionId); }
  };
  const socket = join(data, 'control.sock');
  const server = createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body);
      let result;
      switch (message?.command) {
        case 'submit':
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
          if (submitted.newExecutionId) {
            const executionId = submitted.newExecutionId;
            void (config.roles?.some(r=>r.id===message.submission.capability) ? executeRole(records,config,executionId,data) : execute(records, config, executionId, data)).catch(error => executionFailed(executionId, error));
          }
          break;
        case 'list':
          result = records.list(message.repo, message.status, message.source);
          break;
        case 'logs':
        case 'artifact': {
          const detail = records.show(message.id);
          const attempt = detail.attempts.find(a => a.id === message.attempt) ?? (message.attempt ? undefined : detail.attempts.at(-1));
          if (!attempt) throw Error('Attempt not found');
          const directory = join(data, 'attempts', String(attempt.id));
          if (message.command === 'logs') {
            const read = async (stream: string) => {
              try {
                const file=await open(join(directory, `${stream}.log`),constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
                try {
                  const stat=await file.stat();if(!stat.isFile())throw Error('Log is not a regular file');
                  const buffer=Buffer.alloc(Math.min(stat.size,65536));
                  await file.read(buffer,0,buffer.length,Math.max(0,stat.size-buffer.length));
                  return {text:buffer.toString('utf8'),truncated:stat.size>buffer.length};
                } finally {await file.close()}
              } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
            };
            const stdout = await read('stdout'); const stderr = await read('stderr');
            result = {attemptId:attempt.id,actualSha:attempt.actualSha,stdout:stdout?.text??null,stderr:stderr?.text??null,truncated:{stdout:stdout?.truncated??false,stderr:stderr?.truncated??false},complete:attempt.logs?.complete === true && stdout !== null && stderr !== null};
          } else {
            if (!attempt.artifacts?.some((a: {name:string}) => a.name === message.name)) throw Error('Artifact not registered');
            result = {attemptId:attempt.id,actualSha:attempt.actualSha,name:message.name,encoding:'base64',content:await readArtifact(join(directory,'artifacts'),message.name)};
          }
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
          if (message.attempt && message.attempt !== detail.attempts.at(-1)?.id) throw Error('Only the current attempt can be managed');
          if(message.command==='retry') {
            const capability = config.capabilities.find(c=>c.id===detail.request.capability);
            const roleBinding = config.roleBindings?.find(b=>b.role===detail.request.capability);
            if(!config.repos.some(r=>r.id===detail.request.repo) || (!roleBinding && (!capability?.execution || !config.environments.find(e=>e.id===capability.environment)?.docker))) throw Error('Current configuration cannot execute this request');
          }
          const audit = {source:message.source,handling:message.handling,reason:message.reason,externalResults:message.externalResults};
          result = message.command === 'confirm-stop' ? records.confirmStop(message.id,audit) : records.recover(message.id,audit,message.command==='retry');
          if(message.command==='retry') void (config.roles?.some(r=>r.id===detail.request.capability) ? executeRole(records,config,String(result.execution!.id),data) : execute(records,config,String(result.execution!.id),data)).catch(error=>executionFailed(String(detail.execution!.id), error));
          break;
        }
        case 'show':
          result = records.show(message.id);
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
  console.log(JSON.stringify({ ready: true, socket }));
  const shutdown = () => {
    server.close(async () => {
      records.close();
      await rm(socket, { force: true });
      releaseLock();
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

export function call(socket: string, message: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, path: '/', method: 'POST' }, res => {
      let body = '';
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
