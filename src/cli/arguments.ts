export type Values = Record<string, string | undefined>;

export function validateQueryOptions(command: string, positionals: string[], values: Record<string, unknown>) {
  const queries = ['show', 'list', 'logs', 'artifact', 'maintenance'];
  const keyed = command === 'show' && (values.source !== undefined || values['deduplication-key'] !== undefined);
  if (!values.human && !values.json && !values.offline && !keyed) return;
  if (values.human && values.json) throw Error('--human and --json are mutually exclusive');
  if (values.human && !queries.includes(command)) throw Error(`--human is not supported for ${command}`);
  if (values.offline && !['show', 'list', 'logs'].includes(command)) throw Error('--offline only supports show, list and logs');
  if (values.offline && values.socket !== undefined) throw Error('--offline conflicts with --socket');
  if (keyed) {
    required(values as Values, 'source'); required(values as Values, 'deduplication-key');
    if (positionals[1]) throw Error('show identifier conflicts with --source and --deduplication-key');
  }
  const max = ['show', 'logs', 'artifact', 'cancel', 'confirm-stop', 'resolve', 'retry'].includes(command) && !keyed ? 2 : 1;
  if (positionals.length > max) throw Error(`Unexpected positional argument for ${command}`);
  if (!queries.includes(command)) return;
  const allowed = ['human', 'json', 'offline', 'data', 'config', 'socket', 'help', 'version',
    ...(command === 'show' ? ['source', 'deduplication-key'] : []),
    ...(command === 'list' ? ['repo', 'status', 'source'] : []),
    ...(['logs', 'artifact'].includes(command) ? ['attempt', 'call'] : []),
    ...(command === 'artifact' ? ['name', 'offset'] : [])];
  for (const name of Object.keys(values)) {
    if (!allowed.includes(name)) throw Error(`--${name} is not supported for ${command}`);
  }
}

export function required(values: Values, name: string) {
  const value = values[name];
  if (typeof value !== 'string' || !value) throw new Error(`Missing --${name}`);
  return value;
}
