#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { serviceLog } from './service-log.js';
import { commands, help } from './help.js';

let serving = false;

try {
  const { values: parsed, positionals } = parseArgs({
    allowPositionals: true,
    options: {help: {type: 'boolean', short: 'h'}, version: {type: 'boolean', short: 'v'}, ...Object.fromEntries(['data', 'config', 'socket', 'repo', 'capability', 'input', 'source', 'status', 'deduplication-key', 'scheduled-at', 'attempt', 'call', 'name', 'reason', 'handling', 'external-results', 'offset', 'target', 'maintenance', 'backup-point'].map(name => [name, { type: 'string' as const }]))},
  });
  if (parsed.version) {
    console.log(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version);
  } else if (parsed.help || process.argv.length === 2) {
    console.log(help(positionals[0]));
  } else {
    const values = parsed as Record<string, string | undefined>;
    const command = positionals[0];
    if (!commands.includes(command)) throw new Error(`Unknown command; use ${commands.slice(0, -1).join(', ')} or ${commands.at(-1)}`);
    if (['show', 'logs', 'artifact', 'cancel', 'confirm-stop', 'resolve', 'retry'].includes(command) && !positionals[1]) throw new Error('Missing identifier');
    if (command === 'serve') {
      serving = true;
      const { runService } = await import('./cli/serve.js');
      await runService(values);
    } else {
      const result = ['show', 'list', 'logs', 'artifact', 'maintenance'].includes(command)
        ? await (await import('./cli/queries.js')).query(command, positionals[1], values)
        : await (await import('./cli/management.js')).manage(command, positionals[1], values);
      console.log(JSON.stringify(result));
    }
  }
} catch (error) {
  if (serving) serviceLog('service_failure', error);
  else console.error(JSON.stringify({ error: error instanceof Error ? error.message : 'Command failed' }));
  process.exitCode = 1;
}
