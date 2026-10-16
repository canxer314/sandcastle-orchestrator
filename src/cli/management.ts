import { call } from '../control.js';
import { required, type Values } from './arguments.js';

export async function manage(command: string, id: string | undefined, values: Values) {
  const socket = required(values, 'socket');
  const message = command === 'submit'
    ? { command, submission: { repo: required(values, 'repo'), capability: required(values, 'capability'), input: JSON.parse(required(values, 'input')), source: required(values, 'source'), deduplicationKey: values['deduplication-key'], scheduledAt: values['scheduled-at'] } }
    : ['pause', 'resume', 'restore-review'].includes(command)
      ? { command, target: values.target, source: values.source, reason: values.reason, handling: values.handling, externalResults: values['external-results'], backupPoint: values['backup-point'] }
      : {
        command, id, attempt: values.attempt,
        ...(command === 'confirm-stop' && values.call !== undefined ? { call: values.call } : {}),
        ...(['cancel', 'confirm-stop', 'resolve', 'retry'].includes(command) ? { reason: required(values, 'reason'), source: values.source, handling: values.handling, externalResults: values['external-results'] } : {}),
      };
  return call(socket, message);
}
