import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';

try {
  const { values } = parseArgs({ options: {
    socket: { type: 'string' }, file: { type: 'string' }, task: { type: 'string' }, 'scheduled-at': { type: 'string' },
  } });
  const required = (key: keyof typeof values) => {
    const value = values[key];
    if (!value) throw new Error(`Missing --${key}`);
    return value;
  };
  const socket = required('socket');
  const file = required('file');
  const task = required('task');
  const scheduledAt = required('scheduled-at');
  if (!Number.isFinite(Date.parse(scheduledAt))) throw new Error('--scheduled-at must be a valid date/time');
  const submission = JSON.parse(await readFile(resolve(file), 'utf8'));
  if (!submission || typeof submission !== 'object' || Array.isArray(submission)
      || typeof submission.repo !== 'string' || !submission.repo
      || typeof submission.capability !== 'string' || !submission.capability
      || !Object.hasOwn(submission, 'input')
      || typeof submission.source !== 'string' || !submission.source) {
    throw new Error('Submission file must contain repo, capability, input, and source');
  }

  const args = [
    '--import', 'tsx', resolve(import.meta.dirname, '../src/cli.ts'), 'submit',
    '--socket', socket,
    '--repo', submission.repo,
    '--capability', submission.capability,
    '--input', JSON.stringify(submission.input),
    '--source', submission.source,
    '--deduplication-key', JSON.stringify([task, scheduledAt]),
    '--scheduled-at', scheduledAt,
  ];
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolveResult({ code, stdout, stderr }));
  });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `CLI exited ${result.code}`);
  const receipt = JSON.parse(result.stdout);
  if (receipt.accepted !== true) throw new Error(receipt.reason || 'Submission rejected');
  process.stdout.write(JSON.stringify(receipt) + '\n');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Submission failed');
  process.exitCode = 1;
}
