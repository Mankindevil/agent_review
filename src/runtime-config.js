const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function resolveRuntimeConfig(runtimeId, env = process.env) {
  const remote = normalizeRemoteAdapter(readRemoteAdapter(runtimeId, env));
  if (remote) return remote;

  if (runtimeId === 'claude-code' && env.ENABLE_LOCAL_CLAUDE_CODE === 'true') {
    return { source: 'local', kind: 'local-cli', command: 'claude' };
  }
  if (runtimeId === 'cursor' && env.ENABLE_LOCAL_CURSOR_AGENT === 'true') {
    return { source: 'local', kind: 'local-cli', command: 'cursor-agent' };
  }
  if (runtimeId === 'doubao') {
    const baseUrl = nonBlank(env.ARK_BASE_URL);
    const model = nonBlank(env.REVIEW_MODEL_DOUBAO);
    if (baseUrl && model && isHttpUrl(baseUrl)) {
      return {
        source: 'builtin',
        kind: 'model-api',
        baseUrl,
        apiKeyEnv: 'ARK_API_KEY',
        model,
        thinking: { type: 'disabled' }
      };
    }
  }
  return null;
}

export function runtimeConfigAuthenticated(config, env = process.env) {
  if (!config) return false;
  if (!Object.hasOwn(config, 'apiKeyEnv')) return true;
  return hasOwnEnvValue(env, config.apiKeyEnv);
}

export function hasOwnEnvValue(env, name) {
  return typeof name === 'string'
    && ENV_NAME.test(name)
    && Object.hasOwn(env, name)
    && typeof env[name] === 'string'
    && env[name].trim().length > 0;
}

function readRemoteAdapter(runtimeId, env) {
  try {
    const parsed = JSON.parse(env.RUNTIME_ADAPTERS_JSON || '{}');
    if (!isObject(parsed)) return null;
    return parsed[runtimeId];
  } catch {
    return null;
  }
}

function normalizeRemoteAdapter(adapter) {
  if (!isObject(adapter)) return null;
  if (adapter.kind === 'remote-http') {
    const url = nonBlank(adapter.url);
    if (!url || !isHttpUrl(url)) return null;
    const config = { source: 'remote', kind: 'remote-http', url };
    if (Object.hasOwn(adapter, 'apiKeyEnv')) {
      const apiKeyEnv = validEnvName(adapter.apiKeyEnv);
      if (!apiKeyEnv) return null;
      config.apiKeyEnv = apiKeyEnv;
    }
    return config;
  }
  if (adapter.kind === 'model-api') {
    const baseUrl = nonBlank(adapter.baseUrl);
    const model = nonBlank(adapter.model);
    const apiKeyEnv = validEnvName(adapter.apiKeyEnv);
    if (!baseUrl || !isHttpUrl(baseUrl) || !model || !apiKeyEnv) return null;
    return {
      source: 'remote',
      kind: 'model-api',
      baseUrl,
      apiKeyEnv,
      model,
      ...(isObject(adapter.thinking) ? { thinking: adapter.thinking } : {})
    };
  }
  return null;
}

function validEnvName(value) {
  const name = nonBlank(value);
  return name && ENV_NAME.test(name) ? name : null;
}

function nonBlank(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isHttpUrl(value) {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
