// Private child entrypoint: ownership is the parent's child handle and IPC ready handshake.
import { serve } from '../control.js';
import { assertDemoIdle } from './demo-safety.js';
import { serviceLog } from '../service-log.js';

const [data, config, runId] = process.argv.slice(2);
console.error(JSON.stringify({event:'demo_service', runId, pid:process.pid, data}));
process.on('uncaughtException', error => { serviceLog('service_crash', error); process.exit(1); });
let stopping = false;
const stopDuringStartup = () => { stopping = true; };
process.on('SIGTERM', stopDuringStartup);
try {
  await serve(data, config, 'normal', {
    beforeStart: async () => {
      await assertDemoIdle(data, runId);
      if (stopping) throw Error('Demo startup interrupted');
    },
    ready: () => {
      process.removeListener('SIGTERM', stopDuringStartup);
      process.send?.({ready:true, runId}, () => { if (process.connected) process.disconnect(); });
      if (stopping) process.kill(process.pid, 'SIGTERM');
    },
  });
} catch (error) {
  serviceLog('service_failure', error);
  process.exitCode = 1;
  if (process.connected) process.disconnect();
}
