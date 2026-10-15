import { call } from '../control.js';
import { required, type Values } from './arguments.js';

export async function query(command: string, id: string | undefined, values: Values) {
  if (command === 'artifact' && values.offset !== undefined && !/^\d+$/.test(values.offset)) throw Error('Invalid --offset');
  const socket = required(values, 'socket');
  const message = command === 'maintenance'
    ? { command, target: values.target, source: values.source, reason: values.reason, handling: values.handling, externalResults: values['external-results'], backupPoint: values['backup-point'] }
    : command === 'list' ? { command, repo: values.repo, status: values.status, source: values.source }
    : {
      command, id, attempt: values.attempt,
      ...(['logs', 'artifact'].includes(command) && values.call !== undefined ? { call: values.call } : {}),
      ...(command === 'artifact' ? { name: required(values, 'name'), ...(values.offset !== undefined ? { offset: Number(values.offset) } : {}) } : {}),
    };
  return call(socket, message);
}
