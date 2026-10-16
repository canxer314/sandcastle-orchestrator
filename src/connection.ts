import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { claudeCode as nativeClaudeCode, type AgentProvider } from '@ai-hero/sandcastle';

export type ClaudeConnection = {source: 'settings'; path: string} | {source: 'environment'};

// Exact omission shim for the pinned Sandcastle 0.12.0 builder; retain stdin/parser/sessions.
export function claudeCode(model?: string, options?: Parameters<typeof nativeClaudeCode>[1]): AgentProvider {
  const agent = nativeClaudeCode(model ?? '', options);
  if (model !== undefined) return agent;
  return {...agent, buildPrintCommand(commandOptions) {
    const original = agent.buildPrintCommand(commandOptions);
    return {...original, command: original.command.replace(" --model ''", '')};
  }, buildInteractiveArgs(commandOptions) {
    const args = agent.buildInteractiveArgs!(commandOptions);
    const index = args.indexOf('--model');
    return index < 0 ? args : [...args.slice(0, index), ...args.slice(index + 2)];
  }};
}

export function configureClaudeConnection(agent: AgentProvider): AgentProvider {
  return {...agent, buildPrintCommand(options) {
    const original = agent.buildPrintCommand(options);
    return {...original, command: `${original.command} --setting-sources ''`};
  }};
}

// Explicit client-facing fields, not a prefix import or a backend model mapping table.
const fields = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL', 'ANTHROPIC_BETAS', 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_DISABLE_THINKING', 'DISABLE_INTERLEAVED_THINKING', 'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT',
  'CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING', 'ENABLE_TOOL_SEARCH',
] as const;
const unsupported = [
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_OAUTH_SCOPES', 'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_GATEWAY', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'CLAUDE_CODE_EXTRA_BODY', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE',
  'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL', 'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_RESOURCE', 'ANTHROPIC_PROFILE',
  'ANTHROPIC_IDENTITY_TOKEN', 'ANTHROPIC_IDENTITY_TOKEN_FILE', 'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_ORGANIZATION_ID', 'ANTHROPIC_WORKSPACE_ID', 'ANTHROPIC_SERVICE_ACCOUNT_ID',
  'GOOGLE_APPLICATION_CREDENTIALS', 'CLOUD_ML_REGION',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'CLAUDE_CODE_CLIENT_CERT', 'CLAUDE_CODE_CLIENT_KEY', 'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
];
const helpers = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh', 'otelHeadersHelper'];
const unsupportedKey = (key: string) => unsupported.includes(key) || /^(AWS_|GOOGLE_|AZURE_|VERTEX_REGION_|ANTHROPIC_(BEDROCK|VERTEX|FOUNDRY|AWS)_)/.test(key)
  || /^CLAUDE_CODE_(USE_|SKIP_)/.test(key) || /^(https?|all)_proxy$/i.test(key);
const connectionKey = (key: string) => fields.includes(key as typeof fields[number]) || unsupportedKey(key) || key === 'NODE_TLS_REJECT_UNAUTHORIZED'
  || /^(ANTHROPIC_|CLAUDE_CODE_|AWS_|GOOGLE_|AZURE_)/.test(key) || /^(https?|all|no)_proxy$/i.test(key);

export function validateClaudeConnection(connection: ClaudeConnection) {
  if (!connection || (connection.source !== 'settings' && connection.source !== 'environment')
    || Object.keys(connection).some(key => !['source', ...(connection.source === 'settings' ? ['path'] : [])].includes(key))
    || (connection.source === 'settings' && (typeof connection.path !== 'string' || !isAbsolute(connection.path)))) {
    throw Error('Invalid Claude connection source; select environment or an absolute settings path');
  }
}

export async function loadClaudeConnection(connection: ClaudeConnection, dockerEnv: Record<string, string> = {}) {
  validateClaudeConnection(connection);
  let settings: Record<string, unknown> = {};
  let source: Record<string, unknown>;
  if (connection.source === 'environment') source = process.env;
  else {
    try {
      settings = JSON.parse(await readFile(connection.path, 'utf8'));
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw Error();
      source = settings.env === undefined ? {} : settings.env as Record<string, unknown>;
      if (!source || typeof source !== 'object' || Array.isArray(source)) throw Error();
    } catch { throw Error('Selected Claude connection settings unavailable or invalid'); }
  }
  if (helpers.some(key => settings[key] !== undefined && settings[key] !== null && settings[key] !== '')
    || (source.NODE_TLS_REJECT_UNAUTHORIZED !== undefined && source.NODE_TLS_REJECT_UNAUTHORIZED !== '' && source.NODE_TLS_REJECT_UNAUTHORIZED !== '1')
    || Object.entries(source).some(([key, value]) => unsupportedKey(key) && value !== undefined && value !== ''
      && (!/^CLAUDE_CODE_(USE_|SKIP_)/.test(key) || (value !== '0' && value !== 'false')))) {
    throw Error('Selected Claude connection requires unsupported authentication, helper, cloud, proxy or TLS dependencies; provide independent container-ready settings');
  }
  const env: Record<string, string> = Object.fromEntries(Object.entries(dockerEnv).filter(([key]) => !connectionKey(key)));
  if (Object.keys(env).some(key=>!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) throw Error('Invalid container environment variable name');
  for (const key of fields) {
    const value = source[key];
    if (value === undefined || value === '') continue;
    if (typeof value !== 'string' || value.includes('\0')) throw Error('Invalid selected Claude connection field');
    env[key] = value;
  }
  if (settings.model !== undefined) {
    if (typeof settings.model !== 'string' || !settings.model || settings.model.includes('\0')) throw Error('Invalid selected Claude model');
    env.ANTHROPIC_MODEL ??= settings.model;
  }
  if (!!env.ANTHROPIC_API_KEY === !!env.ANTHROPIC_AUTH_TOKEN) throw Error('Selected Claude connection must provide exactly one API key or auth token; no identity fallback is permitted');
  if (env.ANTHROPIC_BASE_URL) {
    try {
      const url = new URL(env.ANTHROPIC_BASE_URL);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error();
    } catch { throw Error('Selected Claude endpoint must be an HTTP(S) URL without embedded credentials, query or fragment'); }
  }
  const secrets = [env.ANTHROPIC_API_KEY, env.ANTHROPIC_AUTH_TOKEN, env.ANTHROPIC_CUSTOM_HEADERS,
    dockerEnv.ANTHROPIC_API_KEY, dockerEnv.ANTHROPIC_AUTH_TOKEN, dockerEnv.ANTHROPIC_CUSTOM_HEADERS].filter((value): value is string => !!value);
  const headerNames = new Set<string>();
  for (const line of env.ANTHROPIC_CUSTOM_HEADERS?.split(/\r?\n/) ?? []) {
    const index = line.indexOf(':');
    const name = line.slice(0, index).toLowerCase();
    if (index < 1 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(line.slice(0, index)) || !line.slice(index + 1).trim()
      || /[\x00-\x1f\x7f]/.test(line) || headerNames.has(name)
      || ['authorization', 'x-api-key', 'host', 'content-length', 'transfer-encoding', 'connection', 'anthropic-version', 'anthropic-beta'].includes(name)) throw Error('Invalid or conflicting selected Claude custom headers');
    headerNames.add(name);
    secrets.push(line.slice(index + 1).trim());
  }
  if (env.ANTHROPIC_BETAS && ['1', 'true'].includes(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)) throw Error('Conflicting selected Claude beta settings');
  const runtimeEnv = Object.fromEntries(fields.filter(key=>env[key]!==undefined).map(key=>[key,env[key]]));
  return {env, runtimeEnv, secrets};
}
