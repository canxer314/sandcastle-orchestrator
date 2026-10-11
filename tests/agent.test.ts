import { expect, test } from 'vitest';
import type { AgentProvider, Sandbox, SandboxRunOptions } from '@ai-hero/sandcastle';
import { runAgent } from '../src/agent.js';
test('public Sandcastle adapter preserves stdin, disables idle/completion termination and requires actual exit evidence', async()=>{
  let options:SandboxRunOptions | undefined;
  const agent:AgentProvider={name:'controlled',env:{},captureSessions:false,buildPrintCommand:()=>({command:'agent',stdin:'large input'}),parseStreamLine:line=>[{type:'result',result:line}]};
  const sandbox={run:async (value:SandboxRunOptions)=>{options=value;const cmd=value.agent.buildPrintCommand({prompt:'report',dangerouslySkipPermissions:false});expect(cmd.stdin).toBe('large input');const marker=cmd.command.match(/ORCH_EXIT_[a-f0-9]+/)![0];value.agent.parseStreamLine(`${marker}:7`);return {stdout:'{"summary":"tests failed"}',iterations:[],commits:[]}}} as unknown as Sandbox;
  expect(await runAgent(sandbox,agent,'report')).toMatchObject({exitCode:7,output:'{"summary":"tests failed"}'});
  expect(options).toMatchObject({idleTimeoutSeconds:Infinity,completionTimeoutSeconds:Infinity,completionSignal:[]});
  const missing={run:async(options:SandboxRunOptions)=>{options.agent.parseStreamLine('partial report');throw Error('nonzero exit')}} as unknown as Sandbox;
  expect(await runAgent(missing,agent,'report')).toMatchObject({exitCode:null,output:'partial report'});
});
