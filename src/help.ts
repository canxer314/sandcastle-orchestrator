const commandHelp: Record<string, string> = {
  serve: `serve --data DIR --config FILE [--maintenance normal|paused|restore]
Start the control service explicitly; stdout emits ready JSON, stderr contains service logs.
--config executes trusted TypeScript. Keep config, data, application and checkouts separate.
--maintenance defaults to normal. Shutdown does not prove execution children stopped.
Example: sandcastle-orchestrator serve --data /srv/orchestrator-data --config /srv/orchestrator-config/config.ts`,
  submit: `submit --socket PATH --repo ID --capability ID --input JSON --source TEXT
[--deduplication-key KEY] [--scheduled-at ISO_TIMESTAMP]
Submit asynchronously. --input is inline JSON; scheduled-at is metadata, not a start timer.
Check accepted: rejection is a recorded JSON response with exit 0, not completion.
Example: sandcastle-orchestrator submit --socket /srv/orchestrator-data/control.sock --repo example --capability test-commit --input '"FULL_COMMIT_SHA"' --source manual`,
  show: `show ID --socket PATH
Read a request or execution, including attempts and persisted status.
Example: sandcastle-orchestrator show EXECUTION_ID --socket /srv/orchestrator-data/control.sock`,
  list: `list --socket PATH [--repo ID] [--status STATUS] [--source TEXT]
List executions, optionally filtered by repository, status or source.
Example: sandcastle-orchestrator list --socket /srv/orchestrator-data/control.sock --status queued`,
  logs: `logs ID --socket PATH [--attempt ID] [--call ID]
Read retained stdout/stderr; defaults to the latest attempt. --call selects tool evidence.
Example: sandcastle-orchestrator logs EXECUTION_ID --socket /srv/orchestrator-data/control.sock`,
  artifact: `artifact ID --socket PATH --name NAME [--attempt ID] [--call ID] [--offset BYTES]
Read an artifact from the latest or selected attempt/tool call; offset is nonnegative bytes.
Example: sandcastle-orchestrator artifact EXECUTION_ID --socket /srv/orchestrator-data/control.sock --name report.txt`,
  cancel: `cancel ID --socket PATH --reason TEXT [--attempt ID]
[--source TEXT] [--handling TEXT] [--external-results TEXT]
Request cooperative cancellation. A receipt is not proof that execution stopped.
Example: sandcastle-orchestrator cancel EXECUTION_ID --socket /srv/orchestrator-data/control.sock --reason 'operator requested stop'`,
  'confirm-stop': `confirm-stop ID --socket PATH --reason TEXT --source TEXT --handling TEXT
[--attempt ID] [--call ID] [--external-results TEXT]
Record an operator's independently verified stop evidence; does not stop a process.
Example: sandcastle-orchestrator confirm-stop EXECUTION_ID --socket /srv/orchestrator-data/control.sock --source operator --reason 'checked host' --handling 'container and harness confirmed stopped'`,
  resolve: `resolve ID --socket PATH --reason TEXT --source TEXT --handling TEXT
[--attempt ID] [--external-results TEXT]
Resolve an uncertain attempt only after independent stop and side-effect review.
Example: sandcastle-orchestrator resolve EXECUTION_ID --socket /srv/orchestrator-data/control.sock --source operator --reason 'review complete' --handling 'stopped; side effects reconciled'`,
  retry: `retry ID --socket PATH --reason TEXT --source TEXT --handling TEXT
[--attempt ID] [--external-results TEXT]
Explicitly create a replacement execution after required stop/side-effect review.
Example: sandcastle-orchestrator retry EXECUTION_ID --socket /srv/orchestrator-data/control.sock --source operator --reason 'safe to repeat' --handling 'prior attempt stopped; side effects reconciled'`,
  cleanup: `cleanup --socket PATH
Apply existing retention rules to eligible terminal evidence, not active or uncertain work.
Example: sandcastle-orchestrator cleanup --socket /srv/orchestrator-data/control.sock`,
  maintenance: `maintenance --socket PATH
Query persisted admission/start pauses and restore-review state.
Example: sandcastle-orchestrator maintenance --socket /srv/orchestrator-data/control.sock`,
  pause: `pause --socket PATH --source TEXT --reason TEXT [--target all|admission|starts]
Pause admission and/or starts (default all). Existing executions are not stopped.
Example: sandcastle-orchestrator pause --socket /srv/orchestrator-data/control.sock --source operator --reason 'backup window'`,
  resume: `resume --socket PATH --source TEXT --reason TEXT [--target all|admission|starts]
Explicitly resume admission and/or starts (default all); restore requires review first.
Example: sandcastle-orchestrator resume --socket /srv/orchestrator-data/control.sock --source operator --reason 'review accepted'`,
  'restore-review': `restore-review --socket PATH --source TEXT --reason TEXT --backup-point TEXT
--handling TEXT --external-results TEXT
Record manual backup/side-effect review while admission and starts are paused. Does not resume.
Example: sandcastle-orchestrator restore-review --socket /srv/orchestrator-data/control.sock --source operator --reason 'audit compared' --backup-point '2026-10-11T00:00:00Z' --handling 'stale queue cancelled' --external-results 'host and remote audit checked'`,
};

export function help(command?: string): string {
  if (command) {
    if (!Object.hasOwn(commandHelp, command)) throw Error(`Unknown command: ${command}`);
    return `Usage: sandcastle-orchestrator ${commandHelp[command]}\n\n-h, --help  Show help without loading configuration or connecting to a service.`;
  }
  return `Sandcastle orchestrator. Single-host fixed-commit execution and Unix socket management.
Usage: sandcastle-orchestrator COMMAND [OPTIONS]

Available commands:
${Object.keys(commandHelp).map(name => `  ${name}`).join('\n')}

Start here: prepare a trusted external config, then explicitly run serve.
Example: sandcastle-orchestrator serve --data /srv/orchestrator-data --config /srv/orchestrator-config/config.ts
Use sandcastle-orchestrator COMMAND --help for options and examples.
Management commands require --socket PATH and default to JSON; errors go to stderr.
-h, --help     Show help without configuration or a service.
-v, --version  Print only the installed package version.
init, doctor, demo, setup: unreleased; not available commands.
Linux and Node.js 24+ required. See docs/installation.md in the installed package.`;
}
