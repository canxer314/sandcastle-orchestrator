import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { z, type ZodObject } from 'zod';
import type { AgentProvider } from '@ai-hero/sandcastle';

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
    if (capability.execution !== undefined) {
      if(capability.execution?.workspace!==undefined && capability.execution.workspace!=='readonly')throw Error('Invalid capability execution workspace mode');
      if (!capability.execution || typeof capability.execution.commit !== 'function') throw Error(`Missing execution commit selector: ${capability.id}`);
      const environment = config.environments.find((env: {id:string}) => env.id === capability.environment);
      if (!environment.docker) throw Error(`Execution capability requires Docker environment: ${capability.id}`);
      if (typeof environment.docker.image !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/@:-]*$/.test(environment.docker.image)) throw Error(`Invalid Docker image: ${environment.id}`);
    }
  }
  if(config.tools!==undefined && !Array.isArray(config.tools))throw Error('Invalid tools');
  const toolIds=new Set<string>();
  for(const tool of config.tools ?? []) {
    if(!tool || typeof tool.id!=='string' || !tool.id || toolIds.has(tool.id) || typeof tool.description!=='string' || !tool.description)throw Error('Invalid or duplicate tool');
    toolIds.add(tool.id);
    if(tool.capability!==undefined) {
      const capability=config.capabilities.find((c:{id:string})=>c.id===tool.capability);
      if(capability?.execution?.workspace!=='readonly')throw Error('Executable tools require capability.execution.workspace: readonly');
      if(!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(tool.id) || tool.id==='read_tool_file' || !capability?.execution || !tool.inputSchema || typeof tool.inputSchema.strict!=='function')throw Error('Invalid executable tool binding');
      tool.inputSchema=tool.inputSchema.strict();
      const schema=z.toJSONSchema(tool.inputSchema) as {properties?:Record<string,unknown>};
      if(['repo','attemptId','actualSha','workspace','environment','credentials'].some(key=>schema.properties?.[key]))throw Error('Tool schema must not accept trusted identity or credentials');
    } else if(tool.inputSchema!==undefined)throw Error('Tool schema requires explicit capability');
  }
  if (config.roles !== undefined && !Array.isArray(config.roles)) throw Error('Invalid roles');
  for (const role of config.roles ?? []) {
    if (!role || typeof role.id !== 'string' || !role.id || config.capabilities.some((c: {id:string}) => c.id === role.id)) throw Error('Invalid or conflicting role id');
    if ((config.roles as Role[]).filter(r => r.id === role.id).length !== 1) throw Error(`Duplicate role id: ${role.id}`);
    if (typeof role.description !== 'string' || !role.description || typeof role.validate !== 'function' || typeof role.buildPrompt !== 'function' || typeof role.validateReport !== 'function' || !Array.isArray(role.skills) || !Array.isArray(role.tools)) throw Error(`Invalid role definition: ${role.id}`);
    if(role.skills.some((s:unknown)=>typeof s!=='string') || role.tools.some((t:unknown)=>typeof t!=='string' || !config.tools?.some((tool:{id:string})=>tool.id===t)))throw Error(`Invalid role skills or tool references: ${role.id}`);
  }
  for (const [key,label] of [['providers','provider'],['roleBindings','role binding']] as const) if(config[key]!==undefined && !Array.isArray(config[key]))throw Error(`Invalid ${label} list`);
  const providerIds=new Set<string>();
  for(const provider of config.providers ?? []) {
    if(!provider || typeof provider.id!=='string' || !provider.id || providerIds.has(provider.id) || typeof provider.agent?.buildPrintCommand!=='function' || typeof provider.agent?.parseStreamLine!=='function')throw Error('Invalid or duplicate provider');
    if(provider.mcp!==undefined && provider.mcp!=='claude-code')throw Error('Only claude-code MCP provider is supported');
    providerIds.add(provider.id);
  }
  const bindings=new Set<string>();
  for(const binding of config.roleBindings ?? []) {
    const environment=config.environments.find((e:{id:string})=>e.id===binding.environment);
    if(!config.roles?.some((r:Role)=>r.id===binding.role) || !providerIds.has(binding.provider) || bindings.has(binding.role) || typeof binding.commit!=='function' || !environment?.docker)throw Error('Invalid role binding');
    if(!/^[a-zA-Z0-9][a-zA-Z0-9._/@:-]*$/.test(environment.docker.image))throw Error('Invalid role Docker image');
    if(environment.docker.network==='host')throw Error('Role Docker host network is not permitted');
    const role=config.roles.find((r:Role)=>r.id===binding.role);
    if(role.tools.some((id:string)=>config.tools?.some((t:{id:string;capability?:string})=>t.id===id && t.capability)) && config.providers.find((p:{id:string})=>p.id===binding.provider).mcp!=='claude-code')throw Error('Executable role tools require explicit claude-code MCP provider');
    bindings.add(binding.role);
  }
  return config;
}

export interface Role {
  id: string;
  description: string;
  validate(input: unknown): unknown;
  buildPrompt(context: {input: unknown; repo: string; actualSha: string}): string | Promise<string>;
  skills: string[];
  tools: string[];
  validateReport(output: string): unknown;
}

export interface ExecutionContext {
  actualSha: string;
  attemptId: string;
  input: unknown;
  exec(argv: string[]): Promise<{stdout:string;stderr:string;exitCode:number}>;
}

export interface Configuration {
  version: string;
  roles?: Role[];
  tools?: {id:string; description:string; capability?:string; inputSchema?:ZodObject}[];
  providers?: {id: string; agent: AgentProvider; mcp?:'claude-code'}[];
  roleBindings?: {role: string; provider: string; environment: string; commit(input: unknown): string}[];
  repos: { id: string; location: string }[];
  environments: { id: string; docker?: { image: string; binary?: string; network?: string; env?: Record<string,string> } }[];
  capabilities: {
    id: string;
    environment: string;
    validate(input: unknown): unknown;
    execution?: { commit(input: unknown): string; workspace?:'readonly' };
    run(context: ExecutionContext): unknown;
  }[];
}

export interface Submission {
  repo: string;
  capability: string;
  input: unknown;
  source: string;
  deduplicationKey?: string;
  scheduledAt?: string;
}
