import { parseArgs } from 'node:util';
import { call, serve } from './control.js';

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: Object.fromEntries(['data', 'config', 'socket', 'repo', 'capability', 'input', 'source', 'status', 'deduplication-key', 'scheduled-at'].map(name => [name, { type: 'string' as const }])),
  });
  const command = positionals[0];
  if (!['serve', 'submit', 'show', 'list'].includes(command)) throw new Error('Unknown command; use serve, submit, show or list');
  if (command === 'show' && !positionals[1]) throw new Error('Missing identifier');
  const required = (name: string) => {
    const value = values[name];
    if (typeof value !== 'string' || !value) throw new Error(`Missing --${name}`);
    return value;
  };
  if (command === 'serve') {
    await serve(required('data'), required('config'));
  } else {
    const socket = required('socket');
    const message = command === 'submit'
      ? { command, submission: { repo: required('repo'), capability: required('capability'), input: JSON.parse(required('input')), source: required('source'), deduplicationKey: values['deduplication-key'], scheduledAt: values['scheduled-at'] } }
      : command === 'list' ? { command, repo: values.repo, status: values.status, source: values.source }
      : { command, id: positionals[1] };
    console.log(JSON.stringify(await call(socket, message)));
  }
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : 'Command failed' }));
  process.exitCode = 1;
}
