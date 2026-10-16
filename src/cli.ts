#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { serviceLog } from './service-log.js';
import { commands, help } from './help.js';
import { validateOptions } from './cli/arguments.js';

let serving = false;

try {
  const { values: parsed, positionals } = parseArgs({
    allowPositionals: true,
    options: {yes: {type: 'boolean'}, 'non-interactive': {type: 'boolean'}, 'reuse-local-claude': {type: 'boolean'}, 'connection-environment': {type: 'boolean'}, 'reference-only': {type: 'boolean'}, human: {type: 'boolean'}, json: {type: 'boolean'}, offline: {type: 'boolean'}, help: {type: 'boolean', short: 'h'}, version: {type: 'boolean', short: 'v'}, ...Object.fromEntries(['project', 'input-path', 'question', 'image', 'model', 'connection-settings', 'data', 'config', 'demo-repo', 'socket', 'repo', 'capability', 'input', 'input-file', 'source', 'status', 'deduplication-key', 'scheduled-at', 'attempt', 'call', 'name', 'reason', 'handling', 'external-results', 'offset', 'target', 'maintenance', 'backup-point'].map(name => [name, { type: 'string' as const }]))},
  });
  if (parsed.version) {
    console.log(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version);
  } else if (parsed.help || process.argv.length === 2) {
    console.log(help(positionals[0]));
  } else {
    const values = parsed as Record<string, string | undefined>;
    const command = positionals[0];
    if (!commands.includes(command)) throw new Error(`Unknown command; use ${commands.slice(0, -1).join(', ')} or ${commands.at(-1)}`);
    if (command === 'setup') {
      if (positionals.length !== 1) throw Error('Unexpected positional argument for setup');
      await (await import('./cli/setup.js')).setup(parsed);
    } else {
      for (const option of ['non-interactive', 'reuse-local-claude', 'connection-environment', 'reference-only', 'project', 'input-path', 'question', 'image', 'model', 'connection-settings']) {
        if (parsed[option as keyof typeof parsed] !== undefined) throw Error(`--${option} is only supported for setup`);
      }
      validateOptions(command, positionals, parsed);
      if (['show', 'logs', 'artifact', 'cancel', 'confirm-stop', 'resolve', 'retry'].includes(command) && !positionals[1] && !(command === 'show' && values.source !== undefined && values['deduplication-key'] !== undefined)) throw new Error('Missing identifier');
      if (command === 'init' || command === 'doctor') {
        const { onboarding } = await import('./cli/onboarding.js');
        await onboarding(command, parsed);
      } else if (command === 'serve') {
        serving = true;
        const { runService } = await import('./cli/serve.js');
        await runService(values);
      } else {
        const result = ['show', 'list', 'logs', 'artifact', 'maintenance'].includes(command)
          ? await (await import('./cli/queries.js')).query(command, positionals[1], values, {human: parsed.human, offline: parsed.offline})
          : await (await import('./cli/management.js')).manage(command, positionals[1], values, parsed.human);
        if (parsed.human) {
          const { querySocket } = await import('./cli/queries.js');
          const { formatQuery, formatWrite } = await import('./cli/human.js');
          const { data, socket } = await querySocket(values);
          console.log((['show', 'list', 'logs', 'artifact', 'maintenance'].includes(command) ? formatQuery : formatWrite)(command, result, { id: positionals[1], data: values.socket && values.data === undefined ? undefined : data, socket: parsed.offline ? undefined : socket, offline: parsed.offline === true, source: values.source, deduplicationKey: values['deduplication-key'] }));
        } else console.log(JSON.stringify(result));
      }
    }
  }
} catch (error) {
  if (serving) serviceLog('service_failure', error);
  else console.error(JSON.stringify({ error: error instanceof Error ? error.message : 'Command failed' }));
  process.exitCode = process.exitCode === 130 || process.exitCode === 2 ? process.exitCode : 1;
}
