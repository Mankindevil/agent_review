import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PANDA_DATA_METHODS = [
  'get_trade_cal',
  'get_prev_trade_date',
  'get_last_trade_date',
  'get_trade_list',
  'get_stock_status_change',
  'get_stock_daily',
  'get_stock_daily_pre',
  'get_stock_daily_post',
  'get_index_daily',
  'get_index_weights',
  'get_factor',
  'get_adj_factor',
  'get_fina_reports',
  'get_stock_disclosure_date',
  'get_stock_industry',
  'get_industry_constituents',
  'get_hk_daily',
  'get_us_daily'
];

const BRIDGE_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'panda-data-bridge.py');
const DEFAULT_BASE_URL = 'http://pandadata.pandaaiquant.com';

export function pandaDataConfig(env = process.env) {
  const allowedMethods = String(env.PANDA_DATA_ALLOWED_METHODS || DEFAULT_PANDA_DATA_METHODS.join(','))
    .split(',').map((value) => value.trim()).filter(Boolean);
  const enabled = env.PANDA_DATA_ENABLED === 'true';
  const username = normalizeUsername(env.PANDA_DATA_USERNAME);
  const configured = Boolean(username && env.PANDA_DATA_PASSWORD);
  const accessProtected = Boolean(env.PANDA_DATA_ACCESS_KEY);
  return {
    provider: 'pandaai',
    enabled,
    configured,
    ready: enabled && configured,
    accessProtected,
    baseUrl: env.PANDA_DATA_BASE_URL?.trim() || DEFAULT_BASE_URL,
    python: env.PANDA_DATA_PYTHON || 'python3',
    timeoutMs: positiveInteger(env.PANDA_DATA_TIMEOUT_MS, 60_000),
    maxRows: positiveInteger(env.PANDA_DATA_MAX_ROWS, 500),
    allowedMethods: [...new Set(allowedMethods)],
    username,
    password: env.PANDA_DATA_PASSWORD || '',
    accessKey: env.PANDA_DATA_ACCESS_KEY || ''
  };
}

function normalizeUsername(value) {
  const username = String(value || '').trim();
  return /^1\d{10}$/.test(username) ? `86${username}` : username;
}

export async function getPandaDataStatus(options = {}) {
  const config = pandaDataConfig(options.env);
  let installed = null;
  let error;
  if (options.probe) {
    try {
      const result = options.bridgeRunner
        ? await options.bridgeRunner({ probe: true, config })
        : await runBridge({ probe: true, config, signal: options.signal, spawnImpl: options.spawnImpl });
      installed = result.installed === true;
    } catch (cause) {
      installed = false;
      error = cause.message;
    }
  }
  return {
    provider: config.provider,
    enabled: config.enabled,
    configured: config.configured,
    ready: config.ready && installed !== false,
    accessProtected: config.accessProtected,
    installed,
    allowedMethods: config.allowedMethods,
    ...(error ? { error } : {})
  };
}

export async function queryPandaData(method, params = {}, options = {}) {
  const config = pandaDataConfig(options.env);
  if (!config.enabled) throw dataError('PandaAI 数据源未启用，请设置 PANDA_DATA_ENABLED=true', 503);
  if (!config.configured) throw dataError('PandaAI 数据账号未配置完整', 503);
  if (!config.allowedMethods.includes(method)) throw dataError(`Panda Data 方法不在白名单：${method}`, 400);
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw dataError('params 必须是 JSON 对象', 400);
  return options.bridgeRunner
    ? options.bridgeRunner({ method, params, config })
    : runBridge({ method, params, config, signal: options.signal, spawnImpl: options.spawnImpl });
}

async function runBridge({ method, params, probe = false, config, signal, spawnImpl = spawn }) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(config.python, [BRIDGE_FILE, ...(probe ? ['--probe'] : [])], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: bridgeEnvironment(config)
    });
    const stdout = [];
    const stderr = [];
    let outputSize = 0;
    let settled = false;
    const maxOutputBytes = Math.max(1_000_000, config.maxRows * 20_000);
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      callback();
    };
    const fail = (error) => finish(() => reject(error));
    const abort = () => {
      child.kill('SIGTERM');
      fail(signal.reason instanceof Error ? signal.reason : new Error('PandaAI 数据请求已中止'));
    };
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      fail(dataError(`PandaAI 数据请求超过 ${Math.round(config.timeoutMs / 1000)} 秒`, 504));
    }, config.timeoutMs);

    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => fail(dataError(`无法启动 Panda Data Python bridge：${error.message}`, 503)));
    child.stdout.on('data', (chunk) => {
      outputSize += chunk.length;
      if (outputSize > maxOutputBytes) {
        child.kill('SIGTERM');
        fail(dataError('PandaAI 数据响应超过平台上限', 502));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('close', (code) => finish(() => {
      const text = Buffer.concat(stdout).toString('utf8').trim();
      let payload;
      try { payload = JSON.parse(text || '{}'); }
      catch { return reject(dataError(`Panda Data bridge 返回了无效 JSON${stderr.length ? `：${safeDetail(stderr)}` : ''}`, 502)); }
      if (code !== 0 || payload.error) {
        const detail = payload.error || safeDetail(stderr) || `Panda Data bridge 退出码 ${code}`;
        return reject(dataError(sanitizeProviderError(detail, config), 502));
      }
      resolve(payload);
    }));

    child.stdin.end(probe ? '' : JSON.stringify({ method, params }));
  });
}

function bridgeEnvironment(config) {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin',
    LANG: process.env.LANG || 'C.UTF-8',
    LC_ALL: process.env.LC_ALL || '',
    SSL_CERT_FILE: process.env.SSL_CERT_FILE || '',
    REQUESTS_CA_BUNDLE: process.env.REQUESTS_CA_BUNDLE || '',
    PYTHONIOENCODING: 'utf-8',
    PANDA_DATA_USERNAME: config.username,
    PANDA_DATA_PASSWORD: config.password,
    PANDA_DATA_BASE_URL: config.baseUrl,
    PANDA_DATA_ALLOWED_METHODS: config.allowedMethods.join(','),
    PANDA_DATA_MAX_ROWS: String(config.maxRows)
  };
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function safeDetail(chunks) {
  return Buffer.concat(chunks).toString('utf8').trim().slice(0, 500).replace(/password|token|username/gi, '[redacted]');
}

function sanitizeProviderError(message, config) {
  let value = String(message).slice(0, 500);
  for (const secret of [config.username, config.password]) {
    if (secret) value = value.replaceAll(secret, '[redacted]');
  }
  return value.replace(/password|token|username/gi, '[redacted]');
}

function dataError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}
