import path from 'node:path';
import { pandaDataConfig } from '../../src/panda-data.js';
import { normalizeMarketAgentPrincipalId } from './owner-scope.js';

const truthy = (value) => String(value).toLowerCase() === 'true';
const positive = (value, fallback) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
};

const DEFAULT_DEEPSEEK_V4_PRO = 'deepseek-v4-pro[1m]';

function resolveMarketModel(env = {}) {
  const name = String(
    env.MARKET_REPORT_MODEL
    || env.REVIEW_MODEL_DEEPSEEK
    || env.CLAUDE_ARK_MODEL
    || env.DEEPSEEK_CLAUDE_MODEL
    || DEFAULT_DEEPSEEK_V4_PRO
  ).trim() || DEFAULT_DEEPSEEK_V4_PRO;
  const explicitBase = String(env.MARKET_REPORT_BASE_URL || '').trim().replace(/\/$/, '');
  const explicitKey = String(env.MARKET_REPORT_API_KEY || '');
  const arkBase = String(env.ARK_BASE_URL || '').trim().replace(/\/$/, '');
  const arkKey = String(env.ARK_API_KEY || '');
  const openaiBase = String(env.OPENAI_BASE_URL || '').trim().replace(/\/$/, '');
  const openaiKey = String(env.OPENAI_API_KEY || '');
  const deepseekNames = new Set(
    [
      env.REVIEW_MODEL_DEEPSEEK,
      env.CLAUDE_ARK_MODEL,
      env.DEEPSEEK_CLAUDE_MODEL,
      DEFAULT_DEEPSEEK_V4_PRO,
      'deepseek-v4-pro'
    ]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  );
  const prefersArk = !explicitBase && deepseekNames.has(name) && Boolean(arkBase && arkKey);
  return {
    enabled: truthy(env.MARKET_REPORT_MODEL_ENABLED),
    baseUrl: explicitBase || (prefersArk ? arkBase : openaiBase),
    apiKey: explicitKey || (prefersArk ? arkKey : openaiKey),
    name,
    pricing: env.MARKET_REPORT_MODEL_PRICING_JSON || ''
  };
}

export function marketAgentConfig(env = process.env, cwd = process.cwd()) {
  const to = String(env.MARKET_REPORT_EMAIL_TO || '')
    .split(',').map((item) => item.trim()).filter(Boolean);
  const accessToken = String(env.MARKET_AGENT_ACCESS_TOKEN || '');
  const smtpPassword = String(env.MARKET_REPORT_SMTP_PASSWORD || '');
  const panda = pandaDataConfig(env);
  const config = {
    host: env.MARKET_AGENT_HOST || '127.0.0.1',
    port: positive(env.MARKET_AGENT_PORT, 4190),
    publicBaseUrl: String(env.MARKET_AGENT_PUBLIC_BASE_URL || '').replace(/\/$/, ''),
    accessToken,
    principalId: normalizeMarketAgentPrincipalId(env.MARKET_AGENT_PRINCIPAL_ID),
    allowInsecureLoopback: truthy(env.MARKET_AGENT_ALLOW_INSECURE_LOOPBACK),
    timezone: env.MARKET_REPORT_TIMEZONE || 'Asia/Shanghai',
    stateDir: path.resolve(cwd, env.MARKET_REPORT_STATE_DIR || 'data/market-analyst'),
    python: panda.python,
    workerTimeoutMs: Math.min(panda.timeoutMs * 10, 2_147_483_647),
    retentionDays: positive(env.MARKET_REPORT_RETENTION_DAYS, 365),
    cacheDays: positive(env.MARKET_REPORT_CACHE_DAYS, 30),
    minLiquidityCny: positive(env.MARKET_REPORT_MIN_LIQUIDITY_CNY, 20_000_000),
    panda,
    model: resolveMarketModel(env),
    email: {
      to,
      from: String(env.MARKET_REPORT_EMAIL_FROM || ''),
      sendFailureAlerts: env.MARKET_REPORT_SEND_FAILURE_ALERTS !== 'false'
    },
    smtp: {
      host: String(env.MARKET_REPORT_SMTP_HOST || ''),
      port: positive(env.MARKET_REPORT_SMTP_PORT, 587),
      secure: truthy(env.MARKET_REPORT_SMTP_SECURE),
      requireTLS: env.MARKET_REPORT_SMTP_STARTTLS !== 'false',
      username: String(env.MARKET_REPORT_SMTP_USERNAME || ''),
      password: smtpPassword
    }
  };
  config.public = {
    host: config.host,
    port: config.port,
    timezone: config.timezone,
    accessProtected: Boolean(accessToken),
    allowInsecureLoopback: config.allowInsecureLoopback,
    modelEnabled: config.model.enabled,
    emailConfigured: Boolean(to.length && config.email.from && config.smtp.host),
    pandaEnabled: panda.enabled,
    pandaConfigured: panda.configured,
    pandaReady: panda.ready,
    smtp: { host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure }
  };
  return config;
}
