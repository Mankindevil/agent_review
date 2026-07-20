import '../src/env.js';
import { hasClaudeCredential, shouldUseArkClaude } from '../src/claude-env.js';

if (!hasClaudeCredential(process.env)) {
  console.error('Claude Code 缺少可用凭据。Ark 模式请配置 ARK_API_KEY；DeepSeek 直连模式请配置 DEEPSEEK_API_KEY。');
  process.exit(1);
}

process.env.ENABLE_LOCAL_CLAUDE_CODE = 'true';
process.env.ENABLE_LOCAL_CURSOR_AGENT = 'true';

console.log(`DeepSeek → Claude Code 后端：${shouldUseArkClaude(process.env) ? 'Volcengine Ark' : 'DeepSeek Anthropic-compatible'}`);
console.log('API Key 仅从进程环境或被 Git 忽略的 .env 读取，不进入日志和评测记录。');
await import('./real-demo.js');
