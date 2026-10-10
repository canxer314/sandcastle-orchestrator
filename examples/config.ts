import type { Configuration } from '../src/config.js';

export default {
  // Replace with the deployed configuration repository's commit.
  version: 'replace-with-config-commit',
  repos: [{ id: 'example', location: '/srv/repos/example' }],
  environments: [{ id: 'test-only' }],
  capabilities: [{
    id: 'test-commit',
    environment: 'test-only',
    validate(input: unknown) {
      if (typeof input !== 'string' || !input.trim()) throw new Error('Expected a commit reference as text');
      return input;
    },
    async run() {
      throw new Error('Execution is not implemented yet');
    },
  }],
} satisfies Configuration;
