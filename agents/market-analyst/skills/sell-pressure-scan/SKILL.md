---
name: sell-pressure-scan
description: Use when a caller asks for A-share securities showing converging sell-pressure, distribution, liquidity-risk, or downside market-behavior signals.
allowed-tools: [panda-market-worker, report-renderer, report-validator, narrative-adapter]
financial-data-source: panda_data-only
trading: prohibited
---

# Scan for sell pressure

Rank observable market-behavior risk without claiming to identify a seller.

## Input contract

Accept `operation: sell-pressure-scan`, an optional completed Shanghai trading-day
`date`, and bounded `topN`. Reject arbitrary sections, open/future dates, external
sources, tool overrides, and requests to identify or act against market participants.

## Workflow

1. Use `panda-market-worker` to execute the fixed daily Panda query plan, enforce the
   A-share universe and liquidity floor, and project only sell-pressure results.
2. Apply the fixed directional components for adverse price/volume behavior,
   turnover, capital-flow pressure, technical deterioration, and available risk
   evidence. Rank deterministically with stable tie-breaking.
3. Require configured history and component coverage. Exclude insufficient records;
   disclose stale, partial, optional, or absent inputs and reduce confidence instead
   of imputing values.
4. Use `report-renderer`, optional evidence-bound `narrative-adapter`, and
   `report-validator` to render and validate the projection.

## Panda-only financial data boundary

Use `panda_data` as the only financial-data source. Never supplement flows, prices,
holdings, events, or identity evidence from another source. Do not infer unknown
sellers, fabricate missing observations, or convert absence into a negative signal.

## Output and trace contract

Return the Markdown sell-pressure section plus projected `evidence-pack.json` and
`run-trace.json`. Include ranks, symbols/names, component scores and directions,
coverage, confidence, risk flags, freshness, missing data, and source IDs. Trace
Panda calls, rows, cache/retries, timing, errors, hashes, model tokens/cost, effective
weights, and each conclusion's evidence lineage.

## Safety

This output is a research-only watchlist and is not investment advice or proof of
misconduct. Never place orders, execute portfolios, label an unknown person or entity
as the seller, promise loss avoidance, or issue sell instructions.
