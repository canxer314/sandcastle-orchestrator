const commandHelp: Record<string, string> = {
  serve: `serve --data DIR --config FILE [--maintenance normal|paused|restore]
Start the control service explicitly; stdout emits ready JSON, stderr contains service logs.
--config executes trusted TypeScript. Keep config, data, application and checkouts separate.
--maintenance defaults to normal. Shutdown does not prove execution children stopped.
--human is not supported; the ready JSON/service log protocol is unchanged.
Example: sandcastle-orchestrator serve --data /srv/orchestrator-data --config /srv/orchestrator-config/config.ts`,
  submit: `submit --socket PATH --repo ID --capability ID --input JSON --source TEXT
[--deduplication-key KEY] [--scheduled-at ISO_TIMESTAMP]
Submit asynchronously. --input is inline JSON; scheduled-at is metadata, not a start timer.
Check accepted: rejection is a recorded JSON response with exit 0, not completion.
Example: sandcastle-orchestrator submit --socket /srv/orchestrator-data/control.sock --repo example --capability test-commit --input '"FULL_COMMIT_SHA"' --source manual`,
  show: `show ID | show --source SOURCE --deduplication-key KEY
[--data DIR | --socket PATH] [--offline] [--human | --json]
Read a request/execution, or ALL source/key matches including rejections, in record order.
Source/key JSON is always a list; no match is not permission to resend.
Example: sandcastle-orchestrator show --source manual --deduplication-key delivery-1 --data /srv/orchestrator-data --offline --human`,
  list: `list [--data DIR | --socket PATH] [--repo ID] [--status STATUS] [--source TEXT]
[--offline] [--human | --json]
List executions, optionally filtered by repository, status or source.
Example: sandcastle-orchestrator list --data /srv/orchestrator-data --offline --human`,
  logs: `logs ID [--data DIR | --socket PATH] [--attempt ID] [--call ID]
[--offline] [--human | --json]
Read retained stdout/stderr; defaults to the latest attempt. --call selects tool evidence.
Preserves missing, cleaned, incomplete and truncated evidence indicators.
Example: sandcastle-orchestrator logs EXECUTION_ID --data /srv/orchestrator-data --offline --human`,
  artifact: `artifact ID [--data DIR | --socket PATH] --name NAME [--attempt ID] [--call ID] [--offset BYTES]
[--human | --json]
Read an artifact online from the latest or selected attempt/tool call; offset is nonnegative bytes.
Example: sandcastle-orchestrator artifact EXECUTION_ID --data /srv/orchestrator-data --name report.txt --human`,
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
  pause: `pause --socket PATH --source TEXT --reason TEXT [--target all|admission|starts]
Pause admission and/or starts (default all). Existing executions are not stopped.
Example: sandcastle-orchestrator pause --socket /srv/orchestrator-data/control.sock --source operator --reason 'backup window'`,
  resume: `resume --socket PATH --source TEXT --reason TEXT [--target all|admission|starts]
Explicitly resume admission and/or starts (default all); restore requires review first.
Example: sandcastle-orchestrator resume --socket /srv/orchestrator-data/control.sock --source operator --reason 'review accepted'`,
  maintenance: `maintenance [--data DIR | --socket PATH] [--human | --json]
Query persisted admission/start pauses and restore-review state, online only.
Example: sandcastle-orchestrator maintenance --data /srv/orchestrator-data --human`,
  'restore-review': `restore-review --socket PATH --source TEXT --reason TEXT --backup-point TEXT
--handling TEXT --external-results TEXT
Record manual backup/side-effect review while admission and starts are paused. Does not resume.
Example: sandcastle-orchestrator restore-review --socket /srv/orchestrator-data/control.sock --source operator --reason 'audit compared' --backup-point '2026-10-11T00:00:00Z' --handling 'stale queue cancelled' --external-results 'host and remote audit checked'`,
};

export const commands = Object.keys(commandHelp);

export function help(command?: string): string {
  if (command) {
    if (!Object.hasOwn(commandHelp, command)) throw Error(`Unknown command: ${command}`);
    const queryHelp = ['show', 'list', 'logs', 'artifact', 'maintenance'].includes(command) ? `
Queries default to JSON, never switch by TTY; --human and --json are mutually exclusive.
Default data: ~/.sandcastle-orchestrator/data; default socket: selected data/control.sock.
Explicit --socket wins; if --data is also explicit, they must select the same physical socket.
Relative paths resolve from cwd. Queries do not load --config or start a service.
--offline conflicts with --socket and only supports show/list/logs, without initialization or writes.
Offline activity is unverified. Missing/unsupported records fail without repair; no init marker needed.
Human socket waits are bounded to 30 seconds; Ctrl+C exits 130 without cancelling execution.
Query success exits 0 even for failed/unknown business results; errors/timeouts exit 1.` : '';
    return `Usage: sandcastle-orchestrator ${commandHelp[command]}${queryHelp}\n\n-h, --help  Show help without loading configuration or connecting to a service.`;
  }
  return `Sandcastle orchestrator. Single-host fixed-commit execution and Unix socket management.
Usage: sandcastle-orchestrator COMMAND [OPTIONS]

Available commands:
${commands.map(name => `  ${name}`).join('\n')}

Start here: prepare a trusted external config, then explicitly run serve.
Example: sandcastle-orchestrator serve --data /srv/orchestrator-data --config /srv/orchestrator-config/config.ts
Use sandcastle-orchestrator COMMAND --help for options and examples.
Management commands default to JSON; errors go to stderr. Read queries accept --human.
Queries default to selected --data/control.sock (data defaults to ~/.sandcastle-orchestrator/data).
Writes still require --socket PATH. show/list/logs accept explicit --offline for read-only evidence.
-h, --help     Show help without configuration or a service.
-v, --version  Print only the installed package version.
init, doctor, demo, setup: unreleased; not available commands.
Linux and Node.js 24+ required. See docs/installation.md in the installed package.`;
}
