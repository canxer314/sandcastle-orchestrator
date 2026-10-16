// Controlled CLI fixture, not Claude Code. Calls only the test-owned local endpoint.
const args = process.argv.slice(2);
const env = process.env;
const endpoint = new URL(env.ANTHROPIC_BASE_URL!);
if (endpoint.hostname === 'container.fixture') endpoint.hostname = '127.0.0.1';
const response = await (endpoint.hostname === '127.0.0.2' ? async (url: string, options: RequestInit) => {
  const {request} = await import('node:http');
  return new Promise<{text(): Promise<string>}>((resolve, reject) => {
    const req = request(url, {method: options.method, headers: options.headers as Record<string, string>, localAddress: '127.0.0.3'}, res => {
      let body = ''; res.on('data', chunk => {body += chunk;}); res.on('end', () => resolve({text: async () => body}));
    });
    req.on('error', reject); req.end(options.body);
  });
} : fetch)(`${endpoint.href.replace(/\/$/, '')}/report`, {
  method: 'POST',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify({
    modelArgument: args.includes('--model') ? args[args.indexOf('--model') + 1] : null,
    settingSources: args.includes('--setting-sources') ? args[args.indexOf('--setting-sources') + 1] : null,
    model: env.ANTHROPIC_MODEL,
    sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    token: env.ANTHROPIC_AUTH_TOKEN,
    key: env.ANTHROPIC_API_KEY || undefined,
    headers: env.ANTHROPIC_CUSTOM_HEADERS || undefined,
    unrelated: env.ANTHROPIC_NOT_A_CONNECTION_FIELD || undefined,
    home: env.HOME,
    endpoint: env.ANTHROPIC_BASE_URL,
  }),
});
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
if (!prompt.includes('Inspect')) throw Error('Missing role prompt');
if (env.ORCHESTRATOR_TOOL_SOCKET) {
  const {request} = await import('node:http');
  await new Promise<void>((resolve, reject) => {
    const req = request({socketPath: env.ORCHESTRATOR_TOOL_SOCKET, method: 'POST'}, res => {res.resume();res.on('end', resolve);});
    req.on('error', reject);req.end(JSON.stringify({tool:'inspect',input:{token:env.ANTHROPIC_AUTH_TOKEN}}));
  });
}
process.stdout.write(JSON.stringify({type: 'system', subtype: 'init', session_id: 'controlled-session'}) + '\n');
process.stdout.write(JSON.stringify({type: 'result', result: await response.text(), session_id: 'controlled-session'}) + '\n');
