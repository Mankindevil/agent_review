import '../src/env.js';

if (!process.env.DEEPSEEK_API_KEY) {
  console.error('缺少 DEEPSEEK_API_KEY。请在项目 .env 中填写 DEEPSEEK_API_KEY=你的Key，或通过当前终端导出该变量。');
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
console.log('API Key 仅从进程环境或被 Git 忽略的 .env 读取，不进入日志和评测记录。');
await import('./real-demo.js');
