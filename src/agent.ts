import { randomBytes } from 'node:crypto';
import type { AgentProvider, Sandbox } from '@ai-hero/sandcastle';

// Public provider seam: Sandbox.run resolving does not prove the agent CLI exited.
export async function runAgent(sandbox: Sandbox, provider: AgentProvider, prompt: string, onExit?: () => void) {
  const marker = `ORCH_EXIT_${randomBytes(24).toString('hex')}`;
  let exitCode: number | null = null;
  let output='';let sessionId:string | undefined;
  const agent: AgentProvider = {
    ...provider,
    buildPrintCommand(options) {
      const original = provider.buildPrintCommand(options);
      return {...original, command:`( ${original.command}\n); sc_exit=$?; printf '\\n${marker}:%s\\n' "$sc_exit"; exit "$sc_exit"`};
    },
    parseStreamLine(line) {
      const match = line.match(new RegExp(`^${marker}:([0-9]{1,3})$`));
      if (match && Number(match[1]) <= 255) { exitCode = Number(match[1]); onExit?.(); return []; }
      const events=provider.parseStreamLine(line);
      for(const event of events) {
        if(event.type==='text')output+=event.text;
        else if(event.type==='result')output=event.result;
        else if(event.type==='session_id')sessionId=event.sessionId;
      }
      return events;
    },
  };
  try {
    const result = await sandbox.run({agent,prompt,completionSignal:[],idleTimeoutSeconds:Infinity,completionTimeoutSeconds:Infinity});
    return {exitCode,output:result.stdout,iterations:result.iterations,commits:result.commits};
  } catch (error) {
    return {exitCode,output:output || null,iterations:sessionId?[{sessionId}]:[],commits:[],error:'Agent execution or SDK postprocessing failed'};
  }
}
