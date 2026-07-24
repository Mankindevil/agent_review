#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { marketAgentConfig } from './config.js';
import { MarketOrchestrator } from './orchestrator.js';
import { sanitizeTraceValue } from './run-trace.js';
import { createSmtpMailer } from './smtp-mailer.js';

function realDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

export function parseCliArgs(argv) {
  if (!Array.isArray(argv)) throw new TypeError('argv must be an array');
  const result = {
    date: undefined,
    deliverEmail: true,
    forceDelivery: false
  };
  let dateSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--date') {
      if (dateSeen) throw new TypeError('duplicate --date option');
      dateSeen = true;
      const value = argv[index + 1];
      if (!realDate(value)) throw new TypeError('--date must be a real YYYY-MM-DD date');
      result.date = value;
      index += 1;
    } else if (argument === '--force-delivery') {
      result.forceDelivery = true;
    } else if (argument === '--no-email') {
      result.deliverEmail = false;
    } else {
      throw new TypeError(`unknown CLI option: ${argument}`);
    }
  }
  return result;
}

function defaultOrchestrator(config) {
  let mailer;
  if (config.public?.emailConfigured) {
    mailer = createSmtpMailer(config);
  }
  return new MarketOrchestrator(config, { mailer });
}

function exitCode(summary) {
  if (summary?.outcome === 'canceled') return 130;
  if (
    ['scheduled', 'manual'].includes(summary?.trigger)
    && summary?.deliveryRequested === true
    && ['failed', 'artifact-integrity-failed'].includes(summary?.emailStatus)
  ) {
    return 1;
  }
  if (
    ['complete', 'degraded'].includes(summary?.outcome)
    && summary?.emailStatus === 'failed'
  ) {
    return 1;
  }
  return ['complete', 'degraded', 'skipped'].includes(summary?.outcome) ? 0 : 1;
}

export async function runCli(argv, {
  env = process.env,
  cwd = process.cwd(),
  stdout = process.stdout,
  orchestratorFactory = defaultOrchestrator
} = {}) {
  let summary;
  let controller;
  let onInterrupt;
  try {
    const options = parseCliArgs(argv);
    const config = marketAgentConfig(env, cwd);
    const orchestrator = orchestratorFactory(config);
    controller = new AbortController();
    onInterrupt = () => controller.abort(
      Object.assign(new Error('market report canceled'), {
        name: 'AbortError',
        code: 'ABORT_ERR'
      })
    );
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onInterrupt);
    summary = await orchestrator.run({
      operation: {
        operation: 'daily-market-report',
        ...(options.date ? { date: options.date } : {})
      },
      trigger: 'scheduled',
      owner: 'scheduled-cli',
      deliverEmail: options.deliverEmail,
      forceDelivery: options.forceDelivery,
      signal: controller.signal
    });
  } catch (error) {
    summary = {
      outcome: error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
        ? 'canceled'
        : 'failed',
      error: sanitizeTraceValue({
        name: error?.name || 'Error',
        code: error?.code || null,
        message: String(error?.message || error || 'market report CLI failed')
      })
    };
  } finally {
    if (onInterrupt) {
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onInterrupt);
    }
  }
  const safeSummary = sanitizeTraceValue(summary);
  stdout.write(`${JSON.stringify(safeSummary)}\n`);
  return exitCode(safeSummary);
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  process.exitCode = await runCli(process.argv.slice(2));
}
