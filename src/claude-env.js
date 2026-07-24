export function hasClaudeCredential(env = process.env) {
  const backend = resolveClaudeBackend(env);
  if (backend === 'ark') return shouldUseArkClaude(env);
  if (backend === 'deepseek') return nonBlank(env.DEEPSEEK_API_KEY);
  return false;
}

export function resolveClaudeBackend(env = process.env) {
  const backend = typeof env.CLAUDE_BACKEND === 'string'
    ? env.CLAUDE_BACKEND.trim().toLowerCase()
    : '';
  return backend === 'ark' || backend === 'deepseek' ? backend : null;
}

export function shouldUseArkClaude(env = process.env) {
  return resolveClaudeBackend(env) === 'ark'
    && nonBlank(env.ARK_BASE_URL)
    && nonBlank(env.ARK_API_KEY)
    && nonBlank(env.CLAUDE_ARK_MODEL);
}

export function applyArkClaudeEnv(env, proxyBaseUrl, model = env.CLAUDE_ARK_MODEL) {
  env.ANTHROPIC_BASE_URL = proxyBaseUrl;
  env.ANTHROPIC_AUTH_TOKEN = 'local-ark-proxy';
  env.ANTHROPIC_API_KEY = '';
  env.ANTHROPIC_MODEL = model;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
  env.CLAUDE_CODE_SUBAGENT_MODEL = model;
  return env;
}

export function applyDeepSeekClaudeEnv(env = process.env, sourceEnv = env) {
  if (resolveClaudeBackend(sourceEnv) !== 'deepseek' || !nonBlank(sourceEnv.DEEPSEEK_API_KEY)) {
    return false;
  }
  const model = sourceEnv.DEEPSEEK_CLAUDE_MODEL || 'deepseek-v4-pro[1m]';
  env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';
  env.ANTHROPIC_AUTH_TOKEN = sourceEnv.DEEPSEEK_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  env.ANTHROPIC_MODEL = model;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'deepseek-v4-flash';
  env.CLAUDE_CODE_SUBAGENT_MODEL = 'deepseek-v4-flash';
  env.CLAUDE_CODE_EFFORT_LEVEL = 'max';
  delete env.DEEPSEEK_API_KEY;
  return true;
}

function nonBlank(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
