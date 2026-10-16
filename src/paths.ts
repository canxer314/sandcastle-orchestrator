import { realpath, lstat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { Configuration } from './config.js';

export async function physicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try { return await realpath(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return join(await physicalPath(dirname(absolute)), basename(absolute));
  }
}

export function contains(parent: string, child: string) {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep));
}

export async function checkDataSeparation(data: string, configPath: string, config: Configuration) {
  const runtime = await physicalPath(data);
  const protectedPaths = [resolve(import.meta.dirname, '..'), dirname(resolve(configPath)), dirname(await physicalPath(configPath)), ...config.repos.map(repo => repo.location)];
  for (const path of protectedPaths) {
    const protectedPath = await physicalPath(path);
    if (contains(runtime, protectedPath) || contains(protectedPath, runtime)) {
      throw new Error('Runtime data must be separate from application, configuration and target checkouts');
    }
  }
}

export async function checkToolEvidenceDirectories(directory: string, callId: string, artifact: boolean, allowMissing = false) {
  for (const path of [dirname(dirname(directory)), dirname(directory), directory, join(directory, 'tools'), join(directory, 'tools', callId), ...(artifact ? [join(directory, 'tools', callId, 'artifacts')] : [])]) {
    try { if (!(await lstat(path)).isDirectory()) throw Error('Tool evidence path is not a physical directory'); }
    catch (error) { if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
