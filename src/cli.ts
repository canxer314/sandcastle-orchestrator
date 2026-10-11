import { parseArgs } from 'node:util';
import { call, serve } from './control.js';
import { serviceLog } from './service-log.js';

let serving = false;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: Object.fromEntries(['data', 'config', 'socket', 'repo', 'capability', 'input', 'source', 'status', 'deduplication-key', 'scheduled-at', 'attempt', 'name', 'reason', 'handling', 'external-results'].map(name => [name, { type: 'string' as const }])),
  });
  const command = positionals[0];
  if (!['serve', 'submit', 'show', 'list', 'logs', 'artifact', 'cancel', 'confirm-stop', 'resolve', 'retry', 'cleanup'].includes(command)) throw new Error('Unknown command; use serve, submit, show, list, logs, artifact, cancel, confirm-stop, resolve, retry or cleanup');
  if (['show', 'logs', 'artifact', 'cancel', 'confirm-stop', 'resolve', 'retry'].includes(command) && !positionals[1]) throw new Error('Missing identifier');
  const required = (name: string) => {
    const value = values[name];
    if (typeof value !== 'string' || !value) throw new Error(`Missing --${name}`);
    return value;
  };
  if (command === 'serve') {
    serving = true;
    process.on('uncaughtException', error => {
      serviceLog('service_crash', error);
      process.exit(1); // Do not continue after an uncaught fault or claim children stopped.
    });
    await serve(required('data'), required('config'));
  } else {
    const socket = required('socket');
    const message = command === 'submit'
      ? { command, submission: { repo: required('repo'), capability: required('capability'), input: JSON.parse(required('input')), source: required('source'), deduplicationKey: values['deduplication-key'], scheduledAt: values['scheduled-at'] } }
      : command === 'list' ? { command, repo: values.repo, status: values.status, source: values.source }
      : { command, id: positionals[1], attempt: values.attempt, ...(['cancel','confirm-stop','resolve','retry'].includes(command) ? {reason:required('reason'), source:values.source, handling:values.handling, externalResults:values['external-results']} : {}), ...(command === 'artifact' ? { name: required('name') } : {}) };
    console.log(JSON.stringify(await call(socket, message)));
  }
} catch (error) {
  if (serving) serviceLog('service_failure', error);
  else console.error(JSON.stringify({ error: error instanceof Error ? error.message : 'Command failed' }));
  process.exitCode = 1;
}
