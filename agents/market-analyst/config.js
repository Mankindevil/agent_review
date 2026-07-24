import path from 'node:path';
import { pandaDataConfig } from '../../src/panda-data.js';
import { normalizeMarketAgentPrincipalId } from './owner-scope.js';

const truthy = (value) => String(value).toLowerCase() === 'true';
const positive = (value, fallback) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
};

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
    python: env.PANDA_DATA_PYTHON || (process.platform === 'win32' ? 'py' : 'python3'),
    workerTimeoutMs: positive(env.PANDA_DATA_TIMEOUT_MS, 60_000) * 10,
    retentionDays: positive(env.MARKET_REPORT_RETENTION_DAYS, 365),
    cacheDays: positive(env.MARKET_REPORT_CACHE_DAYS, 30),
    minLiquidityCny: positive(env.MARKET_REPORT_MIN_LIQUIDITY_CNY, 20_000_000),
    panda,
    model: {
      enabled: truthy(env.MARKET_REPORT_MODEL_ENABLED),
      baseUrl: String(env.OPENAI_BASE_URL || ''),
      apiKey: String(env.OPENAI_API_KEY || ''),
      name: env.MARKET_REPORT_MODEL || env.REVIEW_MODEL_OPENAI || 'g5.4',
      pricing: env.MARKET_REPORT_MODEL_PRICING_JSON || ''
    },
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
