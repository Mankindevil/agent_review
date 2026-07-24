import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export function validateSafeUrl(rawUrl, options = {}) {
  if (typeof rawUrl !== 'string' || rawUrl.length > 2048) throw safeError('目标 URL 不合法或过长', 'security');
  let url;
  try { url = new URL(rawUrl); } catch { throw safeError('目标 URL 不合法', 'security'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw safeError('目标 URL 仅支持 HTTP(S)', 'security');
  if (url.username || url.password) throw safeError('目标 URL 不允许包含 userinfo 凭据', 'security');
  const hostname = normalizeHostname(url.hostname);
  if (!hostname) throw safeError('目标 URL 缺少主机名', 'security');
  if (!options.allowPrivate && (hostname === 'localhost' || hostname.endsWith('.local'))) {
    throw safeError('为防止 SSRF，禁止本地主机名', 'security');
  }
  if (isIP(hostname) && !options.allowPrivate) assertPublicAddress(hostname);
  return url;
}

export function assertPublicAddress(address) {
  const version = isIP(address);
  if (!version) throw safeError('DNS 返回了无效 IP 地址', 'dns');
  if (version === 4 && isUnsafeIpv4(address)) throw safeError('为防止 SSRF，禁止访问非公网 IP', 'security');
  if (version === 6 && isUnsafeIpv6(address)) throw safeError('为防止 SSRF，禁止访问非公网 IPv6', 'security');
  return address;
}

export async function resolveSafeAddress(rawUrl, options = {}) {
  const allowPrivate = options.allowPrivate ?? process.env.ALLOW_PRIVATE_AGENT_URLS === 'true';
  const url = validateSafeUrl(rawUrl, { allowPrivate });
  const hostname = normalizeHostname(url.hostname);
  if (options.signal?.aborted) throw safeError('请求已取消', 'cancelled');
  let records;
  if (isIP(hostname)) {
    records = [{ address: hostname, family: isIP(hostname) }];
  } else {
    const lookup = options.lookup || defaultLookup;
    try {
      records = await abortable(Promise.resolve(lookup(hostname)), options.signal);
    } catch (error) {
      if (error?.code === 'cancelled') throw error;
      throw safeError('域名解析失败', 'dns');
    }
  }
  if (!Array.isArray(records) || records.length === 0) throw safeError('DNS 未返回可用地址', 'dns');
  for (const record of records) {
    if (!record || !isIP(record.address)) throw safeError('DNS 返回了无效地址', 'dns');
    if (!allowPrivate) assertPublicAddress(record.address);
  }
  return { url, address: records[0].address, family: records[0].family || isIP(records[0].address), records };
}

export async function safeHttpRequest(rawUrl, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 30_000;
  const timeoutController = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;
  let timedOut = false;
  const totalTimer = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, timeoutMs);
  try {
    return await performSafeHttpRequest(rawUrl, { ...options, signal, timeoutMs });
  } catch (error) {
    if (timedOut && error?.code === 'cancelled') throw safeError('请求超时', 'timeout');
    throw error;
  } finally {
    clearTimeout(totalTimer);
  }
}

async function performSafeHttpRequest(rawUrl, options) {
  const resolved = await resolveSafeAddress(rawUrl, options);
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs;
  const requestBody = options.body === undefined || options.body === null ? null : Buffer.from(options.body);
  if (options.signal?.aborted) throw safeError('请求已取消', 'cancelled');

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let lastHookAt = 0;
    const hookTime = () => {
      lastHookAt = Math.max(lastHookAt, Date.now());
      return lastHookAt;
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const fail = (error) => finish(reject, normalizeTransportError(error));
    const pinnedLookup = (_hostname, lookupOptions, callback) => {
      if (lookupOptions?.all) callback(null, [{ address: resolved.address, family: resolved.family }]);
      else callback(null, resolved.address, resolved.family);
    };
    const requester = resolved.url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = requester(resolved.url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      lookup: pinnedLookup,
      servername: normalizeHostname(resolved.url.hostname)
    }, (response) => {
      const chunks = [];
      let size = 0;
      let firstChunk = true;
      response.on('error', fail);
      try {
        options.onHeaders?.({
          status: response.statusCode || 0,
          headers: response.headers,
          at: hookTime()
        });
      } catch {
        const error = safeError('platform instrumentation error', 'instrumentation');
        response.destroy(error);
        request.destroy(error);
        finish(reject, error);
        return;
      }
      response.on('data', (chunk) => {
        const nextSize = size + chunk.length;
        if (nextSize > maxBytes) {
          response.destroy(safeError('远程响应超过大小限制', 'response-too-large'));
          return;
        }
        size = nextSize;
        try {
          options.onChunk?.({
            bytes: Buffer.from(chunk),
            at: hookTime(),
            first: firstChunk
          });
        } catch {
          const error = safeError('platform instrumentation error', 'instrumentation');
          response.destroy(error);
          request.destroy(error);
          finish(reject, error);
          return;
        }
        firstChunk = false;
        if (size > maxBytes) {
          response.destroy(safeError('远程响应超过大小限制', 'response-too-large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => finish(resolve, {
        status: response.statusCode || 0,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
    });
    const onAbort = () => request.destroy(safeError('请求已取消', 'cancelled'));
    request.on('error', fail);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => request.destroy(safeError('请求超时', 'timeout')), timeoutMs);
    if (requestBody) request.write(requestBody);
    request.end();
  });
}

async function defaultLookup(hostname) {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

function normalizeHostname(hostname) {
  return String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
}

function isUnsafeIpv4(address) {
  const parts = address.split('.').map(Number);
  const value = ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
  const inCidr = (base, prefix) => {
    const baseParts = base.split('.').map(Number);
    const baseValue = ((baseParts[0] << 24) >>> 0) + (baseParts[1] << 16) + (baseParts[2] << 8) + baseParts[3];
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (value & mask) === (baseValue & mask);
  };
  return [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
    ['224.0.0.0', 4], ['240.0.0.0', 4]
  ].some(([base, prefix]) => inCidr(base, prefix));
}

function isUnsafeIpv6(address) {
  const lower = address.toLowerCase();
  const mapped = lower.match(/^(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isUnsafeIpv4(mapped[1]);
  const groups = expandIpv6(lower);
  if (!groups) return true;
  const first = groups[0];
  const allZero = groups.every((group) => group === 0);
  const loopback = groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
  const ipv4Mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (ipv4Mapped) {
    const ipv4 = `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
    return isUnsafeIpv4(ipv4);
  }
  return allZero || loopback || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00 || (groups[0] === 0x2001 && groups[1] === 0x0db8);
}

function expandIpv6(address) {
  let value = address;
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':');
    const ipv4 = value.slice(lastColon + 1);
    if (isIP(ipv4) !== 4) return null;
    const parts = ipv4.split('.').map(Number);
    value = `${value.slice(0, lastColon)}:${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right].map((part) => Number.parseInt(part || '0', 16));
  return groups.length === 8 && groups.every((part) => Number.isInteger(part) && part >= 0 && part <= 0xffff) ? groups : null;
}

function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(safeError('请求已取消', 'cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); }
    );
  });
}

function safeError(message, code) {
  return Object.assign(new Error(message), { code });
}

function normalizeTransportError(error) {
  if (error?.code && ['security', 'dns', 'timeout', 'cancelled', 'response-too-large', 'instrumentation'].includes(error.code)) return error;
  if (error?.code?.startsWith?.('ERR_TLS') || error?.code?.startsWith?.('CERT_')) return safeError('TLS 握手失败', 'tls');
  return safeError(error?.message || '远程连接失败', 'connection');
}
