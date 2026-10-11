// External substitutes for the acceptance command; never loads orchestrator internals.
const cp = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const state = process.env.ACCEPTANCE_STATE;
const feedback = { outcome: 'success', summary: 'readonly lighthouse feedback', nonce: 'controlled-nonce', logs: { readable: false }, remoteStopped: null };
const originalRead = fs.readFileSync;
fs.readFileSync = function (file, ...args) {
  if (file === '/home/canxer/.claude/settings.json') return JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'controlled-not-real' } });
  return originalRead.call(this, file, ...args);
};
const originalExec = cp.execFileSync;
cp.execFileSync = function (command, args, ...rest) {
  if (command !== 'docker') return originalExec.call(this, command, args, ...rest);
  if (args[0] === 'image') return 'sha256:0bb6dcc78a58bcded4f7da20771bcdb8edb1c65048e9bc7e383d8c4e668bd193';
  if (args[0] === 'network') return 'true 10.231.19.0/28 10.231.19.1';
  if (args[0] === 'top') {
    fs.appendFileSync(path.join(state, 'queries'), 'top\n');
    if (process.env.ACCEPTANCE_PROCESSES === 'query-failed') throw Error('Controlled process query failure');
    return process.env.ACCEPTANCE_PROCESSES === 'active' ? 'PID COMMAND\n123 node\n' : 'PID COMMAND\n123 sleep\n';
  }
  if (args[0] === 'stop') { fs.writeFileSync(path.join(state, 'stopped'), 'container'); return ''; }
  if (args[0] === 'inspect') {
    if (args[3].includes('ReadonlyRootfs')) return 'true';
    if (args[3].includes('Mounts')) return JSON.stringify([{ RW: false, Destination: '/orchestrator-mcp/readonly.json' }]);
    if (args[3].includes('Config.User')) return `${process.getuid()}:${process.getgid()}`;
  }
  if (args[0] === 'exec' && args.includes('rev-parse')) return fs.readFileSync(path.join(state, 'sha'), 'utf8');
  if (args[0] === 'exec' && args.includes('cat')) return ['initialize', 'tools/list', 'tools/call'].map(method => JSON.stringify({ method, ...(method === 'tools/call' ? { feedback } : {}) })).join('\n');
  throw Error('Unexpected controlled Docker command');
};
const originalSpawn = cp.spawn;
cp.spawn = function (command, args, options) {
  if (!args.includes('src/cli.ts')) return originalSpawn.call(this, command, args, options);
  if (args.includes('serve')) {
    const config = fs.readFileSync(args[args.indexOf('--config') + 1], 'utf8');
    fs.writeFileSync(path.join(state, 'sha'), config.match(/return "([a-f0-9]{40})"/)[1]);
    const child = originalSpawn(process.execPath, ['-e', `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(path.join(state, 'control'))},String(process.pid)); process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(path.join(state, 'control-stopped'))},'yes');process.exit(0)});setInterval(()=>{},1000)`], options);
    fs.writeFileSync(path.join(state, 'pid'), String(child.pid));
    return child;
  }
  const operation = args[3];
  if (operation === 'submit' && process.env.ACCEPTANCE_PROCESSES === 'submit-response-failed') {
    // The external service accepted work, but its CLI response is lost/nonzero.
    fs.writeFileSync(path.join(state, 'accepted'), 'controlled-container');
    return originalSpawn(process.execPath, ['-e', 'process.exit(1)'], options);
  }
  const result = operation === 'submit' ? { accepted: true, executionId: 'controlled-execution' } : operation === 'show' ? { attempts: [{ id: 'controlled-attempt', container: 'controlled-container', stopConfirmation: { kind: 'agent-exit-marker' }, exitCode: 0, contract: 'valid', output: JSON.stringify(feedback) }] } : [];
  return originalSpawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(result))})`], options);
};
const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  if (args[0] !== 15721 || args[1] !== '10.231.19.1') return originalListen.apply(this, args);
  this.once('listening', () => fs.writeFileSync(path.join(state, 'relay'), String(this.address().port)));
  return originalListen.call(this, 0, '127.0.0.1');
};
syncBuiltinESMExports();
