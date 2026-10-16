const commandHelp: Record<string, string> = {
  demo: `demo [--config FILE] [--data DIR] [--demo-repo DIR] [--human | --json]
Run one deterministic Docker test at the current full committed HEAD through an owned control service.
Uses init resources; dirty changes are excluded with a warning. Never pulls images or calls models.
Refuses occupied data and unresolved/queued work. Keeps records, attempt logs and a separate service log.
Waits: startup 30s, execution 5m, cancellation and shutdown together 30s. No automatic retry.
First Ctrl+C requests cancellation and checks stopping; second exits waiting, possibly unknown.
Exit: passed and safely closed 0; test/runtime failure 1; uncertain acceptance/result/stop 2; safe interrupt 130.
Default readable output; --json keeps diagnostics on stderr. Explicit paths must match init.json.
Example: sandcastle-orchestrator demo --data ~/.sandcastle-orchestrator/data`,
  setup: `setup [--project DIR] [--name ID] [--question TEXT] [--image IMAGE] [--model MODEL]
[--reuse-local-claude | --connection-settings FILE | --connection-environment]
[--config NEW_FILE] [--data NEW_DIR] [--input-path NEW_FILE] [--reference-only]
[--yes] [--non-interactive] [--human | --json]
Prepare an independent read-only repository question at the full committed HEAD, never execute it.
Defaults to readable interactive output; JSON/non-TTY/non-interactive require --yes and connection selection.
--yes confirms file writes only, never local connection reuse. Setup records sources, not credentials.
--reuse-local-claude explicitly selects CLAUDE_CONFIG_DIR/settings.json or ~/.claude/settings.json.
Independent settings or service environment use the existing execution-time connection projection.
Omit --model to inherit; no backend/model is forced. No /login credential migration.
HTTP loopback uses existing execution bridge facilities only in supported environments; setup does not probe it.
Paths must be new and physically separate from application/project/demo; existing resources are not overwritten.
--reference-only creates reference files for manual merge, never loads/rewrites config or creates/modifies data.
Dirty changes are excluded; no clone/fetch/commit/branch switch, Docker, model, service or submit is run.
Default image: sandcastle-orchestrator-claude:2.1.296. Build/preparation and acceptance limits: docs/setup.md.
Example: sandcastle-orchestrator setup --project /srv/project --connection-environment --yes --json`,
  serve: `serve --data DIR --config FILE [--maintenance normal|paused|restore]
Start the control service explicitly; stdout emits ready JSON, stderr contains service logs.
--config executes trusted TypeScript. Keep config, data, application and checkouts separate.
--maintenance defaults to normal. Shutdown does not prove execution children stopped.
--human is not supported; the ready JSON/service log protocol is unchanged.
Example: sandcastle-orchestrator serve --data /srv/orchestrator-data --config /srv/orchestrator-config/config.ts`,
  submit: `submit --repo ID --capability ID --source TEXT
(--input JSON | --input-file PATH | --input-file -) [--data DIR | --socket PATH]
[--human | --json] [--deduplication-key KEY] [--scheduled-at ISO_TIMESTAMP]
Submit asynchronously, reporting acceptance only, not execution success.
--input-file reads JSON from a file, or stdin with -. Inputs are mutually exclusive; never executed.
Repo is a configured ID, not a checkout path; capability may name a role; source is not authentication.
Human mode generates a missing key and writes source/key/recheck to stderr BEFORE sending.
Explicit keys are unchanged; JSON never generates a key. scheduled-at is metadata, not a timer.
Example: sandcastle-orchestrator submit --data /srv/orchestrator-data --repo example --capability test-commit --input-file input.json --source manual --human`,
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
  init: `init [--config FILE] [--data DIR] [--demo-repo DIR] [--reset-demo] [--yes] [--human | --json]
Create separate demo configuration (explicit ESM, new template requires .ts or .mts), runtime data and a committed deterministic Git repo.
Defaults: ~/.sandcastle-orchestrator/{config/config.ts,data,demo-repo}. Relative paths use cwd.
Displays creation paths before confirmation. Noninteractive and JSON writes require --yes.
Complete resources are reused without writing; conflicts/incomplete resources are preserved, never repaired.
--reset-demo discards demo repository modifications after confirmation; retains config, data, records and logs.
Reset refuses occupied data, unfinished executions and unresolved demo journals. JSON/noninteractive reset needs --yes.
--yes only skips confirmation, never path/configuration protection.
No dependencies are installed, images pulled, services started or models called.
Example: sandcastle-orchestrator init --yes`,
  doctor: `doctor [--config FILE] [--data DIR] [--demo-repo DIR] [--human | --json]
Check Linux, Node.js 24+, Git, Docker daemon, flock, images and selected resources, even before init.
Defaults: ~/.sandcastle-orchestrator/{config/config.ts,data,demo-repo}. Relative paths use cwd.
An existing data/init.json locates resources; explicit paths must match physically (symlinks accepted).
Displays trusted config before loading it: TypeScript loading executes host code and is not side-effect-free.
Checks never install/fix dependencies, pull images, authenticate remotely or call a model.
Image presence does not verify credentials or test success. Run demo explicitly after checks pass.
Example: sandcastle-orchestrator doctor --data ~/.sandcastle-orchestrator/data`,
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
    const writeHelp = !['setup', 'init', 'doctor', 'demo', 'serve', 'show', 'list', 'logs', 'artifact', 'maintenance'].includes(command) ? `
Writes default to JSON, never switch by TTY. --human and --json are mutually exclusive.
New modes/options accept --data DIR or --socket PATH; default data: ~/.sandcastle-orchestrator/data.
Default socket: selected data/control.sock. Explicit data/socket must identify the same physical socket.
Relative paths resolve from cwd. No config is loaded and no service is started by a write client.
Legacy calls without new options still require --socket and retain argument tolerance and exit codes.
--offline is read-only and is rejected for writes. New modes/options reject irrelevant/extra arguments.
Human waits stop after 30 seconds, only on the client. Never automatically resend.
Human exit codes: confirmed receipt 0, rejection/ordinary error 1, sent but unconfirmed 2.
Ctrl+C only interrupts waiting, not the operation: unconfirmed sent writes exit 2, otherwise 130.
Check the displayed read-only command before any manual retry; missing records are not permission to resend.
JSON retains legacy waits and accepted:false exit 0; diagnostics/progress stay on stderr.` : '';
    return `Usage: sandcastle-orchestrator ${commandHelp[command]}${queryHelp}${writeHelp}\n\n-h, --help  Show help without loading configuration or connecting to a service.`;
  }
  return `Sandcastle orchestrator. Single-host fixed-commit execution and Unix socket management.
Usage: sandcastle-orchestrator COMMAND [OPTIONS]

Available commands:
${commands.map(name => `  ${name}`).join('\n')}

Start here: init creates independent demo resources; doctor checks prerequisites without running a test.
Example: sandcastle-orchestrator init
Then: sandcastle-orchestrator doctor
Existing custom deployments can explicitly run serve with --config FILE --data DIR.
Use sandcastle-orchestrator COMMAND --help for options and examples.
Management commands default to JSON; errors go to stderr. Use explicit --human for readable queries/writes.
New modes/options select --data/control.sock (data defaults to ~/.sandcastle-orchestrator/data), or --socket.
Legacy writes without new options still require --socket PATH. show/list/logs accept read-only --offline.
-h, --help     Show help without configuration or a service.
-v, --version  Print only the installed package version.
Run demo after doctor to test the committed demo repository. Use setup explicitly for a read-only project entry.
Linux and Node.js 24+ required. See docs/installation.md in the installed package.`;
}
