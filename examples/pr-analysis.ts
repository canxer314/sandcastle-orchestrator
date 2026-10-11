import type { Configuration } from '../src/config.js';
import { createPrAnalysisRole, createPrSnapshotTool } from '../src/pr-analysis.js';

// Import this from your trusted deployment configuration. No models/containers are
// launched by importing the example. Bind your authorized provider and image there.
const scope={repo:'owner/example',pullRequests:[31,32]};
export const prAnalysis = {
  roles:[createPrAnalysisRole(scope)],
  tools:[createPrSnapshotTool({...scope,path:'/srv/authorized-evidence/prs.json'})],
} satisfies Pick<Configuration,'roles'|'tools'>;

// Deployment configuration example:
// ...prAnalysis,
// repos: [{id:'example',location:'/srv/repos/example'}],
// network:none is fail-closed and only works with a controlled offline provider.
// Real models require separately authorized, externally enforced model-endpoint-only
// egress; changing to an unrestricted bridge network is not an acceptable substitute.
// environments: [{id:'pr-readonly',docker:{image:'YOUR-PREDEPLOYED-IMAGE',network:'none'}}],
// providers: [{id:'authorized-model',agent:YOUR_PUBLIC_SANDCASTLE_PROVIDER}],
// roleBindings: [{role:'pr-analysis',provider:'authorized-model',environment:'pr-readonly',commit(input){return (input as {sha:string}).sha}}],
// capabilities: [], version: 'DEPLOYED-CONFIG-COMMIT'
