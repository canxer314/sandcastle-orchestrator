import { parseArgs } from 'node:util';
import { query } from './cli/queries.js';
import { manage } from './cli/management.js';
import { runService } from './cli/serve.js';
import { serviceLog } from './service-log.js';

let serving = false;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: Object.fromEntries(['data', 'config', 'socket', 'repo', 'capability', 'input', 'source', 'status', 'deduplication-key', 'scheduled-at', 'attempt', 'call', 'name', 'reason', 'handling', 'external-results', 'offset', 'target', 'maintenance', 'backup-point'].map(name => [name, { type: 'string' as const }])),
  });
  const command = positionals[0];
  if (!['serve', 'submit', 'show', 'list', 'logs', 'artifact', 'cancel', 'confirm-stop', 'resolve', 'retry', 'cleanup', 'pause', 'resume', 'maintenance', 'restore-review'].includes(command)) throw new Error('Unknown command; use serve, submit, show, list, logs, artifact, cancel, confirm-stop, resolve, retry, cleanup, pause, resume, maintenance or restore-review');
  if (['show', 'logs', 'artifact', 'cancel', 'confirm-stop', 'resolve', 'retry'].includes(command) && !positionals[1]) throw new Error('Missing identifier');
  if (command === 'serve') {
    serving = true;
    await runService(values);
  } else {
    const result = ['show', 'list', 'logs', 'artifact', 'maintenance'].includes(command)
      ? await query(command, positionals[1], values)
      : await manage(command, positionals[1], values);
    console.log(JSON.stringify(result));
  }
} catch (error) {
  if (serving) serviceLog('service_failure', error);
  else console.error(JSON.stringify({ error: error instanceof Error ? error.message : 'Command failed' }));
  process.exitCode = 1;
}
