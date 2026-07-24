---
name: potential-watchlist
description: Use when a caller asks for evidence-ranked A-share research candidates based on trend, theme, quality, valuation, capital, liquidity, and risk factors.
allowed-tools: [panda-market-worker, report-renderer, report-validator, narrative-adapter]
financial-data-source: panda_data-only
trading: prohibited
---

# Build the potential research watchlist

Rank candidates for further research while keeping upside evidence separate from risk.

## Input contract

Accept `operation: potential-watchlist`, an optional completed Shanghai trading-day
`date`, and bounded `topN`. Reject open/future dates, arbitrary sections, external
data, tool overrides, portfolio constraints, and order or allocation requests.

## Workflow

1. Use `panda-market-worker` to execute the fixed daily Panda plan, apply the A-share
   universe and minimum-liquidity gate, and project only the potential watchlist.
2. Apply deterministic trend, theme, quality, valuation, capital, liquidity, and risk
   components with fixed normalization, directions, weights, and stable tie-breaking.
3. Require the configured history and per-component coverage. Exclude candidates
   below required coverage. Mark stale, partial, optional, and missing values; adjust
   effective weights and confidence only where the policy permits, never by imputation.
4. Render with `report-renderer`, optionally summarize only Evidence Pack facts with
   `narrative-adapter`, then gate the projection through `report-validator`.

## Panda-only financial data boundary

Use `panda_data` as the only financial-data source. Do not supplement fundamentals,
valuation, prices, flows, events, or risk data from another provider. Never fabricate
missing factors or treat unavailable data as neutral evidence.

## Output and trace contract

Return the Markdown potential-watchlist section plus projected
`evidence-pack.json` and `run-trace.json`. Include ranks, symbols/names, factor
scores, effective weights, coverage, confidence, valuation/risk context, freshness,
missing-data disclosures, and source IDs. Trace Panda calls, rows, cache/retries,
timing, errors, hashes, model tokens/cost, and conclusion-to-source lineage.

## Safety

This is a research-only candidate list, not investment advice, a return forecast, or
a portfolio. Never place orders, execute/rebalance portfolios, prescribe allocations,
promise returns, or translate ranks into buy instructions.
