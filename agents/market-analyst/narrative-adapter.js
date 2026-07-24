import { createHash } from 'node:crypto';

import { validateNarrative } from './report-validator.js';
import { validateEvidencePack } from './schemas.js';

const MAX_PROMPT_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_RESPONSE_ENVELOPE_BYTES = 256 * 1024;

function isoNow() {
  return new Date().toISOString();
}

function finiteToken(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parsePricing(value) {
  if (!value) return { table: null, reason: 'pricing is not configured' };
  if (typeof value === 'object' && !Array.isArray(value)) return { table: value, reason: null };
  if (typeof value !== 'string') return { table: null, reason: 'pricing configuration is invalid' };
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { table: parsed, reason: null }
      : { table: null, reason: 'pricing configuration is invalid' };
  } catch {
    return { table: null, reason: 'pricing configuration is invalid JSON' };
  }
}

function calculatePricing(config, tokens) {
  const { table, reason } = parsePricing(config.pricing);
  if (!table) {
    return {
      pricingVersion: null,
      cost: null,
      currency: null,
      pricingUnavailableReason: reason
    };
  }
  const pricingVersion = typeof table.version === 'string' && table.version.trim()
    ? table.version.trim()
    : null;
  if (!pricingVersion) {
    return {
      pricingVersion: null,
      cost: null,
      currency: table.currency || null,
      pricingUnavailableReason: 'pricing version is required'
    };
  }
  const inputRate = Number(table.inputPerMillion);
  const outputRate = Number(table.outputPerMillion);
  if (
    tokens.inputTokens === null
    || tokens.outputTokens === null
    || !Number.isFinite(inputRate)
    || !Number.isFinite(outputRate)
    || inputRate < 0
    || outputRate < 0
    || (tokens.cachedTokens !== null && tokens.cachedTokens > tokens.inputTokens)
  ) {
    return {
      pricingVersion,
      cost: null,
      currency: table.currency || null,
      pricingUnavailableReason: 'versioned pricing rates or token usage are unavailable'
    };
  }
  const cachedRate = Number(table.cachedInputPerMillion);
  const cachedTokens = tokens.cachedTokens ?? 0;
  const regularInput = Number.isFinite(cachedRate)
    ? Math.max(0, tokens.inputTokens - cachedTokens)
    : tokens.inputTokens;
  const inputCost = regularInput * inputRate / 1_000_000;
  const cachedCost = Number.isFinite(cachedRate) ? cachedTokens * cachedRate / 1_000_000 : 0;
  const outputCost = tokens.outputTokens * outputRate / 1_000_000;
  return {
    pricingVersion,
    cost: Number((inputCost + cachedCost + outputCost).toFixed(12)),
    currency: table.currency || null,
    pricingUnavailableReason: null
  };
}

async function readBoundedResponseJson(response) {
  let text;
  if (response.body) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_RESPONSE_ENVELOPE_BYTES) {
        throw new RangeError('model response envelope exceeds safe bounds');
      }
      chunks.push(buffer);
    }
    text = Buffer.concat(chunks).toString('utf8');
  } else if (typeof response.text === 'function') {
    text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_ENVELOPE_BYTES) {
      throw new RangeError('model response envelope exceeds safe bounds');
    }
  } else if (typeof response.json === 'function') {
    const parsed = await response.json();
    if (Buffer.byteLength(JSON.stringify(parsed)) > MAX_RESPONSE_ENVELOPE_BYTES) {
      throw new RangeError('model response envelope exceeds safe bounds');
    }
    return parsed;
  } else {
    throw new TypeError('model response body is unavailable');
  }
  return JSON.parse(text);
}

function compactEvidence(evidence) {
  const sources = evidence.sources.map((source) => ({
    id: source.id,
    method: source.method,
    dataAsOf: source.dataAsOf,
    window: source.window || source.dataWindow || null,
    coverage: source.coverage ?? null,
    rowCount: source.rowCount ?? null,
    traceSequence: source.traceSequence ?? source.sequence ?? null,
    status: source.status
  }));
  return {
    schemaVersion: evidence.schemaVersion,
    runId: evidence.runId,
    reportDate: evidence.reportDate,
    status: evidence.status,
    markets: evidence.markets,
    universe: evidence.universe,
    coverage: evidence.coverage,
    missingData: evidence.missingData || [],
    metricVersion: evidence.metricVersion,
    leaderboards: evidence.leaderboards,
    conclusions: evidence.conclusions,
    sources,
    conventions: evidence.conventions || []
  };
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) =>
    typeof part === 'string' ? part : (part?.text || '')
  ).filter(Boolean).join('\n');
}

function completionUrl(baseUrl) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

function parseContent(content) {
  if (Buffer.byteLength(content) > MAX_RESPONSE_BYTES) {
    throw new RangeError('model response exceeds safe bounds');
  }
  const trimmed = content.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('model response must be a JSON object');
  }
  return parsed;
}

