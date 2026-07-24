---
name: daily-market-report
description: Use when a caller requests a complete A-share closing report, daily market review, or scheduled end-of-day email with traceable hot-topic, sell-pressure, and potential-watchlist findings.
allowed-tools: [panda-market-worker, report-renderer, report-validator, narrative-adapter]
financial-data-source: panda_data-only
trading-execution: prohibited
portfolio-execution: prohibited
missing-data-fabrication: prohibited
research-use: only
---

# Generate the daily market report

Produce a deterministic closing-market research report and its evidence and trace
artifacts.

## Input contract

Accept `operation: daily-market-report`, an optional `date` (`YYYY-MM-DD`), and
bounded `topN`. When omitted, the date is the current date in the configured
timezone; it is never replaced with a prior trading day. Reject future/open-session
dates, caller tool overrides, arbitrary sections, credentials, or delivery
instructions.

## Deterministic workflow

1. Use `panda-market-worker` to validate the requested/current date against the
   Shanghai calendar and session close, execute the fixed Panda query plan, and
   produce the schema-valid Evidence Pack.
2. Use `report-renderer` only for Markdown, HTML, and plain-text report bodies.
3. If configured, use `narrative-adapter` only to summarize facts already present in
   the Evidence Pack. Discard unsupported model text.
4. Use `report-validator`; release no report with invalid figures, sources, freshness,
   disclaimers, or conclusion lineage.
5. Let the orchestrator persist the worker-produced Evidence Pack and the collected
   Run Trace alongside the rendered report artifacts.

## Panda-only financial data boundary

Use `panda_data` as the only financial-data source. Do not browse, query another
market-data vendor, infer missing observations, or fabricate evidence. Operational
configuration and SMTP receipts are not financial evidence.

## Freshness, coverage, and missing-data rules

Require the worker's report-date, history-window, universe, liquidity, and component
coverage checks. Exclude under-covered ranks. Degrade the run and disclose optional
missing data rather than filling gaps; fail if required core coverage is unavailable.

## Output schema and trace requirements

Return `market-report.md`, a schema-valid `evidence-pack.json`, and sanitized
`run-trace.json`. The report covers market context, hot industries/concepts,
sell-pressure names, potential research candidates, risks, missing data, methodology,
and a non-advice disclaimer. Trace every conclusion to source IDs and record tools,
Panda calls, rows, cache status, retries, elapsed time, errors, artifact hashes, model
tokens/cost, and effective coverage.

## Research-only safety boundary

This output is research-only and is not investment advice. Never place orders,
execute or rebalance portfolios, identify unknown traders, promise returns, or turn
rankings into buy/sell instructions.
