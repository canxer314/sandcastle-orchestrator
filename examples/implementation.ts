import {z} from 'zod';
import type {Configuration} from '../src/config.js';

// Merge into the administrator deployment configuration, supplying an authorized provider/image.
export const implementationRole:NonNullable<Configuration['roles']>[number]={
  id:'implementation',description:'Investigate an authorized Issue and propose a tested Draft PR',
  validate(input){z.object({sha:z.string().regex(/^[a-f0-9]{40}$/),issue:z.number().int().positive(),issueBody:z.string().min(1)}).strict().parse(input)},
  buildPrompt({input,repo,actualSha}){return `Work on ${repo} from ${actualSha}. Administrator-supplied Issue evidence: ${JSON.stringify(input)}. Investigate, edit and test autonomously. Use run_tests after changes. Publish only a tested revision with publish_draft(operation=publish,callId,title,body). Include the Issue reference in the body. Unknown publication: query the same callId, cite existing artifacts, never blindly publish again. Report limitations and evidence; a Draft PR does not prove resolution.`},
  skills:['Choose your own reproduction and repair steps. Keep testing and rework in this attempt. No merge, deployment, comments, Issues or settings changes.'],
  tools:['run_tests','publish_draft'],validateReport(output){return output},
};
export const implementationTools:NonNullable<Configuration['tools']>=[
  {id:'run_tests',description:'Capture current HEAD and dirty tree, then run isolated tests; preserve returned callId and revision evidence.',capability:'test-commit',inputSchema:z.object({}).strict()},
  {id:'publish_draft',description:'Publish one tested callId to the administrator target dedicated branch as a Draft PR, or query unknown effects. No arbitrary repo, branch, commands or credentials.',publication:true},
];
// repo.publication: {github:'AUTHORIZED_OWNER/TEST_REPO',remote:'https://github.com/AUTHORIZED_OWNER/TEST_REPO.git',base:'main',env:{GH_TOKEN:process.env.AUTHORIZED_TEST_GH_TOKEN!}}
// provider.mcp: 'claude-code'; roleBinding.workspace: 'implementation'.
// test-commit.execution.workspace: 'readonly'; its validate must accept {}.
// The trusted capability owns its test command; the role selects when to invoke it.
