---
name: daily-market-report
description: Use when a caller requests a complete A-share closing report, daily market review, or scheduled end-of-day email with traceable hot-topic, sell-pressure, and potential-watchlist findings.
allowed-tools: [panda-market-worker, report-renderer, report-validator, narrative-adapter]
financial-data-source: panda_data-only
trading: prohibited
---

# Generate the daily market report

Produce a deterministic closing-market research report and its evidence and trace
artifacts.

## Input contract

Accept `operation: daily-market-report`, an optional completed Shanghai trading-day
`date` (`YYYY-MM-DD`), and bounded `topN`. Reject future/open-session dates, caller
tool overrides, arbitrary sections, credentials, or delivery instructions.

## Workflow

1. Use `panda-market-worker` to resolve the last completed trading day and execute
   the fixed Panda query plan.
2. Require the worker's freshness, history-window, universe, liquidity, and component
   coverage checks. Exclude under-covered ranks; degrade the run and disclose optional
   missing data rather than filling gaps.
3. Use `report-renderer` for Markdown, HTML, plain-text email, Evidence Pack, and Run
   Trace artifacts.
4. If configured, use `narrative-adapter` only to summarize facts already present in
   the Evidence Pack. Discard unsupported model text.
5. Use `report-validator`; release no report with invalid figures, sources, freshness,
   disclaimers, or conclusion lineage.

## Panda-only financial data boundary

Use `panda_data` as the only financial-data source. Do not browse, query another
market-data vendor, infer missing observations, or fabricate evidence. Operational
configuration and SMTP receipts are not financial evidence.

## Output and trace contract

Return `market-report.md`, a schema-valid `evidence-pack.json`, and sanitized
`run-trace.json`. The report covers market context, hot industries/concepts,
sell-pressure names, potential research candidates, risks, missing data, methodology,
and a non-advice disclaimer. Trace every conclusion to source IDs and record tools,
Panda calls, rows, cache status, retries, elapsed time, errors, artifact hashes, model
tokens/cost, and effective coverage.

## Safety

This output is research-only and is not investment advice. Never place orders,
execute or rebalance portfolios, identify unknown traders, promise returns, or turn
rankings into buy/sell instructions.
