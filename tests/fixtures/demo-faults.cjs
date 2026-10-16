// Faults only at process/clock/HTTP boundaries; all submission/record/execution code stays real.
const child = process.argv[1]?.includes('demo-service.');
const mode = process.env.DEMO_TEST_FAULT;
if (child && mode) {
  const http = require('node:http');
  const end = http.ServerResponse.prototype.end;
  http.ServerResponse.prototype.end = function (body, ...args) {
    if (['lost-receipt', 'lost-no-match'].includes(mode) && typeof body === 'string' && body.startsWith('{') && body.includes('"accepted":true')) {
      this.destroy(); return this;
    }
    if (mode === 'lost-no-match' && typeof body === 'string' && body.startsWith('[{') && body.includes('"accepted":true')) return end.call(this, '[]', ...args);
    if (mode === 'query-stall' && body === '[]') return this;
    return end.call(this, body, ...args);
  };
  if (mode === 'no-ready') process.send = (_message, callback) => { callback?.(); return true; };
}
if (!child && process.argv.includes('demo')) {
  const realNow = Date.now;
  const realTimeout = global.setTimeout;
  let advance = 0;
  Date.now = () => realNow() + advance;
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = function (chunk, ...args) {
    const text = String(chunk);
    if ((mode === 'no-ready' || mode === 'query-stall') && text.includes('Demo: starting service')) {
      realTimeout(() => { advance += 30_001; }, 1500).unref();
    }
    if (mode === 'execution-timeout' && text.includes('Demo: execution ')) {
      realTimeout(() => { advance += 300_001; }, 400).unref();
    }
    if (mode === 'cleanup-timeout' && text.includes('Demo: checking stop evidence')) {
      realTimeout(() => { advance += 30_001; }, 400).unref();
    }
    return write(chunk, ...args);
  };
  // A stalled socket wait must also wake at the accelerated deadline.
  if (mode === 'query-stall') global.setTimeout = (fn, ms, ...args) => realTimeout(fn, ms > 10_000 ? 1500 : ms, ...args);
}
