import { createServer, request } from 'node:http';
import { mkdir, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireControlLock } from './lock.js';
import { checkDataSeparation } from './paths.js';
import { Records } from './records.js';
import { loadConfiguration, type Submission } from './config.js';

export async function serve(data: string, configPath: string) {
  const config = await loadConfiguration(configPath);
  await checkDataSeparation(data, configPath, config);
  process.umask(0o077);
  await mkdir(data, { recursive: true, mode: 0o700 });
  await chmod(data, 0o700);
  const releaseLock = await acquireControlLock(join(data, 'control.lock'));
  let records: Records;
  try {
    records = new Records(join(data, 'records.sqlite'));
  } catch (error) {
    releaseLock();
    throw error;
  }
  const socket = join(data, 'control.sock');
  const server = createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body);
      let result;
      switch (message?.command) {
        case 'submit':
          if (!message.submission || !Object.hasOwn(message.submission, 'input')) throw new Error('Missing input');
          for (const field of ['repo', 'capability', 'source']) {
            if (typeof message.submission[field] !== 'string' || !message.submission[field]) throw new Error(`Invalid ${field}`);
          }
          result = await records.submit(message.submission as Submission, config);
          break;
        case 'list':
          result = records.list(message.repo, message.status);
          break;
        case 'show':
          result = records.show(message.id);
          break;
        default:
          throw new Error('Unknown command');
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(result));
    } catch (error) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Request failed' }));
    }
  });
  try {
    await rm(socket, { force: true });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, () => resolve());
    });
    await chmod(socket, 0o600);
  } catch (error) {
    server.close();
    records.close();
    releaseLock();
    throw error;
  }
  console.log(JSON.stringify({ ready: true, socket }));
  const shutdown = () => {
    server.close(async () => {
      records.close();
      await rm(socket, { force: true });
      releaseLock();
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

export function call(socket: string, message: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, path: '/', method: 'POST' }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          if (res.statusCode !== 200) reject(new Error(result.error));
          else resolve(result);
        } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify(message));
  });
}
