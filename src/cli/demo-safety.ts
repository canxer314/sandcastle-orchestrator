import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { offlineQuery, toolNeedsReview, toolReconciled, type RecordReader } from '../record-queries.js';

export type Detail = ReturnType<RecordReader['show']>;
const terminal = ['completed', 'cancelled', 'resolved', 'start_failed'];

export function stopped(detail: Detail): boolean {
  if (!detail.execution || !terminal.includes(String(detail.execution.status))) return false;
  return detail.attempts.every(a => terminal.includes(a.runState) && !a.requiresAttention && (!a.persistenceError || a.runState === 'resolved' && a.reconciliation)
    && (!a.cancellation || a.stopConfirmation || a.runState === 'start_failed')
    && (a.toolCalls ?? []).every((c: Record<string, any>) => !toolNeedsReview(c) || toolReconciled(c)));
}

export async function assertDemoIdle(data: string, ownRun?: string) {
  let entries: string[] = [];
  try { entries = await readdir(join(data, 'demo-runs')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const name of entries.filter(name => name.endsWith('.json') && name !== `${ownRun}.json`)) {
    const path = join(data, 'demo-runs', name);
    const run = JSON.parse(await readFile(path, 'utf8'));
    if (run.settled !== true) throw Error(`Unresolved demo: ${path}. Inspect its source/key and service log; no automatic retry. Preserve this journal until manual reconciliation.`);
  }
  try { await lstat(join(data, 'records.sqlite')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const details = await offlineQuery(data, {command:'list'}) as Detail[];
  if (details.some(detail => !stopped(detail))) throw Error(`Unfinished, queued or unresolved executions in ${data}. Use list/show/logs --offline --data to inspect; do not start a service just to inspect records.`);
}
