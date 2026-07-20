if (!process.env.DEEPSEEK_API_KEY) {
  console.error('缺少 DEEPSEEK_API_KEY。请先在当前终端执行：read -s "DEEPSEEK_API_KEY?DeepSeek API Key: "; export DEEPSEEK_API_KEY');
  process.exit(1);
}

process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';
process.env.ANTHROPIC_AUTH_TOKEN = process.env.DEEPSEEK_API_KEY;
process.env.ANTHROPIC_MODEL = process.env.DEEPSEEK_CLAUDE_MODEL || 'deepseek-v4-pro[1m]';
process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = process.env.ANTHROPIC_MODEL;
process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = process.env.ANTHROPIC_MODEL;
process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'deepseek-v4-flash';
process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'deepseek-v4-flash';
process.env.CLAUDE_CODE_EFFORT_LEVEL = process.env.CLAUDE_CODE_EFFORT_LEVEL || 'max';
process.env.ENABLE_LOCAL_CLAUDE_CODE = 'true';
process.env.ENABLE_LOCAL_CURSOR_AGENT = 'true';

console.log(`DeepSeek → Claude Code 已配置：${process.env.ANTHROPIC_MODEL}`);
console.log('API Key 仅保留在当前进程环境中，不写入项目文件。');
await import('./real-demo.js');
