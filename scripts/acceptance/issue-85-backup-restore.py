#!/usr/bin/env python3
"""Explicit real-Docker drill; use only with an authorized local candidate and host.
Usage: python3 scripts/acceptance/issue-85-backup-restore.py TGZ NEW_DIRECTORY
Requires Node/npm, Git, Docker with node:22.22-alpine, sqlite3 and GNU tar.
Keeps evidence on success/failure. Does not read private model connections.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

package = Path(sys.argv[1]).resolve(strict=True)
base = Path(sys.argv[2]).absolute()
base.mkdir(mode=0o700)  # Refuse reuse, including a prior incomplete drill.
os.umask(0o077)
for name in ['home', 'cwd', 'audit', 'inputs']:
    (base / name).mkdir()
env = {**os.environ, 'HOME': str(base / 'home')}
commands = []
services = []

def save(name, value):
    (base / name).write_text(json.dumps(value, indent=2) + '\n')

def run(argv, expected=0):
    record = {'argv': [str(a) for a in argv], 'state': 'started'}
    commands.append(record)
    save('commands.json', commands)
    try:
        result = subprocess.run(record['argv'], cwd=base / 'cwd', env=env,
                                capture_output=True, text=True, timeout=180)
    except (subprocess.TimeoutExpired, OSError) as error:
        record.update(state='failed', error=str(error))
        for name in ['stdout', 'stderr']:
            value = getattr(error, name, None)
            record[name] = value.decode(errors='replace') if isinstance(value, bytes) else value
        save('commands.json', commands)
        raise
    record.update(state='returned', exit=result.returncode, stdout=result.stdout, stderr=result.stderr)
    save('commands.json', commands)
    assert result.returncode == expected, f'Unexpected exit: {argv}; see commands.json'
    return result.stdout

def cli(*args):
    args = list(args)
    if '--data' in args:
        index = args.index('--data')
        args[index:index + 2] = ['--socket', Path(args[index + 1]) / 'control.sock']
    return json.loads(run([binary, *args]))

def manage(command, data, target='all'):
    return cli(command, '--data', data, '--target', target, '--source', 'issue-85',
               '--reason', 'authorized isolated backup restore drill')

def start(config, data, mode=None):
    argv = [str(binary), 'serve', '--config', str(config), '--data', str(data)]
    if mode:
        argv += ['--maintenance', mode]
    index = len(services)
    out = open(base / f'service-{index}.out', 'w')
    err = open(base / f'service-{index}.err', 'w')
    child = subprocess.Popen(argv, cwd=base / 'cwd', env=env, stdout=out, stderr=err)
    services.append((child, out, err))
    commands.append({'argv': argv, 'pid': child.pid})
    save('commands.json', commands)
    for _ in range(150):
        if '"ready":true' in (base / f'service-{index}.out').read_text():
            return child
        assert child.poll() is None, 'Service exited before ready'
        time.sleep(.1)
    raise AssertionError('No ready; see service logs')

def stop(child):
    child.terminate()
    child.wait(timeout=15)

def snapshot(directory):
    return {str(p.relative_to(directory)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(directory.rglob('*')) if p.is_file() and not p.is_symlink()
            and p.name not in ['control.sock', 'control.lock', 'records.sqlite',
                               'records.sqlite-wal', 'records.sqlite-shm']}

def submit(data, sha):
    result = cli('submit', '--data', data, '--repo', 'demo', '--capability', 'demo-test',
                 '--input', json.dumps(sha), '--source', 'issue-85-guide')
    assert result['accepted']
    return result['executionId']

def completed(data, execution):
    for _ in range(300):
        detail = cli('show', execution, '--data', data)
        if detail['execution']['status'] == 'completed':
            assert detail['attempts'][-1]['business']['passed']
            return detail
        assert detail['execution']['status'] not in ['unknown', 'start_failed']
        time.sleep(.1)
    raise AssertionError('Execution did not complete; inspect retained evidence')

try:
    prefix = base / 'prefix'
    run(['npm', 'install', '--global', '--prefix', prefix, '--omit=dev', '--no-audit',
         '--no-fund', '--offline', '--cache', Path.home() / '.npm', package])
    binary = prefix / 'bin/sandcastle-orchestrator'
    save('environment.json', {'package': str(package), 'sha256': hashlib.sha256(package.read_bytes()).hexdigest(),
         'version': run([binary, '--version']).strip(), 'node': run(['node', '--version']).strip(),
         'docker': run(['docker', 'version', '--format', '{{json .}}']),
         'image': run(['docker', 'image', 'inspect', 'node:22.22-alpine', '--format', '{{.Id}}']).strip(),
         'cwd': str(base / 'cwd'), 'home': env['HOME'], 'prefix': str(prefix)})
    cli('init', '--yes', '--json')
    root = base / 'home/.sandcastle-orchestrator'
    data, config_dir, repo = root / 'data', root / 'config', root / 'demo-repo'
    config = config_dir / 'config.ts'
    # Explicit fixture extension of generated init config: real logs plus one retained artifact.
    text = config.read_text().replace("['node', '--test', '/workspace/test.cjs']",
        "['sh', '-c', 'node --test /workspace/test.cjs && printf \\\"BACKUP_85\\\\n\\\" > /artifacts/report.txt']")
    text = text.replace('business: { passed:', "artifacts: ['report.txt'], business: { passed:")
    config.write_text(text)
    sha = run(['git', '-C', repo, 'rev-parse', 'HEAD']).strip()
    (repo / 'uncommitted.txt').write_text('preserve dirty working tree\n')
    (base / 'inputs/task.json').write_text(json.dumps({'sha': sha}))
    # setup only generates resources. No model execution, credentials or provider probe.
    settings = base / 'inputs/connection.json'
    settings.write_text('{"env":{"ANTHROPIC_BASE_URL":"https://example.invalid"}}')
    setup = cli('setup', '--project', repo, '--name', 'backup-guide', '--connection-settings',
                settings, '--question', 'Do not execute; retained setup input', '--yes', '--json')
    save('setup.json', setup)
    service = start(config, data)
    first = submit(data, sha)
    before = completed(data, first)
    logs = cli('logs', first, '--data', data)
    artifact = cli('artifact', first, '--data', data, '--name', 'report.txt')
    assert base64.b64decode(artifact['content']) == b'BACKUP_85\n'
    manage('pause', data, 'starts')
    stale = submit(data, sha)
    manage('pause', data)
    assert cli('maintenance', '--data', data)['startsPaused']
    assert cli('show', stale, '--data', data)['attempts'] == []
    cli('list', '--data', data)
    container = before['attempts'][-1]['container']
    assert run(['docker', 'inspect', container, '--format', '{{.State.Running}}']).strip() == 'false'
    stop(service)
    backup = base / 'backup'
    shell_env = {'DATA': data, 'CONFIG_DIR': config_dir, 'BACKUP': backup,
                 'INPUT_DIR': base / 'inputs', 'REPO_DIR': repo,
                 'SETUP_DIR': root / 'projects'}
    env.update({k: str(v) for k, v in shell_env.items()})
    run(['sh', '-eu', '-c', '''umask 077
mkdir -m 700 "$BACKUP"
date -u +%FT%TZ > "$BACKUP/backup-point.txt"
sqlite3 "$DATA/records.sqlite" ".backup '$BACKUP/records.sqlite'"
test "$(sqlite3 "$BACKUP/records.sqlite" 'PRAGMA integrity_check;')" = ok
tar --exclude=control.sock --exclude=control.lock --exclude=records.sqlite --exclude=records.sqlite-wal --exclude=records.sqlite-shm -C "$DATA" -cpf "$BACKUP/evidence.tar" .
tar -C "$CONFIG_DIR" -cpf "$BACKUP/config.tar" .
tar -C "$INPUT_DIR" -cpf "$BACKUP/inputs.tar" .
tar -C "$REPO_DIR" -cpf "$BACKUP/repository.tar" .
tar -C "$SETUP_DIR" -cpf "$BACKUP/setup.tar" .
date -u +%FT%TZ > "$BACKUP/backup-completed.txt"'''])
    originals = {key: snapshot(value) for key, value in shell_env.items() if key != 'BACKUP'}
    # Independent local audit after backup: original service executes only after explicit resume.
    service = start(config, data, 'paused')
    manage('resume', data)
    after_backup = completed(data, stale)
    (base / 'audit/post-backup.json').write_text(json.dumps(after_backup, indent=2))
    assert run(['docker', 'inspect', after_backup['attempts'][-1]['container'], '--format', '{{.State.Running}}']).strip() == 'false'
    stop(service)
    original_after = snapshot(root)
    database_after = hashlib.sha256((data / 'records.sqlite').read_bytes()).hexdigest()
    audit_after = snapshot(base / 'audit')
    restored = base / 'restored'
    restored.mkdir(mode=0o700)
    mapping = {'DATA': restored / 'data', 'CONFIG_DIR': restored / 'config',
               'INPUT_DIR': restored / 'inputs', 'REPO_DIR': restored / 'repo', 'SETUP_DIR': restored / 'projects'}
    for path in mapping.values():
        path.mkdir(mode=0o700)
    rd, rc = mapping['DATA'], mapping['CONFIG_DIR'] / 'config.ts'
    run(['cp', backup / 'records.sqlite', rd / 'records.sqlite'])
    for key, archive in [('DATA', 'evidence'), ('CONFIG_DIR', 'config'), ('INPUT_DIR', 'inputs'),
                         ('REPO_DIR', 'repository'), ('SETUP_DIR', 'setup')]:
        run(['tar', '-C', mapping[key], '-xpf', backup / (archive + '.tar')])
        assert snapshot(mapping[key]) == originals[key], key + ' byte mismatch'
    assert run(['sqlite3', rd / 'records.sqlite', 'PRAGMA integrity_check;']).strip() == 'ok'
    save('resource-map.json', {key: {'original': str(shell_env[key]), 'restored': str(value)} for key, value in mapping.items()})
    # Preserve byte-identical originals, then explicitly remap restored configuration/layout pointers.
    replacements = [(str(root / 'projects'), str(mapping['SETUP_DIR'])), (str(config_dir), str(mapping['CONFIG_DIR'])),
                    (str(data), str(rd)), (str(repo), str(mapping['REPO_DIR'])), (str(base / 'inputs'), str(mapping['INPUT_DIR']))]
    for directory in [mapping['CONFIG_DIR'], mapping['SETUP_DIR'], rd]:
        for p in directory.rglob('*'):
            if p.name not in ['config.ts', 'init.json']:
                continue
            value = p.read_text()
            for old, new in replacements:
                value = value.replace(old, new)
            p.write_text(value)
    restore_started = time.monotonic()
    service = start(rc, rd, 'restore')
    assert cli('show', first, '--data', rd) == before
    assert cli('logs', first, '--data', rd) == logs
    assert cli('artifact', first, '--data', rd, '--name', 'report.txt') == artifact
    assert cli('show', stale, '--data', rd)['attempts'] == []
    run([binary, 'resume', '--socket', rd / 'control.sock', '--source', 'issue-85',
         '--reason', 'test unaudited rejection'], expected=1)
    assert 'Restore review required before resume' in commands[-1]['stderr'], commands[-1]
    cli('cancel', stale, '--data', rd, '--source', 'issue-85', '--reason', 'independent audit proves completed after backup')
    cli('restore-review', '--data', rd, '--source', 'issue-85', '--reason', 'independent local audit compared',
        '--backup-point', (backup / 'backup-point.txt').read_text().strip(),
        '--handling', 'No running or unknown execution; stale queued request cancelled using post-backup audit',
        '--external-results', 'Only isolated Docker test and report artifact; post-backup execution independently stopped; no model or remote writes')
    assert cli('maintenance', '--data', rd)['startsPaused']
    manage('resume', rd)
    assert not cli('maintenance', '--data', rd)['startsPaused']
    assert cli('show', stale, '--data', rd)['execution']['status'] == 'cancelled'
    assert cli('show', stale, '--data', rd)['attempts'] == []
    assert len(cli('list', '--data', rd)) == 2
    stop(service)
    assert snapshot(root) == original_after, 'Restore changed original resources'
    assert hashlib.sha256((data / 'records.sqlite').read_bytes()).hexdigest() == database_after
    assert snapshot(base / 'audit') == audit_after
    assert (mapping['REPO_DIR'] / 'uncommitted.txt').read_text() == 'preserve dirty working tree\n'
    restore_seconds = time.monotonic() - restore_started
    # Installed CLI recovery commands, with a bounded Docker substitute (no real external work).
    recovery = base / 'controlled-recovery'
    recovery.mkdir()
    adapter = recovery / 'docker'
    adapter.write_text("#!/usr/bin/env python3\nimport os,sys,pathlib,json\np=pathlib.Path(__file__).parent\n"
        "if sys.argv[1]=='run':\n (p/'run-pid').write_text(str(os.getpid()))\n print('controlled completed process')\n"
        "elif sys.argv[1]=='inspect': print(json.dumps({'Running':not (p/'checked-stopped').exists(),'Status':'exited','ExitCode':0}))\n"
        "else: sys.exit(9)\n")
    adapter.chmod(0o700)
    recovery_config = recovery / 'config.ts'
    recovery_config.write_text(config.read_text().replace("image: 'node:22.22-alpine'",
        "image: 'controlled:recovery'").replace(
        "artifacts: ['report.txt'], ", ""))
    recovery_data = base / 'recovery-data'
    env['PATH'] = str(recovery) + os.pathsep + env['PATH']
    service = start(recovery_config, recovery_data)
    def unknown():
        execution = submit(recovery_data, sha)
        for _ in range(100):
            detail = cli('show', execution, '--data', recovery_data)
            if detail['execution']['status'] == 'unknown':
                break
            time.sleep(.1)
        assert detail['execution']['status'] == 'unknown'
        pid = int((recovery / 'run-pid').read_text())
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            pass
        else:
            raise AssertionError('Controlled entry process still exists; do not confirm stop')
        (recovery / 'checked-stopped').write_text('independent PID check: absent; adapter created no external work')
        return execution
    audit = ['--source', 'issue-85', '--handling', 'controlled adapter process independently absent',
             '--reason', 'isolated recovery drill', '--external-results', 'adapter performs no external writes']
    retry_id = unknown()
    confirmed = cli('confirm-stop', retry_id, '--data', recovery_data, *audit)
    assert confirmed['attempts'][-1]['stopConfirmation']['kind'] == 'manual'
    cli('retry', retry_id, '--data', recovery_data, *audit)
    retried = completed(recovery_data, retry_id)
    assert len(retried['attempts']) == 2
    (recovery / 'checked-stopped').unlink()
    resolve_id = unknown()
    cli('confirm-stop', resolve_id, '--data', recovery_data, *audit)
    resolved = cli('resolve', resolve_id, '--data', recovery_data, *audit)
    assert resolved['execution']['status'] == 'resolved'
    cleaned = cli('cleanup', '--data', recovery_data)
    assert cleaned == {'attempts': []}, 'Fresh evidence must remain within retention window'
    assert cli('logs', retry_id, '--data', recovery_data)['stdout'] == 'controlled completed process\n'
    save('controlled-recovery.json', {'retry': retried, 'resolve': resolved, 'cleanup': cleaned,
         'scope': 'controlled Docker substitute with actual process-exit check; not real container recovery'})
    stop(service)
    save('result.json', {'passed': True, 'firstExecution': first, 'postBackupExecution': stale,
         'sha': sha, 'restoreReviewSeconds': restore_seconds,
         'backupPoint': (backup / 'backup-point.txt').read_text().strip(),
         'originalsUnchangedDuringRestore': True, 'archiveBytesMatchedBeforeRemapping': True,
         'staleAttemptsAfterResume': 0, 'servicesExited': all(c.poll() is not None for c, _, _ in services),
         'scope': 'real local Docker and filesystem; no model, remote writes, offsite backup or RTO claim'})
    print(base)
finally:
    for child, out, err in services:
        if child.poll() is None:
            stop(child)  # Control service only; never claim this stops an execution.
        out.close()
        err.close()
    save('commands.json', commands)
