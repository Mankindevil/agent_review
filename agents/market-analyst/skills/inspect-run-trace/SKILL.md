---
name: inspect-run-trace
description: Use when a caller needs to audit an existing market-analysis run, including its tools, Panda calls, timing, token cost, errors, artifact hashes, or conclusion lineage.
allowed-tools: [run-store]
financial-data-source: panda_data-only
trading: prohibited
---

# Inspect a run trace

Read an authorized persisted trace without starting a new analysis.

## Input contract

Accept only `operation: inspect-run-trace` and a nonempty bounded `runId`. Require
Bearer authentication and an exact persisted owner-scope match. Return not-found for
missing or inaccessible runs so ownership cannot be enumerated.

## Workflow

1. Use `run-store` to load the exact run and verify its persisted owner scope.
2. Select only its `run-trace.json` artifact; do not call the market worker,
   orchestrator, model, mailer, or any analytical tool.
3. Sanitize secrets and credentials, enforce response bounds, and preserve recorded
   sequence, timestamps, metrics, errors, hashes, and lineage.
4. Return the persisted snapshot or a structured not-found/integrity error.

## Panda-only financial data boundary

This Skill makes no new financial-data request. The trace may describe historical
calls whose sole financial-data source was `panda_data`; never enrich or reconcile it
with an external feed. Do not fabricate a missing trace or missing evidence.

## Freshness and output contract

Report the run's recorded report date, creation/update times, freshness decisions,
coverage, and missing-data decisions as historical facts. Do not refresh stale data.
Return bounded JSON containing run status, tools, Panda calls, rows/cache/retries,
latency, errors, model tokens/cost, artifact hashes, delivery state, and
conclusion-to-source lineage. Redact authentication, passwords, keys, and raw secrets.

## Safety

This output is research-only operational evidence, not investment advice. Never
place orders, execute portfolios, alter the stored run, promise returns, or infer
trading intent from audit records.
