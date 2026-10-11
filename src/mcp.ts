import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { AgentProvider } from '@ai-hero/sandcastle';
import type { Configuration, McpConnection, Role } from './config.js';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// Native Claude Code configuration; no MCP client, proxy, or tool contract translation.
export function configureClaudeMcp(agent: AgentProvider, connections: McpConnection[]): AgentProvider {
  return {...agent, buildPrintCommand(options) {
    const original = agent.buildPrintCommand(options);
    const files = connections.map(c => quote(c.configFile)).join(' ');
    return {...original, command: `${original.command} --strict-mcp-config --mcp-config ${files}`};
  }};
}

export async function prepareMcp(config: Configuration, role: Role, context: {repo: string; actualSha: string; workspace: string; attemptId: string}) {
  const mounts: {hostPath: string; sandboxPath: string}[] = [];
  const connections: McpConnection[] = [];
  const facts = [];
  for (const reference of role.mcp ?? []) {
    const service = config.mcpServices!.find(s => s.id === reference.service)!;
    for (const capability of reference.requiredCapabilities ?? []) {
      if (service.capabilities[capability] === null) throw Error(`MCP required capability unavailable: ${service.id}/${capability}`);
    }
    let prepared: Awaited<ReturnType<typeof service.prepare>>;
    try { prepared = await service.prepare(context); }
    catch { throw Error(`MCP service preparation unavailable: ${service.id}`); }
    if (service.context === 'code' && (!prepared.binding || prepared.binding.repo !== context.repo || prepared.binding.actualSha !== context.actualSha || typeof prepared.binding.location !== 'string' || !prepared.binding.location)) throw Error(`MCP trusted context mismatch: ${service.id}`);
    let hostPath: string;
    try {
      if (!isAbsolute(prepared.configFile)) throw Error('absolute path required');
      hostPath = await realpath(prepared.configFile);
      if (!(await stat(hostPath)).isFile()) throw Error('regular file required');
    } catch { throw Error(`MCP configuration unavailable: ${service.id}`); }
    const sandboxPath = `/orchestrator-mcp/${service.id}.json`;
    mounts.push({hostPath, sandboxPath});
    connections.push({service: service.id, configFile: sandboxPath, tools: reference.tools});
    // Persist only explicitly public descriptions and trusted binding, never native config or credentials.
    facts.push({service: service.id, tools: reference.tools, capabilities: service.capabilities, access: service.access, context: service.context, binding: prepared.binding && {repo:prepared.binding.repo,actualSha:prepared.binding.actualSha,location:prepared.binding.location}});
  }
  return {mounts, connections, facts};
}
