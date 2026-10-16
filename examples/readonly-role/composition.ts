import { configureClaudeMcp, type Configuration } from '@canxer314/sandcastle-orchestrator';
import { z } from 'zod';
import config from './config.js';

const shaSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const listRoot: Configuration['capabilities'][number] = {
  id: 'list-root',
  environment: 'question-environment',
  validate(input) { z.union([shaSchema, z.object({}).strict()]).parse(input); },
  execution: { workspace: 'readonly', commit(input) { return shaSchema.parse(input); } },
  async run(context) {
    const result = await context.exec(['node', '-e',
      'console.log(JSON.stringify(require("node:fs").readdirSync("/workspace").sort()))',
    ]);
    if (result.exitCode !== 0) throw Error('Root listing failed; inspect capability logs');
    const entries = z.array(z.string()).parse(JSON.parse(result.stdout));
    return { business: { actualSha: context.actualSha, entries } };
  },
};

// Optional composition: independently submit list-root, or let the role call it.
config.capabilities.push(listRoot);
config.tools = [{
  id: 'list_root',
  description: 'List root entries at this attempt fixed SHA. Call list_root with {}. This is a directory observation, not test evidence.',
  capability: listRoot.id,
  inputSchema: z.object({}).strict(),
}];
config.roles![0]!.tools = ['list_root'];
config.providers![0]!.mcp = 'claude-code';
config.providers![0]!.configureMcp = configureClaudeMcp;

export default config;
