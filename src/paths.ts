import { realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { Configuration } from './config.js';

async function physicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try { return await realpath(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return join(await physicalPath(dirname(absolute)), basename(absolute));
  }
}

function contains(parent: string, child: string) {
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
