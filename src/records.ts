import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Configuration, Submission } from './config.js';

export class Records {
  private db: DatabaseSync;
  private unresolved = new Map<string, string>();
  private priorAttempts = new Set<string>();

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, repo TEXT NOT NULL, capability TEXT NOT NULL,
        input TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL,
        rejection TEXT
      );
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES executions(id),
        config_version TEXT NOT NULL, capability TEXT NOT NULL, environment TEXT NOT NULL,
        run_state TEXT NOT NULL, facts TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE REFERENCES requests(id),
        status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS submission_metadata (
        request_id TEXT PRIMARY KEY REFERENCES requests(id), scheduled_at TEXT, deduplication_key TEXT
      );
      CREATE TABLE IF NOT EXISTS deduplication_keys (
        source TEXT NOT NULL, key TEXT NOT NULL,
        request_id TEXT NOT NULL UNIQUE REFERENCES requests(id), PRIMARY KEY (source, key)
      );
    `);
    for (const row of this.db.prepare("SELECT id FROM attempts WHERE run_state IN ('starting', 'running')").all()) this.priorAttempts.add(String(row.id));
  }

  private existing(submission: Submission, originalInput: string) {
    if (submission.deduplicationKey === undefined) return;
    const row = this.db.prepare('SELECT request_id FROM deduplication_keys WHERE source = ? AND key = ?')
      .get(submission.source, submission.deduplicationKey);
    if (!row) return;
    const detail = this.show(String(row.request_id));
    if (detail.request.repo !== submission.repo || detail.request.capability !== submission.capability
      || !isDeepStrictEqual(detail.request.input, JSON.parse(originalInput))
      || detail.request.scheduledAt !== (submission.scheduledAt ?? null)) throw new Error('Deduplication key conflict');
    return { accepted: true, requestId: detail.request.id, executionId: detail.execution!.id };
  }

  async submit(submission: Submission, config: Configuration) {
    const originalInput = JSON.stringify(submission.input);
    const existing = this.existing(submission, originalInput);
    if (existing) return { receipt: existing };
    let rejection: string | null = null;
    try {
      if (!config.repos.some(repo => repo.id === submission.repo)) throw new Error('Unknown repo');
      const capability = config.capabilities.find(cap => cap.id === submission.capability);
      if (!capability) throw new Error('Unknown capability');
      await capability.validate(submission.input);
    } catch (error) {
      rejection = error instanceof Error ? error.message : 'Invalid input';
    }
    const requestId = randomUUID();
    const executionId = randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.existing(submission, originalInput);
      if (existing) { this.db.exec('COMMIT'); return { receipt: existing }; }
      this.db.prepare('INSERT INTO requests VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        requestId, submission.repo, submission.capability, originalInput,
        submission.source, new Date().toISOString(), rejection,
      );
      if (rejection === null) this.db.prepare('INSERT INTO executions VALUES (?, ?, ?)').run(executionId, requestId, 'queued');
      this.db.prepare('INSERT INTO submission_metadata VALUES (?, ?, ?)').run(requestId, submission.scheduledAt ?? null, submission.deduplicationKey ?? null);
      if (rejection === null && submission.deduplicationKey !== undefined) {
        this.db.prepare('INSERT INTO deduplication_keys VALUES (?, ?, ?)').run(submission.source, submission.deduplicationKey, requestId);
      }
      this.db.exec('COMMIT');
      return rejection !== null
        ? { receipt: { accepted: false, requestId, reason: rejection } }
        : { receipt: { accepted: true, requestId, executionId }, newExecutionId: executionId };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  show(id: string) {
    const row = this.db.prepare(`SELECT r.*, e.id AS execution_id, e.status, m.scheduled_at, m.deduplication_key
      FROM requests r LEFT JOIN executions e ON e.request_id = r.id
      LEFT JOIN submission_metadata m ON m.request_id = r.id
      WHERE e.id = ? OR r.id = ?`).get(id, id);
    if (!row) throw new Error('Execution not found');
    const attempts = this.db.prepare('SELECT * FROM attempts WHERE execution_id = ? ORDER BY rowid').all(String(row.execution_id)).map(a => {
      const unknown = this.priorAttempts.has(String(a.id)) || this.unresolved.has(String(a.id));
      return {
        id: a.id, configVersion: a.config_version, capability: a.capability, environment: a.environment,
        ...JSON.parse(String(a.facts)), runState: unknown ? 'unknown' : a.run_state,
        ...(unknown ? { persistedRunState: a.run_state, requiresAttention: true } : {}),
        ...(this.unresolved.has(String(a.id)) ? { persistenceError: this.unresolved.get(String(a.id)) } : {}),
      };
    });
    return {
      request: { id: row.id, repo: row.repo, capability: row.capability, input: JSON.parse(String(row.input)), source: row.source, createdAt: row.created_at, scheduledAt: row.scheduled_at ?? null, deduplicationKey: row.deduplication_key ?? null, rejection: row.rejection },
      execution: row.execution_id ? { id: row.execution_id, status: attempts.some(a => a.runState === 'unknown') ? 'unknown' : row.status } : null,
      attempts,
    };
  }

  list(repo?: string, status?: string, source?: string) {
    return this.db.prepare(`SELECT e.id FROM executions e JOIN requests r ON r.id = e.request_id
      WHERE (? IS NULL OR r.repo = ?) AND (? IS NULL OR r.source = ?) ORDER BY r.rowid`)
      .all(repo ?? null, repo ?? null, source ?? null, source ?? null)
      .map(row => this.show(String(row.id)))
      .filter(detail => status === undefined || detail.execution?.status === status);
  }

  beginAttempt(executionId: string, version: string, capability: string, environment: string) {
    const id = randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO attempts VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, executionId, version, capability, environment, 'starting', JSON.stringify({ createdAt: new Date().toISOString() }));
      this.db.prepare("UPDATE executions SET status = 'starting' WHERE id = ?").run(executionId);
      this.db.exec('COMMIT');
      return id;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  updateAttempt(id: string, facts: Record<string, unknown>) {
    const row=this.db.prepare('SELECT facts, run_state FROM attempts WHERE id = ?').get(id)!;
    const state=typeof facts.runState==='string'?facts.runState:String(row.run_state);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE attempts SET facts = ?, run_state = ? WHERE id = ?').run(JSON.stringify({...JSON.parse(String(row.facts)),...facts}),state,id);
      this.db.prepare('UPDATE executions SET status = ? WHERE id = (SELECT execution_id FROM attempts WHERE id = ?)').run(state,id);
      this.db.exec('COMMIT');
    } catch(error){this.db.exec('ROLLBACK');throw error}
  }

  finishAttempt(id: string, state: string, facts: object) {
    const existing=this.db.prepare('SELECT facts FROM attempts WHERE id = ?').get(id)!;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE attempts SET run_state = ?, facts = ? WHERE id = ?').run(state, JSON.stringify({...JSON.parse(String(existing.facts)),...facts,runState:state}), id);
      this.db.prepare('UPDATE executions SET status = ? WHERE id = (SELECT execution_id FROM attempts WHERE id = ?)').run(state, id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  markUnresolved(id: string, error: unknown) {
    this.unresolved.set(id, error instanceof Error ? error.message : 'Required record save failed');
  }

  close() { this.db.close(); }
}
