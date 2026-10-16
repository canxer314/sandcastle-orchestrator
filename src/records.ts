import { lstatSync, unlinkSync, readdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { RecordReader } from './record-queries.js';
import type { Configuration, Submission } from './config.js';

export class Records {
  private db: DatabaseSync;
  private reader: RecordReader;
  private unresolved = new Map<string, string>();
  private priorAttempts = new Set<string>();
  private liveAttempts = new Set<string>();

  isLive(id: string) { return this.liveAttempts.has(id); }
  endLive(id: string) { this.liveAttempts.delete(id); }

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.reader = new RecordReader(this.db, {unknown:id => this.priorAttempts.has(id) || this.unresolved.has(id), error:id => this.unresolved.get(id)});
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS maintenance (id INTEGER PRIMARY KEY CHECK (id = 1), facts TEXT NOT NULL);
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
      CREATE TABLE IF NOT EXISTS execution_start_authorizations (
        execution_id TEXT PRIMARY KEY REFERENCES executions(id)
      );
      CREATE TABLE IF NOT EXISTS execution_management (
        execution_id TEXT PRIMARY KEY REFERENCES executions(id), facts TEXT NOT NULL
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

  canStart(id: string) {
    return !!this.db.prepare('SELECT execution_id FROM execution_start_authorizations WHERE execution_id = ?').get(id);
  }

  maintenance(): { admissionPaused: boolean; startsPaused: boolean; restorePending?: boolean; restoreReview?: Record<string, string>; history: Record<string, string>[] } {
    const row = this.db.prepare('SELECT facts FROM maintenance WHERE id = 1').get();
    return row ? JSON.parse(String(row.facts)) : { admissionPaused: false, startsPaused: false, history: [] };
  }

  manageMaintenance(command: string, target: string, audit: Record<string, unknown>) {
    if (!['pause', 'resume', 'restore-review'].includes(command)) throw Error('Invalid maintenance command');
    for (const field of ['source', 'reason']) if (typeof audit[field] !== 'string' || !audit[field].trim()) throw Error(`Missing ${field}`);
    if (!['all', 'admission', 'starts'].includes(target)) throw Error('Invalid maintenance target');
    const state = this.maintenance();
    const entry = { command, target, at: new Date().toISOString() } as Record<string, string>;
    for (const field of ['source', 'reason', 'handling', 'externalResults', 'backupPoint']) {
      if (audit[field] !== undefined) {
        if (typeof audit[field] !== 'string' || !audit[field].trim()) throw Error(`Invalid ${field}`);
        entry[field] = audit[field];
      }
    }
    if (command === 'restore-review') {
      for (const field of ['backupPoint', 'handling', 'externalResults']) if (!entry[field]) throw Error(`Missing ${field}`);
      if (!state.startsPaused || !state.admissionPaused) throw Error('Pause admission and starts before restore review');
      state.restoreReview = entry;
    } else {
      if (command === 'resume' && state.restorePending && !state.restoreReview) throw Error('Restore review required before resume');
      const paused = command === 'pause';
      if (target !== 'starts') state.admissionPaused = paused;
      if (target !== 'admission') state.startsPaused = paused;
    }
    state.history.push(entry);
    this.saveMaintenance(state);
    return state;
  }

  private saveMaintenance(state: ReturnType<Records['maintenance']>) {
    this.db.prepare('INSERT INTO maintenance VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET facts = excluded.facts').run(JSON.stringify(state));
  }

  startMaintenance(mode: string) {
    if (!['normal', 'paused', 'restore'].includes(mode)) throw Error('Invalid startup maintenance mode');
    if (mode === 'normal') return;
    const state = this.maintenance();
    state.admissionPaused = true;
    state.startsPaused = true;
    if (mode === 'restore') {
      state.restorePending = true;
      delete state.restoreReview;
    }
    state.history.push({command:'pause', target:'all', source:'startup', at:new Date().toISOString(), reason:mode === 'restore' ? 'Restored backup requires external side-effect review' : 'Paused service startup'});
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (mode === 'restore') this.db.exec('DELETE FROM execution_start_authorizations');
      this.saveMaintenance(state);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
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
      const capability = config.capabilities.find(cap => cap.id === submission.capability) ?? config.roles?.find(role => role.id === submission.capability);
      if (!capability) throw new Error('Unknown capability');
      await capability.validate(submission.input);
    } catch (error) {
      rejection = error instanceof Error ? error.message : 'Invalid input';
    }
    if (this.maintenance().admissionPaused) throw Error('Admission is paused');
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
      if (rejection === null) {
        this.db.prepare('INSERT INTO executions VALUES (?, ?, ?)').run(executionId, requestId, 'queued');
        const capability = config.capabilities.find(capability => capability.id === submission.capability);
        if (capability?.execution && config.environments.find(environment => environment.id === capability.environment)?.docker) {
          this.db.prepare('INSERT INTO execution_start_authorizations VALUES (?)').run(executionId);
        }
      }
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

  show(id: string) { return this.reader.show(id); }

  list(repo?: string, status?: string, source?: string) { return this.reader.list(repo, status, source); }

  bySourceKey(source: string, key: string) { return this.reader.bySourceKey(source, key); }

  private management(id: string): Record<string, any> { return this.reader.management(id); }

  private saveManagement(id: string, facts: object) {
    this.db.prepare('INSERT INTO execution_management VALUES (?, ?) ON CONFLICT(execution_id) DO UPDATE SET facts = excluded.facts')
      .run(id, JSON.stringify({...this.management(id), ...facts}));
  }

  cancel(id: string, reason: string, kind?: 'deadline') {
    const detail = this.show(id);
    if (!detail.execution) throw Error('Execution not found');
    if (detail.execution.status === 'completed') return detail;
    const attempt = detail.attempts.at(-1);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const cancellation = this.management(String(detail.execution.id)).cancellation ?? {reason, requestedAt: new Date().toISOString(), ...(kind ? {kind} : {})};
      this.saveManagement(String(detail.execution.id), {cancellation});
      if (!attempt || detail.execution.status === 'queued') this.db.prepare("UPDATE executions SET status = 'cancelled' WHERE id = ?").run(String(detail.execution.id));
      else this.db.prepare('UPDATE attempts SET facts = ? WHERE id = ?').run(JSON.stringify({...JSON.parse(String(this.db.prepare('SELECT facts FROM attempts WHERE id = ?').get(String(attempt.id))!.facts)), cancellation}), String(attempt.id));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.show(id);
  }

  private toolNeedsReview(call: Record<string, any>) {
    return !['completed','cancelled','resolved','start_failed'].includes(call.runState) || call.publication?.state==='unknown' || call.requiresAttention || call.persistenceError
      || (call.cancellation && (!call.stopConfirmation || call.stopConfirmation.kind === 'manual') && call.runState !== 'start_failed');
  }

  private toolConfirmed(call: Record<string, any>) {
    return call.stopConfirmation?.kind === 'manual' && typeof call.stopConfirmation.externalResults === 'string' && !!call.stopConfirmation.externalResults.trim();
  }

  private toolReconciled(call: Record<string, any>) {
    return this.toolConfirmed(call) && typeof call.reconciliation?.recordedAt === 'string'
      && Number.isFinite(Date.parse(call.reconciliation.recordedAt)) && ['resolve','retry'].includes(call.reconciliation.decision);
  }

  confirmStop(id: string, audit: Record<string, unknown>, callId?: string, attemptId?: string) {
    const detail = this.show(id); const attempt = callId !== undefined && attemptId !== undefined ? detail.attempts.find(a => a.id === attemptId) : detail.attempts.at(-1);
    if (callId !== undefined && detail.attempts.some(a => this.isLive(String(a.id)))) throw Error('Attempt entrypoint is still live');
    if (attempt && this.isLive(String(attempt.id))) throw Error('Attempt entrypoint is still live');
    if (callId !== undefined) {
      if (typeof callId !== 'string' || !/^[1-9][0-9]*$/.test(callId)) throw Error('Invalid tool call identifier');
      const call = attempt?.toolCalls?.find((c: Record<string, any>) => c.id === callId);
      if (!call) throw Error('Tool call not found');
      for (const field of ['source','handling','reason','externalResults']) if (typeof audit[field] !== 'string' || !(audit[field] as string).trim()) throw Error(`Missing ${field}`);
      const row = this.db.prepare('SELECT facts FROM attempts WHERE id = ?').get(String(attempt.id))!;
      const facts = JSON.parse(String(row.facts));
      this.db.prepare('UPDATE attempts SET facts = ? WHERE id = ?').run(JSON.stringify({...facts,toolCalls:facts.toolCalls.map((c: Record<string, any>) => c.id === callId ? {...c,reconciliation:undefined,stopConfirmation:{...audit,kind:'manual',confirmedAt:new Date().toISOString()}} : c)}),String(attempt.id));
      return this.show(id);
    }
    if (!attempt || attempt.runState !== 'unknown') throw Error('Only unknown attempts can be manually confirmed');
    this.updateAttempt(String(attempt.id), {stopConfirmation:{...audit, kind:'manual', confirmedAt:new Date().toISOString()}});
    return this.show(id);
  }

  recover(id: string, audit: Record<string, unknown>, retry: boolean) {
    const detail = this.show(id);
    if (!detail.execution) throw Error('Execution not found');
    const attempt = detail.attempts.at(-1);
    if (detail.attempts.some(a=>this.isLive(String(a.id)))) throw Error('Attempt entrypoint is still live');
    if (detail.attempts.some(a => ['starting','running','unknown'].includes(a.runState) && !a.stopConfirmation)) throw Error('Stop not confirmed');
    if (detail.attempts.some(a => (a.toolCalls ?? []).some((call: Record<string, any>) => this.toolNeedsReview(call) && !this.toolConfirmed(call)))) throw Error('Tool stop and external results not confirmed');
    const pendingTools = detail.attempts.some(a => (a.toolCalls ?? []).some((call: Record<string, any>) => this.toolNeedsReview(call) && !this.toolReconciled(call)));
    if (detail.execution.status === 'queued' || (!retry && detail.execution.status !== 'unknown' && !pendingTools)) throw Error('Execution is not unresolved or retryable');
    for (const field of ['source','handling','reason','externalResults']) if(typeof audit[field] !== 'string' || !(audit[field] as string).trim()) throw Error(`Missing ${field}`);
    const reconciliation = {...audit, recordedAt:new Date().toISOString(), decision:retry?'retry':'resolve'};
    const actualSha = detail.attempts.find(a=>a.actualSha)?.actualSha ?? this.management(String(detail.execution.id)).fixedSha;
    if(retry && detail.attempts.length && !actualSha) throw Error('Original SHA unavailable; retry is unsafe, submit a new explicitly reviewed request');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if(attempt && attempt.runState === 'unknown') {
        const previous = this.db.prepare('SELECT facts FROM attempts WHERE id = ?').get(String(attempt.id))!;
        this.db.prepare('UPDATE attempts SET run_state = ?, facts = ? WHERE id = ?').run('resolved',JSON.stringify({...JSON.parse(String(previous.facts)),runState:'resolved',reconciliation}),String(attempt.id));
      }
      for (const historical of detail.attempts) {
        if (!(historical.toolCalls ?? []).some((call: Record<string, any>) => this.toolNeedsReview(call))) continue;
        const row = this.db.prepare('SELECT facts FROM attempts WHERE id = ?').get(String(historical.id))!;
        const facts = JSON.parse(String(row.facts));
        this.db.prepare('UPDATE attempts SET facts = ? WHERE id = ?').run(JSON.stringify({...facts,toolCalls:facts.toolCalls.map((call: Record<string, any>) => this.toolNeedsReview(call) ? {...call,reconciliation} : call)}),String(historical.id));
      }
      this.saveManagement(String(detail.execution.id), {cancellation:null, fixedSha:actualSha ?? this.management(String(detail.execution.id)).fixedSha, reconciliation});
      this.db.prepare('UPDATE executions SET status = ? WHERE id = ?').run(retry?'queued':'resolved',String(detail.execution.id));
      if (retry) this.db.prepare('INSERT OR IGNORE INTO execution_start_authorizations VALUES (?)').run(String(detail.execution.id));
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
    if(attempt){this.priorAttempts.delete(String(attempt.id));this.unresolved.delete(String(attempt.id));}
    return this.show(id);
  }

  beginAttempt(executionId: string, version: string, capability: string, environment: string, selectedSha: string, facts: Record<string,unknown> = {}) {
    const detail = this.show(executionId);
    if(detail.execution?.status !== 'queued' || this.management(executionId).cancellation) throw Error('Execution cannot start');
    if(detail.attempts.some(a=>['starting','running','unknown'].includes(a.runState) && !a.stopConfirmation)) throw Error('Stop not confirmed');
    if (detail.attempts.some(a => (a.toolCalls ?? []).some((call: Record<string, any>) => this.toolNeedsReview(call) && !this.toolReconciled(call)))) throw Error('Tool stop and external results not confirmed');
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const deadlineAt = typeof facts.attemptDeadlineSeconds === 'number' ? new Date(Date.parse(createdAt) + facts.attemptDeadlineSeconds * 1000).toISOString() : undefined;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO attempts VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, executionId, version, capability, environment, 'starting', JSON.stringify({ ...facts, createdAt, ...(deadlineAt ? {deadlineAt} : {}), selectedSha }));
      this.saveManagement(executionId,{fixedSha:selectedSha});
      this.db.prepare("UPDATE executions SET status = 'starting' WHERE id = ?").run(executionId);
      this.db.prepare('DELETE FROM execution_start_authorizations WHERE execution_id = ?').run(executionId);
      this.db.exec('COMMIT');
      this.liveAttempts.add(id);
      return id;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private mutableAttempt(id: string) {
    const row = this.db.prepare(`SELECT facts, run_state FROM attempts WHERE id = ?
      AND id = (SELECT id FROM attempts WHERE execution_id = (SELECT execution_id FROM attempts WHERE id = ?) ORDER BY rowid DESC LIMIT 1)`).get(id,id);
    if (!row || ['completed','cancelled','resolved','start_failed'].includes(String(row.run_state)) || JSON.parse(String(row.facts)).stopConfirmation) return;
    return row;
  }

  updateAttempt(id: string, facts: Record<string, unknown>) {
    const row=this.mutableAttempt(id);
    if (!row) return;
    if (JSON.parse(String(row.facts)).cancellation && facts.runState === 'running') throw Error('Cancellation requested');
    const state=typeof facts.runState==='string'?facts.runState:String(row.run_state);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE attempts SET facts = ?, run_state = ? WHERE id = ?').run(JSON.stringify({...JSON.parse(String(row.facts)),...facts}),state,id);
      this.db.prepare('UPDATE executions SET status = ? WHERE id = (SELECT execution_id FROM attempts WHERE id = ?)').run(state,id);
      this.db.exec('COMMIT');
    } catch(error){this.db.exec('ROLLBACK');throw error}
  }

  finishAttempt(id: string, state: string, facts: object) {
    const existing=this.mutableAttempt(id);
    if(!existing) return;
    const previous = JSON.parse(String(existing.facts));
    if(previous.cancellation && state === 'completed') {
      state = 'cancelled';
      const suppliedStop = (facts as {stopConfirmation?:unknown}).stopConfirmation;
      if (previous.kind === 'agent' && !suppliedStop) state = 'unknown';
      facts = {...facts, stopConfirmation: suppliedStop ?? (previous.kind === 'agent' ? undefined : previous.containerState?.Running === false ? {kind:'docker-inspect',confirmedAt:new Date().toISOString(),containerState:previous.containerState} : {kind:'never-started',confirmedAt:new Date().toISOString()})};
      const cancelledFacts = {...previous,...facts} as Record<string,unknown>;
      delete cancelledFacts.business; delete cancelledFacts.businessReference; delete cancelledFacts.contract;
      facts = cancelledFacts;
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE attempts SET run_state = ?, facts = ? WHERE id = ?').run(state, JSON.stringify({...JSON.parse(String(existing.facts)),...facts,runState:state,...(['completed','cancelled','resolved','start_failed'].includes(state) ? {endedAt:(facts as {endedAt?:string}).endedAt ?? new Date().toISOString()} : {})}), id);
      this.db.prepare('UPDATE executions SET status = ? WHERE id = (SELECT execution_id FROM attempts WHERE id = ?)').run(state, id);
      this.db.exec('COMMIT');
      this.priorAttempts.delete(id);
      this.unresolved.delete(id);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  markExecutionFailure(id: string, configVersion: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.db.prepare("UPDATE executions SET status = 'start_failed' WHERE id = ? AND status = 'queued'").run(id).changes;
      if (changed) {
        const previous = this.management(id).startFailures ?? [];
        this.saveManagement(id, {startFailures:[...previous, {recordedAt:new Date().toISOString(),configVersion,
          classification:'execution_start_failure',reason:'Execution failed before a durable attempt could start',logEvent:'execution_failure'}]});
      }
      this.db.exec('COMMIT');
    } catch (error) {this.db.exec('ROLLBACK');throw error;}
  }

  markUnresolved(id: string, error: unknown) {
    this.unresolved.set(id, error instanceof Error ? error.message : 'Required record save failed');
  }

  cleanup(data: string) {
    const attempts: {attemptId: string; status: string; reason?: string}[] = [];
    const now = Date.now();
    // ponytail: synchronous local unlinks serialize state changes in the single writer;
    // use an explicit per-execution reservation if cleanup ever moves to a worker.
    for (const detail of this.list()) {
      const terminal = ['completed', 'cancelled', 'resolved', 'start_failed'];
      const latest = detail.attempts.at(-1);
      const endedAt = detail.execution?.status === 'resolved' ? this.management(String(detail.execution.id)).reconciliation?.recordedAt : latest?.endedAt;
      const ended = typeof endedAt === 'string' ? Date.parse(endedAt) : NaN;
      if (!terminal.includes(String(detail.execution?.status)) || !Number.isFinite(ended)
        || now - ended < 30 * 24 * 60 * 60 * 1000
        || detail.attempts.some(a => this.isLive(String(a.id)) || !terminal.includes(a.runState) || a.requiresAttention
          || a.persistenceError && (a.runState !== 'resolved' || !a.reconciliation) || (a.toolCalls ?? []).some((call:Record<string,any>) => this.toolNeedsReview(call) && !this.toolReconciled(call)) || (a.cancellation && !a.stopConfirmation && a.runState !== 'start_failed'))) continue;
      for (const attempt of detail.attempts) {
        const id = String(attempt.id);
        if (attempt.cleanup?.status === 'cleaned' && (attempt.toolCalls ?? []).every((call:Record<string,any>)=>call.cleanup?.status === 'cleaned')) { attempts.push({attemptId:id,status:'cleaned'}); continue; }
        const save = (cleanup: object) => {
          const row = this.db.prepare('SELECT facts FROM attempts WHERE id = ?').get(id)!;
          this.db.prepare('UPDATE attempts SET facts = ? WHERE id = ?').run(JSON.stringify({...JSON.parse(String(row.facts)), cleanup, logs:{...attempt.logs,complete:false}, ...(attempt.toolCalls ? {toolCalls:attempt.toolCalls.map((call:Record<string,any>)=>({...call,cleanup,logs:{...call.logs,complete:false}}))} : {})}),id);
        };
        save({status:'unknown',startedAt:new Date(now).toISOString()});
        try {
          if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(id)) throw Error('Unsafe attempt identifier');
          const directory = join(data,'attempts',id);
          const checkDirectory = (path: string) => {
            try { if (!lstatSync(path).isDirectory()) throw Error('Cleanup path is not a physical directory'); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          };
          checkDirectory(data); checkDirectory(join(data,'attempts')); checkDirectory(directory);
          const targets: string[] = [];
          for (const evidence of [attempt,...(attempt.toolCalls ?? [])]) {
            const tool = evidence !== attempt;
            if (tool && (typeof evidence.id !== 'string' || !/^[1-9][0-9]*$/.test(evidence.id))) throw Error('Unsafe tool call identifier');
            const base = tool ? join(directory,'tools',evidence.id) : directory;
            if (tool) { checkDirectory(join(directory,'tools')); checkDirectory(base); }
            const names = (evidence.artifacts ?? []).map((a: {name:string}) => a.name);
            if (names.some((name: unknown) => typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))) throw Error('Unsafe artifact name');
            if (names.length) checkDirectory(join(base,'artifacts'));
            targets.push(join(base,'stdout.log'),join(base,'stderr.log'),...(tool ? [join(base,'result.json')] : []),...names.map((name:string)=>join(base,'artifacts',name)));
          }
          for (const path of targets) {
            try { if (!lstatSync(path).isFile()) throw Error('Cleanup target is not a regular file'); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          }
          for (const path of targets) {
            try { unlinkSync(path); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          }
          if (attempt.kind === 'agent') {
            // This validation snapshot is never mounted or handed to the provider.
            // Preflight the whole tree so an unexpected link never causes partial traversal.
            const files: string[] = []; const directories: string[] = [];
            const scan = (path: string) => {
              let stat;
              try { stat = lstatSync(path); }
              catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
              if (stat.isFile()) { files.push(path); return; }
              if (!stat.isDirectory()) throw Error('Context snapshot contains an unsafe target');
              for (const name of readdirSync(path)) scan(join(path,name));
              directories.push(path);
            };
            scan(join(directory,'context'));
            for (const path of files) unlinkSync(path);
            for (const path of directories) rmdirSync(path);
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'Cleanup failed';
          save({status:'failed',failedAt:new Date(now).toISOString(),reason});
          attempts.push({attemptId:id,status:'failed',reason});
          continue;
        }
        // Filesystem success is not persisted success: leave unknown if this save fails.
        save({status:'cleaned',finishedAt:new Date(now).toISOString()});
        attempts.push({attemptId:id,status:'cleaned'});
      }
    }
    return {attempts};
  }

  close() { this.db.close(); }
}
