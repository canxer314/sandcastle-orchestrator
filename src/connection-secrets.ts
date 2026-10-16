import { Transform } from 'node:stream';

// Filter before writing, including matches split across chunks. Unmatched binary bytes stay intact.
export function connectionSecrets(values: string[]) {
  const secrets = [...new Set(values.flatMap(value => {
    const json = JSON.stringify(value).slice(1, -1);
    return [value, json, JSON.stringify(json).slice(1, -1), encodeURIComponent(value)];
  }))].filter(Boolean).sort((a, b) => b.length - a.length);
  const redact = (text: string) => secrets.reduce((result, secret) => result.replaceAll(secret, '[REDACTED]'), text);
  const patterns = secrets.map(secret => Buffer.from(secret));
  const keep = Math.max(0, ...patterns.map(secret => secret.length - 1));
  const stream = () => {
    let pending = Buffer.alloc(0);
    const drain = (output: Transform, final: boolean) => {
      const limit = final ? pending.length : Math.max(0, pending.length - keep);
      let consumed = 0;
      while (consumed < limit) {
        let index = -1, length = 0;
        for (const pattern of patterns) {
          const found = pending.indexOf(pattern, consumed);
          if (found >= 0 && (index < 0 || found < index)) { index = found; length = pattern.length; }
        }
        if (index < 0 || index >= limit) break;
        output.push(pending.subarray(consumed, index)); output.push('[REDACTED]'); consumed = index + length;
      }
      if (consumed < limit) { output.push(pending.subarray(consumed, limit)); consumed = limit; }
      pending = pending.subarray(consumed);
    };
    return new Transform({
      transform(chunk: Buffer, _encoding, callback) { pending = Buffer.concat([pending, chunk]); drain(this, false); callback(); },
      flush(callback) { drain(this, true); callback(); },
    });
  };
  return {redact, stream};
}
