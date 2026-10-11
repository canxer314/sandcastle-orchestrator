import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
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
      if (!capability.execution || typeof capability.execution.commit !== 'function') throw Error(`Missing execution commit selector: ${capability.id}`);
      const environment = config.environments.find((env: {id:string}) => env.id === capability.environment);
      if (!environment.docker) throw Error(`Execution capability requires Docker environment: ${capability.id}`);
      if (typeof environment.docker.image !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/@:-]*$/.test(environment.docker.image)) throw Error(`Invalid Docker image: ${environment.id}`);
    }
  }
  if(config.tools!==undefined && !Array.isArray(config.tools))throw Error('Invalid tools');
  const toolIds=new Set<string>();
  for(const tool of config.tools ?? []) {
    if(!tool || typeof tool.id!=='string' || !tool.id || toolIds.has(tool.id) || typeof tool.description!=='string' || (tool.read!==undefined && typeof tool.read!=='function'))throw Error('Invalid or duplicate tool');
    toolIds.add(tool.id);
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
    providerIds.add(provider.id);
  }
  const bindings=new Set<string>();
  for(const binding of config.roleBindings ?? []) {
    const environment=config.environments.find((e:{id:string})=>e.id===binding.environment);
    if(!config.roles?.some((r:Role)=>r.id===binding.role) || !providerIds.has(binding.provider) || bindings.has(binding.role) || typeof binding.commit!=='function' || !environment?.docker)throw Error('Invalid role binding');
    if(!/^[a-zA-Z0-9][a-zA-Z0-9._/@:-]*$/.test(environment.docker.image))throw Error('Invalid role Docker image');
    if(environment.docker.network==='host')throw Error('Role Docker host network is not permitted');
    if(binding.attemptDeadlineSeconds!==undefined && (typeof binding.attemptDeadlineSeconds!=='number' || !Number.isFinite(binding.attemptDeadlineSeconds) || binding.attemptDeadlineSeconds<=0 || binding.attemptDeadlineSeconds>(8640000000000000-Date.now())/1000))throw Error('Invalid role attempt deadline');
    bindings.add(binding.role);
  }
  if (config.mcpServices !== undefined && !Array.isArray(config.mcpServices)) throw Error('Invalid MCP services');
  const serviceIds = new Set<string>();
  for (const service of config.mcpServices ?? []) {
    if (!service || typeof service.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(service.id) || serviceIds.has(service.id) || typeof service.prepare !== 'function' || !Array.isArray(service.tools) || service.tools.some((t: unknown) => typeof t !== 'string' || !t) || !service.capabilities || typeof service.access !== 'string' || !service.access || !['none','code'].includes(service.context)) throw Error('Invalid MCP service');
    serviceIds.add(service.id);
    for (const key of ['context','directory','logs','longTasks','query','cancel','retry']) if (service.capabilities[key] !== null && (typeof service.capabilities[key] !== 'string' || !service.capabilities[key])) throw Error(`Missing MCP capability description: ${service.id}/${key}`);
  }
  for (const role of config.roles ?? []) {
    if (role.mcp !== undefined && !Array.isArray(role.mcp)) throw Error(`Invalid MCP references: ${role.id}`);
    const ids = new Set<string>();
    for (const reference of role.mcp ?? []) {
      if (!reference || typeof reference.service !== 'string') throw Error(`Invalid MCP reference: ${role.id}`);
      const service = config.mcpServices?.find((s: McpService) => s.id === reference.service);
      if (!service) throw Error(`Unknown MCP service: ${reference.service}`);
      if (ids.has(reference.service) || !Array.isArray(reference.tools) || !reference.tools.length || reference.tools.some((t: unknown) => typeof t !== 'string' || !service.tools.includes(t)) || (reference.requiredCapabilities !== undefined && (!Array.isArray(reference.requiredCapabilities) || reference.requiredCapabilities.some((c: string) => !Object.hasOwn(service.capabilities,c))))) throw Error(`Invalid MCP tool or capability references: ${role.id}`);
      ids.add(reference.service);
      const binding = config.roleBindings?.find((b: {role:string}) => b.role === role.id);
      if (binding && typeof config.providers.find((p: {id:string}) => p.id === binding.provider)?.configureMcp !== 'function') throw Error(`Provider cannot configure MCP: ${binding.provider}`);
    }
  }
  return config;
}

export type McpCapability = 'context' | 'directory' | 'logs' | 'longTasks' | 'query' | 'cancel' | 'retry';
export interface McpService {
  id: string;
  tools: string[];
  // null means unavailable; text describes the actual service behavior and limits.
  capabilities: Record<McpCapability, string | null>;
  access: string;
  context: 'none' | 'code';
  prepare(context: {repo: string; actualSha: string; workspace: string; attemptId: string}): Promise<{
    configFile: string;
    binding?: {repo: string; actualSha: string; location: string};
  }>;
}
export interface McpReference {
  service: string;
  tools: string[];
  requiredCapabilities?: McpCapability[];
}
export interface McpConnection {service: string; configFile: string; tools: string[]}

export interface Role {
  id: string;
  description: string;
  validate(input: unknown): unknown;
  buildPrompt(context: {input: unknown; repo: string; actualSha: string}): string | Promise<string>;
  skills: string[];
  tools: string[];
  mcp?: McpReference[];
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
  tools?: {id:string; description:string; read?(input:unknown): Promise<unknown>}[];
  mcpServices?: McpService[];
  providers?: {id: string; agent: AgentProvider; configureMcp?(agent: AgentProvider, connections: McpConnection[]): AgentProvider}[];
  roleBindings?: {role: string; provider: string; environment: string; attemptDeadlineSeconds?: number; commit(input: unknown): string}[];
  repos: { id: string; location: string }[];
  environments: { id: string; docker?: { image: string; binary?: string; network?: string; env?: Record<string,string> } }[];
  capabilities: {
    id: string;
    environment: string;
    validate(input: unknown): unknown;
    execution?: { commit(input: unknown): string };
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
