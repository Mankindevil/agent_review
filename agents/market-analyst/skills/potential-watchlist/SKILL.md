---
name: potential-watchlist
description: Use when a caller asks for evidence-ranked A-share research candidates based on trend, theme, quality, valuation, capital, liquidity, and risk factors.
allowed-tools: [panda-market-worker, report-renderer, report-validator, narrative-adapter]
financial-data-source: panda_data-only
trading-execution: prohibited
portfolio-execution: prohibited
missing-data-fabrication: prohibited
research-use: only
score-components: [trend=0.25, theme=0.15, quality=0.20, valuation=0.15, capital=0.15, liquidity_stability=0.10]
risk-adjustment: separate-penalty
vetoes: [ST_OR_DELISTING_RISK, NONSTANDARD_AUDIT, LARGE_UNLOCK_30D]
minimum-components: 4
minimum-component-weight-coverage: 0.70
---

# Build the potential research watchlist

Rank candidates for further research while keeping upside evidence separate from risk.

## Input contract

Accept `operation: potential-watchlist`, an optional completed Shanghai trading-day
`date`, and bounded `topN`. Reject open/future dates, arbitrary sections, external
data, tool overrides, portfolio constraints, and order or allocation requests.

## Deterministic workflow

1. Use `panda-market-worker` to execute the fixed daily Panda plan, apply the A-share
   universe and minimum-liquidity gate, and project only the potential watchlist.
2. Apply exactly `trend` 0.25, `theme` 0.15, `quality` 0.20, `valuation` 0.15,
   `capital` 0.15, and `liquidity_stability` 0.10 with fixed normalization,
   directions, and stable tie-breaking. Subtract `risk_penalty` only after the base
   score; risk is not a seventh base component.
3. Veto ST/delisting-risk names, nonstandard-audit names, and names whose
   `unlock_float_pct_30d` exceeds 10%, using the runtime veto codes declared above.
4. Render with `report-renderer`, optionally summarize only Evidence Pack facts with
   `narrative-adapter`, then gate the projection through `report-validator`.

## Panda-only financial data boundary

Use `panda_data` as the only financial-data source. Do not supplement fundamentals,
valuation, prices, flows, events, or risk data from another provider. Never fabricate
missing factors or treat unavailable data as neutral evidence.

## Freshness, coverage, and missing-data rules

Require the configured history, at least four of the six base components, and at
least 0.70 available component-weight coverage. Vetoed or insufficient candidates
must not be presented as ranked. Mark stale, partial, optional, and missing values;
adjust effective weights only where policy permits, never by imputation.

## Output schema and trace requirements

Return the Markdown potential-watchlist section plus projected
`evidence-pack.json` and `run-trace.json`. Include ranks, symbols/names, factor
scores, effective weights, coverage, confidence, valuation/risk context, freshness,
missing-data disclosures, and source IDs. Trace Panda calls, rows, cache/retries,
timing, errors, hashes, model tokens/cost, and conclusion-to-source lineage.

## Research-only safety boundary

This is a research-only candidate list, not investment advice, a return forecast, or
a portfolio. Never place orders, execute/rebalance portfolios, prescribe allocations,
promise returns, or translate ranks into buy instructions.
