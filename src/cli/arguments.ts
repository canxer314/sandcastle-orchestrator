import { validateScheduledAt } from '../submission.js';

export type Values = Record<string, string | undefined>;

export function validateOptions(command: string, positionals: string[], values: Record<string, unknown>) {
  const onboarding = ['init', 'doctor', 'demo'].includes(command);
  if (!onboarding && (values.yes !== undefined || values['demo-repo'] !== undefined || values['reset-demo'] !== undefined)) throw Error(`--yes and --demo-repo only support init/doctor/demo`);
  if (onboarding) {
    if (positionals.length !== 1) throw Error(`Unexpected positional argument for ${command}`);
    if (values.human && values.json) throw Error('--human and --json are mutually exclusive');
    const allowed = ['config', 'data', 'demo-repo', 'human', 'json', 'help', ...(command === 'init' ? ['yes', 'reset-demo'] : [])];
    for (const name of Object.keys(values)) if (!allowed.includes(name)) throw Error(`--${name} is not supported for ${command}`);
    return;
  }
  const keyed = command === 'show' && (values.source !== undefined || values['deduplication-key'] !== undefined);
  if (!values.human && !values.json && !values.offline && values['input-file'] === undefined && !keyed) return;
  if (values['input-file'] !== undefined && command !== 'submit') throw Error(`--input-file is not supported for ${command}`);
  if (values['input-file'] !== undefined && values.input !== undefined) throw Error('--input and --input-file are mutually exclusive');
  if (values.human && values.json) throw Error('--human and --json are mutually exclusive');
  if (values.human && command === 'serve') throw Error('--human is not supported for serve');
  if (values.offline && !['show', 'list', 'logs'].includes(command)) throw Error('--offline only supports show, list and logs');
  if (values.offline && values.socket !== undefined) throw Error('--offline conflicts with --socket');
  if (keyed) {
    required(values as Values, 'source'); required(values as Values, 'deduplication-key');
    if (positionals[1]) throw Error('show identifier conflicts with --source and --deduplication-key');
  }
  const max = ['show', 'logs', 'artifact', 'cancel', 'confirm-stop', 'resolve', 'retry'].includes(command) && !keyed ? 2 : 1;
  if (positionals.length > max) throw Error(`Unexpected positional argument for ${command}`);
  const allowed = ['human', 'json', 'offline', 'data', 'config', 'socket', 'help', 'version',
    ...(command === 'serve' ? ['maintenance'] : []),
    ...(command === 'submit' ? ['repo', 'capability', 'input', 'input-file', 'source', 'deduplication-key', 'scheduled-at'] : []),
    ...(['cancel', 'confirm-stop', 'resolve', 'retry'].includes(command) ? ['reason', 'source', 'handling', 'external-results', 'attempt', ...(command === 'confirm-stop' ? ['call'] : [])] : []),
    ...(['pause', 'resume', 'restore-review'].includes(command) ? ['source', 'reason', 'handling', 'external-results', 'backup-point', 'target'] : []),
    ...(command === 'show' ? ['source', 'deduplication-key'] : []),
    ...(command === 'list' ? ['repo', 'status', 'source'] : []),
    ...(['logs', 'artifact'].includes(command) ? ['attempt', 'call'] : []),
    ...(command === 'artifact' ? ['name', 'offset'] : [])];
  for (const name of Object.keys(values)) {
    if (!allowed.includes(name)) throw Error(`--${name} is not supported for ${command}`);
  }
  if (['serve', 'show', 'list', 'logs', 'artifact', 'maintenance'].includes(command)) return;
  const fields = command === 'submit' ? ['repo', 'capability', 'source']
    : command === 'cancel' ? ['reason']
    : ['confirm-stop', 'resolve', 'retry'].includes(command) ? ['source', 'reason', 'handling', ...(['resolve', 'retry'].includes(command) || values.call !== undefined ? ['external-results'] : [])]
    : ['pause', 'resume', 'restore-review'].includes(command) ? ['source', 'reason', ...(command === 'restore-review' ? ['backup-point', 'handling', 'external-results'] : [])] : [];
  for (const name of fields) if (!required(values as Values, name).trim()) throw Error(`Missing --${name}`);
  for (const name of ['deduplication-key', 'attempt', 'call', 'handling', 'external-results', 'backup-point']) {
    if (values[name] !== undefined && !required(values as Values, name).trim()) throw Error(`Invalid --${name}`);
  }
  if (command === 'submit' && values['scheduled-at'] !== undefined) validateScheduledAt(String(values['scheduled-at']));
  if (values.target !== undefined && !['all', 'admission', 'starts'].includes(String(values.target))) throw Error('Invalid --target');
  if (command === 'confirm-stop' && values.call !== undefined && !/^[1-9][0-9]*$/.test(String(values.call))) throw Error('Invalid --call');
}

export function required(values: Values, name: string) {
  const value = values[name];
  if (typeof value !== 'string' || !value) throw new Error(`Missing --${name}`);
  return value;
}
