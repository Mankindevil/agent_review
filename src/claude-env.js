export function hasClaudeCredential(env = process.env) {
  const backend = resolveClaudeBackend(env);
  if (backend === 'ark') return shouldUseArkClaude(env);
  if (backend === 'deepseek') return nonBlank(env.DEEPSEEK_API_KEY);
  if (backend === 'llmx') {
    return nonBlank(env.ANTHROPIC_BASE_URL)
      && nonBlank(env.ANTHROPIC_API_KEY)
      && nonBlank(env.ANTHROPIC_MODEL);
  }
  return false;
}

export function resolveClaudeBackend(env = process.env) {
  const backend = typeof env.CLAUDE_BACKEND === 'string'
    ? env.CLAUDE_BACKEND.trim().toLowerCase()
    : '';
  return backend === 'ark' || backend === 'deepseek' || backend === 'llmx'
    ? backend
    : null;
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

export function applyLlmxClaudeEnv(env = process.env, sourceEnv = env) {
  if (
    resolveClaudeBackend(sourceEnv) !== 'llmx'
    || !nonBlank(sourceEnv.ANTHROPIC_BASE_URL)
    || !nonBlank(sourceEnv.ANTHROPIC_API_KEY)
    || !nonBlank(sourceEnv.ANTHROPIC_MODEL)
  ) {
    return false;
  }
  const model = sourceEnv.ANTHROPIC_MODEL;
  env.ANTHROPIC_BASE_URL = sourceEnv.ANTHROPIC_BASE_URL;
  env.ANTHROPIC_API_KEY = sourceEnv.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  env.ANTHROPIC_MODEL = model;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
  env.CLAUDE_CODE_SUBAGENT_MODEL = model;
  env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1';
  env.CLAUDE_CODE_USE_BEDROCK = '0';
  env.CLAUDE_CODE_USE_FOUNDRY = '0';
  env.CLAUDE_CODE_USE_VERTEX = '0';
  env.ENABLE_TOOL_SEARCH = 'true';
  return true;
}

function nonBlank(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
