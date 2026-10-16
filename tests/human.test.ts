import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

async function human(command: string[], result: unknown) {
  const data = await mkdtemp(join(tmpdir(), 'human-query-'));
  const socket = join(data, 'control.sock');
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result)); });
  });
  server.listen(socket); await once(server, 'listening');
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...command, '--human', '--data', data, '--socket', socket], {cwd:resolve(import.meta.dirname, '..')});
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const [code] = await once(child, 'exit');
    expect(code, stderr).toBe(0);
    return {stdout, data, socket};
  } finally { await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); await rm(data, {recursive:true, force:true}); }
}

test('human list keeps pending review and attention distinct from success', async () => {
  const {stdout} = await human(['list'], [{...detail, execution:{id:'execution-1', status:'pending-review'}, attempts:[{id:'attempt-1',runState:'unknown',requiresAttention:true}]}]);
  expect(stdout).toContain('ID\tREPO\tSTATUS\tWARNINGS');
  expect(stdout).toContain('execution-1\talpha\tpending-review\tpending-review; attempt requires attention');
});

test('human logs preserves original streams alongside incomplete cleanup and call metadata', async () => {
  const stdout = 'first line\n"quoted"\tlast line without newline';
  const result = await human(['logs','execution-1','--call','2'], {attemptId:'attempt-1',callId:'2',availability:'unavailable',stdout,stderr:null,truncated:{stdout:true,stderr:false},complete:false,cleanup:{status:'partial'}});
  expect(result.stdout).toContain(`stdout:\n${stdout}`);
  expect(result.stdout).toContain('stderr: missing');
  expect(result.stdout).toContain('Attempt: attempt-1');
  expect(result.stdout).toContain('Call: 2');
  expect(result.stdout).toContain('Complete: false');
  expect(result.stdout).toContain('"stdout": true');
  expect(result.stdout).toContain('"status": "partial"');
});

test('human artifact retains base64 content and pagination rather than silently decoding or truncating', async () => {
  const {stdout} = await human(['artifact','execution-1','--name','business.json'], {attemptId:'attempt-1',callId:'3',name:'business.json',availability:'available',encoding:'base64',content:'AAEC/w==',offset:0,nextOffset:4,size:8,complete:false});
  expect(stdout).toContain('Content (base64):\nAAEC/w==');
  expect(stdout).toContain('"nextOffset": 4');
  expect(stdout).toContain('"complete": false');
  expect(stdout).toContain('Call: 3');
});

test('human maintenance describes observed state without suggesting a state change', async () => {
  const {stdout} = await human(['maintenance'], {admissionPaused:true,startsPaused:false,restorePending:true,restoreReview:{externalResults:'not checked'},history:[{command:'pause',reason:'backup'}]});
  expect(stdout).toContain('Maintenance (read-only snapshot)');
  expect(stdout).toContain('Admission: paused');
  expect(stdout).toContain('Execution starts: not paused');
  expect(stdout).toContain('"externalResults": "not checked"');
  expect(stdout).toContain('"reason": "backup"');
});

const detail = {
  request: {id:'request-1', repo:'alpha', capability:'test-commit', source:'manual', rejection:null},
  execution: {id:'execution-1', status:'completed'},
  attempts: [{id:'attempt-1', runState:'completed', actualSha:'abc123', contract:'valid', business:{passed:false}, logs:{complete:false}}],
};

test('human source-key absence warns that a lost receipt is not permission to resend', async () => {
  const {stdout, data, socket} = await human(['show', '--source', 'manual', '--deduplication-key', 'delivery-1'], []);
  expect(stdout).toContain('No matching requests');
  expect(stdout).toMatch(/not.*safe.*resend/i);
  expect(stdout).toContain('--source'); expect(stdout).toContain('delivery-1');
  expect(stdout).toContain(data); expect(stdout).toContain(socket);
});

test('human show separates acceptance execution actual attempt business and missing evidence', async () => {
  const {stdout, data, socket} = await human(['show', 'execution-1'], detail);
  expect(stdout).toContain('Acceptance: accepted');
  expect(stdout).toContain('Execution: execution-1 (completed)');
  expect(stdout).toContain('Attempt: attempt-1 (completed)');
  expect(stdout).toContain('Actual SHA: abc123');
  expect(stdout).toContain('"passed": false');
  expect(stdout).toContain('Business success: not inferred');
  expect(stdout).toContain('logs incomplete');
  expect(stdout).toContain(`--data '${data}' --socket '${socket}'`);
});
