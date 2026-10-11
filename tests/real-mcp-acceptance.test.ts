import { spawn } from 'node:child_process';
import { mkdtemp, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { test, expect } from 'vitest';

const root = resolve(import.meta.dirname, '..');
async function exists(file: string) { return access(file).then(() => true, () => false); }
async function listening(port: number) {
  return new Promise<boolean>(resolve => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

async function runAcceptance(processes: string, retained: boolean) {
  const state = await mkdtemp(join(tmpdir(), 'issue-23-regression-'));
  const child = spawn(process.execPath, ['--require', join(root, 'tests/fixtures/acceptance-substitutes.cjs'), join(root, 'tests/real-mcp-acceptance.mjs')], {
    cwd: root, env: { ...process.env, ORCH_REAL_MCP: '1', ACCEPTANCE_STATE: state, ACCEPTANCE_PROCESSES: processes }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => output += chunk);
  child.stderr.on('data', chunk => output += chunk);
  let controlPid: number | undefined;
  try {
    for (let i = 0; i < 200; i++) {
      if (output.includes('operator inspection') || child.exitCode !== null) break;
      await delay(20);
    }
    controlPid = Number(await readFile(join(state, 'pid'), 'utf8'));
    const port = Number(await readFile(join(state, 'relay'), 'utf8'));
    if (processes === 'submit-response-failed') expect(await exists(join(state, 'accepted'))).toBe(true);
    if (retained) {
      expect(await exists(join(state, 'control-stopped')), output).toBe(false);
      expect(await listening(port), output).toBe(true);
      expect(await exists(join(state, 'stopped')), output).toBe(false);
      expect(() => process.kill(controlPid!, 0)).not.toThrow();
      expect(output).toContain('operator inspection');
    } else {
      expect(child.exitCode, output).toBe(0);
      expect(await exists(join(state, 'control-stopped')), output).toBe(true);
      expect(await listening(port), output).toBe(false);
      expect(await exists(join(state, 'stopped')), output).toBe(true);
    }
  } finally {
    // Only these controlled fixture processes; never terminate a real execution.
    if (controlPid) { try { process.kill(controlPid, 'SIGTERM'); } catch {} }
    if (child.exitCode === null) child.kill('SIGTERM');
    await rm(state, { recursive: true, force: true });
  }
}

test('acceptance command retains container, control and relay when MCP survives the exit marker', async () => {
  await runAcceptance('active', true);
});

test('acceptance command cleans up only after actual CLI and MCP absence', async () => {
  await runAcceptance('absent', false);
});

test('acceptance command retains resources when actual process absence cannot be verified', async () => {
  await runAcceptance('query-failed', true);
});

test('acceptance command retains resources when accepted submission loses its CLI response', async () => {
  await runAcceptance('submit-response-failed', true);
});
