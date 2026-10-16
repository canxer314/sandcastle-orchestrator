import { constants } from 'node:fs';
import { checkToolEvidenceDirectories } from './paths.js';
import { stat, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class RecordReader {
  constructor(private db: DatabaseSync, private projection?: {unknown(id: string): boolean; error(id: string): string | undefined}) {}

  show(id: string) {
    const row = this.db.prepare(`SELECT r.*, e.id AS execution_id, e.status, m.scheduled_at, m.deduplication_key
      FROM requests r LEFT JOIN executions e ON e.request_id = r.id
      LEFT JOIN submission_metadata m ON m.request_id = r.id
      WHERE e.id = ? OR r.id = ?`).get(id, id);
    if (!row) throw new Error('Execution not found');
    const attempts = this.db.prepare('SELECT * FROM attempts WHERE execution_id = ? ORDER BY rowid').all(String(row.execution_id)).map(a => {
      const unknown = this.projection?.unknown(String(a.id)) ?? false;
      const facts = JSON.parse(String(a.facts));
      return {
        id: a.id, configVersion: a.config_version, capability: a.capability, environment: a.environment,
        ...facts, ...(facts.cleanup ? {logs:{...facts.logs,complete:false},...(facts.toolCalls ? {toolCalls:facts.toolCalls.map((call:Record<string,any>)=>({...call,logs:{...call.logs,complete:false}}))} : {})} : {}), runState: unknown ? 'unknown' : a.run_state,
        ...(unknown ? { persistedRunState: a.run_state, requiresAttention: true } : {}),
        ...(!this.projection && ['starting', 'running'].includes(String(a.run_state)) ? {activityVerified:false} : {}),
        location: {container:JSON.parse(String(a.facts)).container ?? null, processIdentity:null, reconnectHandle:null, limitation:'No harness process identity or reconnect handle; container name is evidence, not proof of stopping'},
        ...(this.projection?.error(String(a.id)) !== undefined ? { persistenceError: this.projection!.error(String(a.id)) } : {}),
      };
    });
    const management = this.management(String(row.execution_id));
    return {
      request: { id: row.id, repo: row.repo, capability: row.capability, input: JSON.parse(String(row.input)), source: row.source, createdAt: row.created_at, scheduledAt: row.scheduled_at ?? null, deduplicationKey: row.deduplication_key ?? null, rejection: row.rejection },
      execution: row.execution_id ? { id: row.execution_id, ...management, status: attempts.at(-1)?.runState === 'unknown' ? 'unknown' : row.status } : null,
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

  bySourceKey(source: string, key: string) {
    return this.db.prepare(`SELECT r.id FROM requests r JOIN submission_metadata m ON m.request_id = r.id
      WHERE r.source = ? AND m.deduplication_key = ? ORDER BY r.rowid`).all(source, key)
      .map(row => { const detail = this.show(String(row.id)); return {accepted:detail.execution !== null, ...detail}; });
  }

  management(id: string): Record<string, any> {
    const row = this.db.prepare('SELECT facts FROM execution_management WHERE execution_id = ?').get(id);
    return row ? JSON.parse(String(row.facts)) : {};
  }

}

export function showQuery(reader: Pick<RecordReader, 'show' | 'bySourceKey'>, message: {id?: string; source?: string; deduplicationKey?: string}) {
  if (message.source !== undefined || message.deduplicationKey !== undefined) {
    if (message.id !== undefined) throw Error('Identifier and source/key are mutually exclusive');
    for (const field of ['source','deduplicationKey'] as const) {
      if (typeof message[field] !== 'string' || !message[field]) throw Error(`Invalid ${field}`);
    }
    return reader.bySourceKey(message.source!, message.deduplicationKey!);
  }
  return reader.show(message.id!);
}

export async function offlineQuery(data: string, message: {command: string; id?: string; source?: string; deduplicationKey?: string; repo?: string; status?: string; attempt?: string; call?: string}) {
  if (!['show','list','logs'].includes(message.command)) throw Error('Unsupported offline query');
  const path = resolve(data, 'records.sqlite');
  let header: Buffer;
  try {
    if (!(await stat(path)).isFile()) throw Error('Records path is not a regular file');
    const file = await open(path, 'r');
    try {
      header = Buffer.alloc(100);
      const {bytesRead} = await file.read(header,0,100,0);
      header = header.subarray(0,bytesRead);
    } finally { await file.close(); }
  } catch (error) {
    throw Error(`Cannot read records at ${path}: ${error instanceof Error ? error.message : 'Read failed'}`);
  }
  if (header.length < 100 || header.toString('utf8',0,16) !== 'SQLite format 3\0') throw Error(`Unsupported records structure at ${path}`);
  // Reject WAL before opening: even read-only SQLite may create WAL shared memory.
  // Hot journals require recovery, which an offline query must never perform.
  for (const suffix of ['-wal','-journal']) {
    try { if ((await stat(path + suffix)).size > 0) throw Error(`Unsupported offline records journal at ${path + suffix}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (header[18] !== 1 || header[19] !== 1) throw Error(`Unsupported offline records journal mode at ${path}`);
  const db = new DatabaseSync(path, {readOnly:true});
  try {
    db.exec('BEGIN');
    try {
      for (const query of [
        'SELECT rowid,id,repo,capability,input,source,created_at,rejection FROM requests LIMIT 0',
        'SELECT id,request_id,status FROM executions LIMIT 0',
        'SELECT rowid,id,execution_id,config_version,capability,environment,run_state,facts FROM attempts LIMIT 0',
        'SELECT request_id,scheduled_at,deduplication_key FROM submission_metadata LIMIT 0',
        'SELECT execution_id,facts FROM execution_management LIMIT 0',
      ]) db.prepare(query).all();
    } catch (error) { throw Error(`Unsupported records structure at ${path}: ${error instanceof Error ? error.message : 'Read failed'}`); }
    const reader = new RecordReader(db);
    if (message.command === 'show') return showQuery(reader,message);
    if (message.command === 'list') return reader.list(message.repo,message.status,message.source);
    return await queryEvidence(reader,data,message);
  } finally { db.close(); }
}

export async function queryEvidence(reader: Pick<RecordReader, 'show'>, data: string, message: {command:string;id?:string;attempt?:string;call?:string;name?:string;offset?:number}) {
  let result;
  const detail = reader.show(message.id!);
  const attempt = detail.attempts.find(a => a.id === message.attempt) ?? (message.attempt ? undefined : detail.attempts.at(-1));
  if (!attempt) throw Error('Attempt not found');
  if (message.call !== undefined && (typeof message.call !== 'string' || !/^[1-9][0-9]*$/.test(message.call))) throw Error('Invalid tool call identifier');
  const evidence = message.call === undefined ? attempt : attempt.toolCalls?.find((c:{id:string})=>c.id===message.call);
  if (!evidence) throw Error('Tool call not found');
  const directory = join(data, 'attempts', String(attempt.id),...(message.call === undefined ? [] : ['tools',message.call]));
  if (message.command === 'artifact' && !evidence.artifacts?.some((a: {name:string}) => a.name === message.name)) throw Error('Artifact not registered');
  if (attempt.cleanup) {
    result = message.command === 'logs'
      ? {attemptId:attempt.id,actualSha:attempt.actualSha,availability:attempt.cleanup.status,cleanup:attempt.cleanup,stdout:null,stderr:null,truncated:{stdout:false,stderr:false},complete:false}
      : {attemptId:attempt.id,actualSha:attempt.actualSha,name:message.name,availability:attempt.cleanup.status,cleanup:attempt.cleanup,encoding:'base64',content:null};
    if (message.call !== undefined) result = {...result,callId:message.call};
    return result;
  }
  if (message.call !== undefined) await checkToolEvidenceDirectories(join(data,'attempts',String(attempt.id)),message.call,message.command === 'artifact',true);
  if (message.command === 'logs') {
    const read = async (stream: string) => {
      try {
        const file=await open(join(directory, `${stream}.log`),constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat=await file.stat();if(!stat.isFile())throw Error('Log is not a regular file');
          const buffer=Buffer.alloc(Math.min(stat.size,65536));
          await file.read(buffer,0,buffer.length,Math.max(0,stat.size-buffer.length));
          return {text:buffer.toString('utf8'),truncated:stat.size>buffer.length};
        } finally {await file.close()}
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    };
    const stdout = await read('stdout'); const stderr = await read('stderr');
    result = {attemptId:attempt.id,actualSha:attempt.actualSha,availability:stdout !== null && stderr !== null ? 'available' : 'unavailable',stdout:stdout?.text??null,stderr:stderr?.text??null,truncated:{stdout:stdout?.truncated??false,stderr:stderr?.truncated??false},complete:evidence.logs?.complete === true && stdout !== null && stderr !== null};
  } else {
    const { readArtifact } = await import('./execution.js');
    let content: Awaited<ReturnType<typeof readArtifact>> | null;
    try { content = await readArtifact(join(directory,'artifacts'),message.name!,message.offset); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; content = null; }
    result = {attemptId:attempt.id,actualSha:attempt.actualSha,name:message.name,availability:content === null ? 'unavailable' : 'available',encoding:'base64',...(typeof content==='object' && content!==null?content:{content})};
  }
  // File reads yield to other management requests; do not return stale completeness
  // if cleanup removed evidence while the descriptor was open.
  const current = reader.show(message.id!).attempts.find(a => a.id === attempt.id);
  if (current?.cleanup) result = message.command === 'logs'
    ? {attemptId:attempt.id,actualSha:attempt.actualSha,availability:current.cleanup.status,cleanup:current.cleanup,stdout:null,stderr:null,truncated:{stdout:false,stderr:false},complete:false}
    : {attemptId:attempt.id,actualSha:attempt.actualSha,name:message.name,availability:current.cleanup.status,cleanup:current.cleanup,encoding:'base64',content:null};
  if (message.call !== undefined) result = {...result,callId:message.call};
  return result;
}
