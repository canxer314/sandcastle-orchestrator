import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export async function loadConfiguration(path: string): Promise<Configuration> {
  const config = (await import(pathToFileURL(resolve(path)).href)).default;
  if (!config || typeof config.version !== 'string' || !config.version) throw new Error('Missing configuration version');
  for (const [key, label] of [['repos', 'repo'], ['environments', 'environment'], ['capabilities', 'capability']]) {
    if (!Array.isArray(config[key])) throw new Error(`Missing ${key}`);
    const ids = new Set<string>();
    for (const item of config[key]) {
      if (!item || typeof item.id !== 'string' || !item.id) throw new Error(`Invalid ${label} id`);
      if (ids.has(item.id)) throw new Error(`Duplicate ${label} id: ${item.id}`);
      ids.add(item.id);
    }
  }
  for (const repo of config.repos) {
    if (typeof repo.location !== 'string' || !repo.location) throw new Error(`Missing repo location: ${repo.id}`);
  }
  for (const capability of config.capabilities) {
    if (!config.environments.some((env: { id: string }) => env.id === capability.environment)) throw new Error(`Unknown environment: ${capability.environment}`);
    if (typeof capability.validate !== 'function' || typeof capability.run !== 'function') throw new Error(`Missing capability validator or entrypoint: ${capability.id}`);
  }
  return config;
}

export interface Configuration {
  version: string;
  repos: { id: string; location: string }[];
  environments: { id: string }[];
  capabilities: {
    id: string;
    environment: string;
    validate(input: unknown): unknown;
    run: (...args: never[]) => unknown;
  }[];
}

export interface Submission {
  repo: string;
  capability: string;
  input: unknown;
  source: string;
}
