// Service logs deliberately omit arbitrary exception messages, stacks and configuration.
export function serviceLog(event: string, error: unknown, executionId?: string) {
  const message = error instanceof Error ? error.message : '';
  const known = ['Control service already running', 'Unable to acquire control lock',
    'Duplicate repo id', 'Unknown environment', 'Execution capability requires Docker environment'];
  const safe = known.find(value => message.startsWith(value))
    ?? (message.includes('separate') ? 'Runtime data must be separate from configuration and checkouts' : 'Control service failed');
  console.error(JSON.stringify({ time: new Date().toISOString(), event, error: safe,
    ...(executionId && /^[a-f0-9-]{36}$/.test(executionId) ? { executionId } : {}) }));
}
