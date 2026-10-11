import type { Configuration } from '../src/config.js';

export default {
  // Replace with the deployed configuration repository's commit.
  version: 'replace-with-config-commit',
  repos: [{ id: 'example', location: '/srv/repos/example' }],
  environments: [{ id: 'test-only', docker: { image: 'node:22.22-alpine' } }],
  capabilities: [{
    id: 'test-commit',
    environment: 'test-only',
    validate(input: unknown) {
      if (typeof input !== 'string' || !/^[a-f0-9]{40}$/.test(input)) throw new Error('Expected a full commit SHA');
    },
    execution: { commit(input: unknown) { return input as string; } },
    async run(context) {
      const result = await context.exec(['sh', '/workspace/test.sh']);
      return { business: { passed: result.exitCode === 0, exitCode: result.exitCode } };
    },
  }],
} satisfies Configuration;
