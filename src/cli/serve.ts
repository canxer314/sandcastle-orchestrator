import { serve } from '../control.js';
import { serviceLog } from '../service-log.js';
import { required, type Values } from './arguments.js';

export async function runService(values: Values) {
  process.on('uncaughtException', error => {
    serviceLog('service_crash', error);
    process.exit(1); // Do not continue after an uncaught fault or claim children stopped.
  });
  await serve(required(values, 'data'), required(values, 'config'), values.maintenance);
}
