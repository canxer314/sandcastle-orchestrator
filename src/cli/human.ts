type Context = {id?: string; data?: string; socket?: string; offline: boolean; source?: string; deduplicationKey?: string};
const json = (value: unknown) => JSON.stringify(value, null, 2);
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;

export function queryCommand(command: string, context: Context, selectors: Record<string, string | undefined> = {}) {
  const target = context.id ? ` ${quote(context.id)}` : context.source !== undefined && context.deduplicationKey !== undefined ? ` --source ${quote(context.source)} --deduplication-key ${quote(context.deduplicationKey)}` : '';
  const options = Object.entries(selectors).filter(([, value]) => value !== undefined).map(([name, value]) => ` --${name} ${quote(value!)}`).join('');
  return `sandcastle-orchestrator ${command}${target}${context.data ? ` --data ${quote(context.data)}` : ''}${context.socket ? ` --socket ${quote(context.socket)}` : ''}${context.offline ? ' --offline' : ''} --human${options}`;
}

export function writeRecheck(command: string, context: Context) {
  return queryCommand(command === 'submit' || context.id ? 'show' : command === 'cleanup' ? 'list' : 'maintenance', context);
}

export function formatWrite(command: string, result: any, context: Context): string {
  if (command === 'submit') {
    const id = result.executionId ?? result.requestId;
    return [`Acceptance: ${result.accepted ? 'accepted' : 'rejected'}. Acceptance is not execution success.`,
      `Request: ${result.requestId}`, `Execution: ${result.executionId ?? 'none'}`,
      ...(result.reason !== undefined ? [`Reason: ${result.reason}`] : []),
      `Inspect: ${queryCommand('show', {...context, id})}`].join('\n');
  }
  const next = writeRecheck(command, context);
  return [`Operation: ${command}. Receipt confirmed; this is not execution success.`,
    ...(command === 'cancel' ? ['Cancellation request accepted; this does not prove execution stopped.'] : []),
    `Receipt:\n${json(result)}`, `Inspect: ${next}`].join('\n');
}