function normalizeUsage({ config, startedAt, startedMs, endedAt, response, content }) {
  const raw = response?.usage;
  const tokens = {
    inputTokens: finiteToken(raw?.prompt_tokens ?? raw?.input_tokens),
    outputTokens: finiteToken(raw?.completion_tokens ?? raw?.output_tokens),
    reasoningTokens: finiteToken(
      raw?.completion_tokens_details?.reasoning_tokens ?? raw?.reasoning_tokens
    ),
    cachedTokens: finiteToken(
      raw?.prompt_tokens_details?.cached_tokens ?? raw?.cached_tokens
    ),
    totalTokens: finiteToken(raw?.total_tokens)
  };
  const tokenFields = Object.values(tokens);
  const usageUnavailableReason = tokenFields.every((value) => value === null)
    ? 'provider did not report token usage'
    : (tokenFields.some((value) => value === null)
      ? 'provider omitted one or more token usage fields'
      : null);
  const pricing = calculatePricing(config, tokens);
  return {
    provider: config.provider || 'openai-compatible',
    model: response?.model || config.name || null,
    startedAt,
    endedAt,
    durationMs: Math.max(0, Date.parse(endedAt) - startedMs),
    ...tokens,
    usageUnavailableReason,
    pricingVersion: pricing.pricingVersion,
    cost: pricing.cost,
    currency: pricing.currency,
    pricingUnavailableReason: pricing.pricingUnavailableReason,
    finishReason: response?.choices?.[0]?.finish_reason ?? null,
    responseSha256: content
      ? createHash('sha256').update(content).digest('hex')
      : null
  };
}

function emptyUsage(config, startedAt, startedMs, reason) {
  const endedAt = isoNow();
  return {
    provider: config?.provider || 'openai-compatible',
    model: config?.name || null,
    startedAt,
    endedAt,
    durationMs: Math.max(0, Date.parse(endedAt) - startedMs),
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    cachedTokens: null,
    totalTokens: null,
    usageUnavailableReason: reason,
    pricingVersion: null,
    cost: null,
    currency: null,
    pricingUnavailableReason: 'no successful model response',
    finishReason: null,
    responseSha256: null
  };
}

export async function generateNarrative(
  evidence,
  config = {},
  { fetchImpl = fetch, signal } = {}
) {
  validateEvidencePack(evidence);
  const startedAt = isoNow();
  const startedMs = Date.parse(startedAt);
  if (!config.enabled) {
    const fallbackReason = 'narrative model is disabled';
    return {
      sections: [],
      usage: emptyUsage(config, startedAt, startedMs, fallbackReason),
      fallbackReason
    };
  }
  if (!config.baseUrl || !config.apiKey || !config.name) {
    const fallbackReason = 'narrative model configuration is incomplete';
    return {
      sections: [],
      usage: emptyUsage(config, startedAt, startedMs, fallbackReason),
      fallbackReason
    };
  }

  const compact = compactEvidence(evidence);
  const evidenceJson = JSON.stringify(compact);
  if (Buffer.byteLength(evidenceJson) > MAX_PROMPT_BYTES) {
    const fallbackReason = 'compact Evidence Pack exceeds model prompt bounds';
    return {
      sections: [],
      usage: emptyUsage(config, startedAt, startedMs, fallbackReason),
      fallbackReason
    };
  }

  let responseJson;
  let content = '';
  try {
    const response = await fetchImpl(completionUrl(config.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.name,
        temperature: 0,
        max_tokens: Number.isSafeInteger(config.maxTokens) && config.maxTokens > 0
          ? Math.min(config.maxTokens, 4_096)
          : 1_200,
        response_format: { type: 'json_object' },
        messages: [{
          role: 'system',
          content: [
            '你是只负责润色的市场报告叙述适配器。',
            '只能使用用户给出的 Evidence Pack；不得使用外部知识、工具或数据源。',
            '不得新增或修改数字、排名、日期、置信度、否决、结论、证券或因果关系。',
            '只返回 JSON：{"sections":[{"id":"executive-summary","conclusionIds":["..."],"text":"..."}]}。'
          ].join('\n')
        }, {
          role: 'user',
          content: evidenceJson
        }]
      }),
      signal
    });
    if (!response?.ok) throw new Error(`model returned HTTP ${response?.status ?? 'unknown'}`);
    responseJson = await readBoundedResponseJson(response);
    content = contentText(responseJson?.choices?.[0]?.message?.content);
    if (!content) throw new Error('model response has no content');
  } catch (error) {
    const fallbackReason = `model request failed: ${String(error?.message || error).slice(0, 300)}`;
    return {
      sections: [],
      usage: emptyUsage(config, startedAt, startedMs, fallbackReason),
      fallbackReason
    };
  }

  const endedAt = isoNow();
  const usage = normalizeUsage({
    config,
    startedAt,
    startedMs,
    endedAt,
    response: responseJson,
    content
  });
  try {
    const parsed = parseContent(content);
    validateNarrative(evidence, parsed);
    return { sections: parsed.sections, usage };
  } catch (error) {
    return {
      sections: [],
      usage,
      fallbackReason: `narrative validation failed: ${String(error?.message || error).slice(0, 300)}`
    };
  }
}
