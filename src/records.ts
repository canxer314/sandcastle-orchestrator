import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Configuration, Submission } from './config.js';

export class Records {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, repo TEXT NOT NULL, capability TEXT NOT NULL,
        input TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL,
        rejection TEXT
      );
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE REFERENCES requests(id),
        status TEXT NOT NULL
      );
    `);
  }

  async submit(submission: Submission, config: Configuration) {
    const originalInput = JSON.stringify(submission.input);
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
      this.db.prepare('INSERT INTO requests VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        requestId, submission.repo, submission.capability, originalInput,
        submission.source, new Date().toISOString(), rejection,
      );
      if (rejection === null) this.db.prepare('INSERT INTO executions VALUES (?, ?, ?)').run(executionId, requestId, 'queued');
      this.db.exec('COMMIT');
      return rejection !== null ? { accepted: false, requestId, reason: rejection } : { accepted: true, requestId, executionId };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  show(id: string) {
    const row = this.db.prepare(`SELECT r.*, e.id AS execution_id, e.status
      FROM requests r LEFT JOIN executions e ON e.request_id = r.id WHERE e.id = ? OR r.id = ?`).get(id, id);
    if (!row) throw new Error('Execution not found');
    return {
      request: { id: row.id, repo: row.repo, capability: row.capability, input: JSON.parse(String(row.input)), source: row.source, createdAt: row.created_at, rejection: row.rejection },
      execution: row.execution_id ? { id: row.execution_id, status: row.status } : null,
      attempts: [],
    };
  }

  list(repo?: string, status?: string) {
    return this.db.prepare(`SELECT e.id FROM executions e JOIN requests r ON r.id = e.request_id
      WHERE (? IS NULL OR r.repo = ?) AND (? IS NULL OR e.status = ?) ORDER BY r.rowid`)
      .all(repo ?? null, repo ?? null, status ?? null, status ?? null)
      .map(row => this.show(String(row.id)));
  }

  close() { this.db.close(); }
}
