import { call } from '../control.js';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { physicalPath } from '../paths.js';
import { required, type Values } from './arguments.js';

export async function querySocket(values: Values) {
  const data = resolve(values.data ?? join(homedir(), '.sandcastle-orchestrator', 'data'));
  const socket = resolve(values.socket ?? join(data, 'control.sock'));
  if (values.data !== undefined && values.socket !== undefined && await physicalPath(socket) !== await physicalPath(join(data, 'control.sock'))) {
    throw Error(`Conflicting --data ${data} and --socket ${socket}`);
  }
  return { data, socket };
}

export async function query(command: string, id: string | undefined, values: Values, mode: {human?: boolean; offline?: boolean} = {}) {
  if (command === 'artifact' && values.offset !== undefined && !/^\d+$/.test(values.offset)) throw Error('Invalid --offset');
  const { data, socket } = await querySocket(values);
  const message = command === 'maintenance'
    ? { command, target: values.target, source: values.source, reason: values.reason, handling: values.handling, externalResults: values['external-results'], backupPoint: values['backup-point'] }
    : command === 'list' ? { command, repo: values.repo, status: values.status, source: values.source }
    : command === 'show' && values.source !== undefined ? { command, source: values.source, deduplicationKey: values['deduplication-key'] }
    : {
      command, id, attempt: values.attempt,
      ...(['logs', 'artifact'].includes(command) && values.call !== undefined ? { call: values.call } : {}),
      ...(command === 'artifact' ? { name: required(values, 'name'), ...(values.offset !== undefined ? { offset: Number(values.offset) } : {}) } : {}),
    };
  if (mode.offline) {
    try { return await (await import('../record-queries.js')).offlineQuery(data, message); }
    catch (error) { throw Error(`Offline records at ${join(data, 'records.sqlite')}: ${error instanceof Error ? error.message : 'Read failed'}. Current activity is unverified; preserve evidence and check manually. Do not start a service just to inspect records.`); }
  }
  if (!mode.human) return call(socket, message);
  const controller = new AbortController();
  let interrupted = false;
  const interrupt = () => { interrupted = true; controller.abort(); };
  process.once('SIGINT', interrupt);
  const timer = setTimeout(() => controller.abort(), 30_000);
  try { return await call(socket, message, controller.signal); }
  catch (error) {
    const { queryCommand } = await import('./human.js');
    const selectors = command === 'list' ? {repo: values.repo, status: values.status, source: values.source}
      : ['logs', 'artifact'].includes(command) ? {attempt: values.attempt, call: values.call, ...(command === 'artifact' ? {name: values.name, offset: values.offset} : {})} : {};
    const next = queryCommand(command, { id, data: values.socket && values.data === undefined ? undefined : data, socket, offline: false, source: command === 'show' ? values.source : undefined, deduplicationKey: values['deduplication-key'] }, selectors);
    if (interrupted) process.exitCode = 130;
    throw Error(`${interrupted ? 'Query interrupted; execution was not cancelled' : controller.signal.aborted ? 'Query timed out after 30 seconds; execution was not cancelled' : error instanceof Error ? error.message : 'Query failed'}. Instance socket: ${socket}. Recheck: ${next}`);
  } finally { clearTimeout(timer); process.removeListener('SIGINT', interrupt); }
}