export function formatQuery(command: string, result: any, context: Context): string {
  const lines: string[] = [];
  if (context.offline) lines.push('Offline: persisted evidence only; current activity is unverified.');
  const next = (command: string, id: string, options = '') => `${queryCommand(command, {...context, id})}${options}`;
  const show = (detail: any) => {
    const request = detail.request;
    const execution = detail.execution;
    const id = String(execution?.id ?? request.id);
    lines.push(`Request: ${request.id}`, `Repository: ${request.repo}`, `Capability: ${request.capability}`, `Source: ${request.source}`);
    lines.push(`Acceptance: ${detail.accepted === false || request.rejection != null ? 'rejected' : execution || detail.accepted === true ? 'accepted' : 'not established'}`);
    if (request.rejection != null) lines.push(`Rejection: ${request.rejection}`);
    lines.push(`Execution: ${execution ? `${execution.id} (${execution.status})` : 'none'}`);
    if (execution) {
      const {id: _id, status: _status, ...management} = execution;
      if (Object.keys(management).length) lines.push(`Execution management: ${json(management)}`);
    }
    if (request.scheduledAt) lines.push(`Scheduled at: ${request.scheduledAt}`);
    if (request.deduplicationKey) lines.push(`Deduplication key: ${request.deduplicationKey}`);
    for (const attempt of detail.attempts ?? []) {
      lines.push(`Attempt: ${attempt.id} (${attempt.runState})`, `Actual SHA: ${attempt.actualSha ?? 'unavailable'}`);
      if (context.offline && ['starting', 'running'].includes(attempt.runState)) lines.push(`Activity: unverified (persisted ${attempt.runState})`);
      if (attempt.contract) lines.push(`Result contract: ${attempt.contract}`);
      if (Object.hasOwn(attempt, 'business')) lines.push(`Business result (raw):\n${json(attempt.business)}`);
      else if (attempt.businessReference) {
        lines.push(`Business result reference:\n${json(attempt.businessReference)}`);
        if (context.offline) lines.push('Artifact queries are online only. Inspect retained evidence manually; do not start a service just to view it.');
        else lines.push(`Read result: ${next('artifact', id, ` --attempt ${quote(String(attempt.id))} --name ${quote(String(attempt.businessReference.name))}`)}`);
      }
      else lines.push('Business result: unavailable');
      lines.push('Business success: not inferred from execution state or arbitrary result fields.');
      const gaps: string[] = [];
      if (!attempt.actualSha) gaps.push('actual SHA unavailable');
      if (attempt.logs?.complete !== true) gaps.push('logs incomplete');
      if (attempt.cleanup) gaps.push(`evidence cleanup: ${json(attempt.cleanup)}`);
      if (attempt.requiresAttention || attempt.runState === 'unknown' || attempt.persistenceError) gaps.push('attempt requires attention');
      if (gaps.length) lines.push(`Evidence gaps: ${gaps.join('; ')}`);
      for (const key of ['error', 'failure', 'exitCode', 'signal', 'contractError', 'report', 'reportPersistenceError', 'toolObservationError', 'persistedRunState', 'persistenceError', 'stopConfirmation', 'location', 'toolCalls', 'artifacts']) if (attempt[key] !== undefined) lines.push(`${key}: ${json(attempt[key])}`);
      lines.push(`Read logs: ${next('logs', id, ` --attempt ${quote(String(attempt.id))}`)}`);
    }
    if (!detail.attempts?.length) lines.push('Attempt: none; execution has not established an actual attempt.');
    lines.push(`Inspect: ${next('show', id)}`);
  };
  if (command === 'show') {
    for (const detail of Array.isArray(result) ? result : [result]) show(detail);
    if (Array.isArray(result) && !result.length) lines.push('No matching requests have been found yet. This does not prove it is safe to resend.', `Recheck: ${queryCommand('show', context)}`);
  } else if (command === 'list') {
    lines.push('ID\tREPO\tSTATUS\tWARNINGS');
    for (const detail of result) {
      const warnings: string[] = [];
      if (detail.execution?.status === 'pending-review') warnings.push('pending-review');
      if (detail.request.rejection) warnings.push(`rejected: ${detail.request.rejection}`);
      for (const attempt of detail.attempts ?? []) {
        if (attempt.requiresAttention || attempt.runState === 'unknown' || attempt.persistenceError) warnings.push('attempt requires attention');
        if (context.offline && ['starting', 'running'].includes(attempt.runState)) warnings.push(`persisted ${attempt.runState}; activity unverified`);
        if (attempt.cleanup) warnings.push('evidence cleaned or cleanup incomplete');
      }
      lines.push(`${detail.execution?.id ?? detail.request.id}\t${detail.request.repo}\t${detail.execution?.status ?? 'not accepted'}\t${[...new Set(warnings)].join('; ') || '-'}`);
    }
    if (!result.length) lines.push('No matching executions.');
  } else if (command === 'logs') {
    lines.push(`Attempt: ${result.attemptId}`, `Call: ${result.callId ?? 'attempt (no tool call selected)'}`, `Actual SHA: ${result.actualSha ?? 'unavailable'}`, `Availability: ${result.availability}`, `Complete: ${result.complete === true}`, `Truncated: ${json(result.truncated)}`);
    if (result.cleanup) lines.push(`Cleanup: ${json(result.cleanup)}`);
    for (const stream of ['stdout', 'stderr']) lines.push(result[stream] === null || result[stream] === undefined ? `${stream}: missing` : `${stream}:\n${result[stream]}`);
  } else if (command === 'artifact') {
    const {content, ...metadata} = result;
    lines.push(`Attempt: ${result.attemptId}`, `Call: ${result.callId ?? 'attempt (no tool call selected)'}`, `Artifact metadata:\n${json(metadata)}`, content === null || content === undefined ? 'Content: missing (see availability and cleanup metadata)' : `Content (${result.encoding}):\n${content}`);
  } else if (command === 'maintenance') {
    lines.push('Maintenance (read-only snapshot)', `Admission: ${result.admissionPaused ? 'paused' : 'not paused'}`, `Execution starts: ${result.startsPaused ? 'paused' : 'not paused'}`, `Persisted maintenance state:\n${json(result)}`);
  } else lines.push(json(result));
  return lines.join('\n');
}
