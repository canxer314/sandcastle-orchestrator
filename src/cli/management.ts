import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { call, ControlCallError } from '../control.js';
import { querySocket } from './queries.js';
import { writeRecheck } from './human.js';
import { required, type Values } from './arguments.js';

export async function manage(command: string, id: string | undefined, values: Values, human = false) {
  if (!human && !values.json && values['input-file'] === undefined) required(values, 'socket');
  const { socket, data } = await querySocket(values);
  let input;
  if (command === 'submit') {
    required(values, 'repo'); required(values, 'capability');
    let text = values['input-file'] === undefined ? required(values, 'input') : '';
    if (values['input-file'] === '-') {
      process.stdin.setEncoding('utf8');
      for await (const chunk of process.stdin) text += chunk;
    } else if (values['input-file'] !== undefined) text = await readFile(required(values, 'input-file'), 'utf8');
    input = JSON.parse(text);
  }
  if (human && command === 'submit' && values['deduplication-key'] === undefined) values['deduplication-key'] = randomUUID();
  const message = command === 'submit'
    ? { command, submission: { repo: required(values, 'repo'), capability: required(values, 'capability'), input, source: required(values, 'source'), deduplicationKey: values['deduplication-key'], scheduledAt: values['scheduled-at'] } }
    : ['pause', 'resume', 'restore-review'].includes(command)
      ? { command, target: values.target, source: values.source, reason: values.reason, handling: values.handling, externalResults: values['external-results'], backupPoint: values['backup-point'] }
      : {
        command, id, attempt: values.attempt,
        ...(command === 'confirm-stop' && values.call !== undefined ? { call: values.call } : {}),
        ...(['cancel', 'confirm-stop', 'resolve', 'retry'].includes(command) ? { reason: required(values, 'reason'), source: values.source, handling: values.handling, externalResults: values['external-results'] } : {}),
      };
  if (human && command === 'submit') {
    const next = writeRecheck(command, {socket, data: values.socket && values.data === undefined ? undefined : data, offline:false, source:values.source, deduplicationKey:values['deduplication-key']});
    await new Promise<void>((resolve, reject) => process.stderr.write(`Submission source: ${JSON.stringify(values.source)}; deduplication key: ${JSON.stringify(values['deduplication-key'])}.\nRecheck: ${next}\n`, error => error ? reject(error) : resolve()));
  }
  const controller = new AbortController();
  let interrupted = false;
  const interrupt = () => { interrupted = true; controller.abort(); };
  if (human) process.once('SIGINT', interrupt);
  const timer = human ? setTimeout(() => controller.abort(), 30_000) : undefined;
  try {
    const result = await call(socket, message, human ? controller.signal : undefined);
    if (human && command === 'submit') {
      const receipt = result as {accepted?: boolean; requestId?: string; executionId?: string; reason?: string} | null;
      if (!receipt || typeof receipt.accepted !== 'boolean' || typeof receipt.requestId !== 'string' || !receipt.requestId
        || (receipt.accepted ? typeof receipt.executionId !== 'string' || !receipt.executionId : typeof receipt.reason !== 'string')) throw new ControlCallError('Invalid submission receipt', true);
      if (!receipt.accepted) process.exitCode = 1;
    }
    if (human && command !== 'submit') {
      const receipt = result as {request?: {id?: unknown}; execution?: {id?: unknown}; attempts?: unknown; admissionPaused?: unknown; startsPaused?: unknown} | null;
      const valid = command === 'cleanup' ? Array.isArray(receipt?.attempts)
        : id ? typeof receipt?.request?.id === 'string' && typeof receipt?.execution?.id === 'string' && Array.isArray(receipt?.attempts)
        : typeof receipt?.admissionPaused === 'boolean' && typeof receipt?.startsPaused === 'boolean';
      if (!valid) throw new ControlCallError('Invalid management receipt', true);
    }
    return result;
  } catch (error) {
    if (!human) throw error;
    const uncertain = error instanceof ControlCallError && error.sent && !error.rejected;
    if (uncertain) process.exitCode = 2;
    else if (interrupted) process.exitCode = 130;
    const context = {socket, data:values.socket && values.data === undefined ? undefined : data, offline:false};
    const next = writeRecheck(command, {...context, id, ...(command === 'submit' ? {source:values.source, deduplicationKey:values['deduplication-key']} : {})});
    const startup = error instanceof ControlCallError && !error.sent ? ' Start serve explicitly with the intended --data and trusted --config after checking the instance; this client will not start a service.' : '';
    throw Error(`${uncertain ? 'Write result unconfirmed; do not resend' : 'Write failed'}. ${interrupted ? 'Client waiting interrupted; this does not cancel or undo the operation' : controller.signal.aborted ? 'Client waiting timed out after 30 seconds; this does not cancel or undo the operation' : error instanceof Error ? error.message : 'Request failed'}. Instance socket: ${socket}. Recheck: ${next}.${startup}`);
  } finally { clearTimeout(timer); if (human) process.removeListener('SIGINT', interrupt); }
}
