export function hasClaudeCredential(env = process.env) {
  return Boolean(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || env.DEEPSEEK_API_KEY);
}

export function applyDeepSeekClaudeEnv(env = process.env) {
  if (!env.DEEPSEEK_API_KEY) return false;
  const model = env.DEEPSEEK_CLAUDE_MODEL || 'deepseek-v4-pro[1m]';
  env.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL || 'https://api.deepseek.com/anthropic';
  env.ANTHROPIC_AUTH_TOKEN = env.ANTHROPIC_AUTH_TOKEN || env.DEEPSEEK_API_KEY;
  env.ANTHROPIC_MODEL = env.ANTHROPIC_MODEL || model;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = env.ANTHROPIC_DEFAULT_OPUS_MODEL || model;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = env.ANTHROPIC_DEFAULT_SONNET_MODEL || model;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = env.ANTHROPIC_DEFAULT_HAIKU_MODEL || 'deepseek-v4-flash';
  env.CLAUDE_CODE_SUBAGENT_MODEL = env.CLAUDE_CODE_SUBAGENT_MODEL || 'deepseek-v4-flash';
  env.CLAUDE_CODE_EFFORT_LEVEL = env.CLAUDE_CODE_EFFORT_LEVEL || 'max';
  return true;
}
