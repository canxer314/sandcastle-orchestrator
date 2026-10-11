import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

try {
  const { values } = parseArgs({ options: { socket: { type: 'string' }, repo: { type: 'string' } } });
  if (!values.socket) throw Error('Missing socket');
  // Only this external query is time bounded, never an execution.
  const { stdout } = await promisify(execFile)(process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'list', '--socket', values.socket,
      ...(values.repo ? ['--repo', values.repo] : [])], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  const details = JSON.parse(stdout);
  if (!Array.isArray(details)) throw Error('Invalid list response');
  const items = details.flatMap(detail => {
    const execution = detail.execution;
    const attempt = detail.attempts?.at(-1);
    if (!execution || typeof execution.id !== 'string' || typeof execution.status !== 'string'
      || !Array.isArray(detail.attempts) || typeof detail.request?.id !== 'string') throw Error('Invalid detail');
    const reasons: string[] = [];
    if (['start_failed', 'failed'].includes(execution.status) || attempt?.contract === 'error') reasons.push('failed');
    if (['unknown', 'needs_attention'].includes(execution.status) || attempt?.requiresAttention || attempt?.persistenceError) reasons.push('needs_attention');
    if ((execution.cancellation || attempt?.cancellation) && attempt && attempt.runState !== 'start_failed' && !attempt.stopConfirmation) reasons.push('stop_unconfirmed');
    if (!reasons.length) return [];
    // Allowlist: never forward input, business results, errors, env, logs or audit free text.
    return [{ requestId: detail.request.id, executionId: execution.id, status: execution.status,
      attemptId: attempt?.id ?? null, reasons }];
  });
  console.log(JSON.stringify({ version: 1, available: true, items }));
} catch {
  console.error(JSON.stringify({ version: 1, available: false, error: 'Control query failed' }));
  process.exitCode = 1;
}
