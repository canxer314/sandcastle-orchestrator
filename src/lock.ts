import { spawn } from 'node:child_process';

// flock releases the kernel lock even when the controller crashes. The lock
// file is never removed, avoiding races between different file inodes.
export async function acquireControlLock(path: string) {
  const child = spawn('flock', ['-n', '-E', '73', path, 'sh', '-c', 'printf "locked\\n"; cat >/dev/null']);
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => reject(new Error(code === 73 ? 'Control service already running' : 'Unable to acquire control lock')));
    child.stdout.once('data', () => resolve());
  });
  return () => child.stdin.end();
}
