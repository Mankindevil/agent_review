---
name: sell-pressure-scan
description: Use when a caller asks for A-share securities showing converging sell-pressure, distribution, liquidity-risk, or downside market-behavior signals.
allowed-tools: [panda-market-worker, report-renderer, report-validator, narrative-adapter]
financial-data-source: panda_data-only
trading-execution: prohibited
missing-data-fabrication: prohibited
research-use: only
score-components: [downside_volume=0.25, lhb_net_sell=0.25, northbound_reduction=0.20, margin_contraction=0.15, discount_event=0.15]
minimum-components: 3
---

# Scan for sell pressure

Rank observable market-behavior risk without claiming to identify a seller.

## Input contract

Accept `operation: sell-pressure-scan`, an optional completed Shanghai trading-day
`date`, and bounded `topN`. Reject arbitrary sections, open/future dates, external
sources, tool overrides, and requests to identify or act against market participants.

## Deterministic workflow

1. Use `panda-market-worker` to execute the fixed daily Panda query plan, enforce the
   A-share universe and liquidity floor, and project only sell-pressure results.
2. Apply exactly these authoritative components and weights:
   `downside_volume` 0.25, `lhb_net_sell` 0.25,
   `northbound_reduction` 0.20, `margin_contraction` 0.15, and
   `discount_event` 0.15. Require at least three available components, normalize
   available weights, and rank deterministically with stable tie-breaking.
3. Use `report-renderer`, optional evidence-bound `narrative-adapter`, and
   `report-validator` to render and validate the projection.

## Panda-only financial data boundary

Use `panda_data` as the only financial-data source. Never supplement flows, prices,
holdings, events, or identity evidence from another source. Do not infer unknown
sellers, fabricate missing observations, or convert absence into a negative signal.

## Freshness, coverage, and missing-data rules

Require the configured history and at least three of the five authoritative
components. Mark rows with fewer than three available components
`EVIDENCE_INSUFFICIENT`; do not rank them. Disclose stale, partial, optional, or
absent inputs and reduce coverage rather than imputing values.

## Output schema and trace requirements

Return the Markdown sell-pressure section plus projected `evidence-pack.json` and
`run-trace.json`. Include ranks, symbols/names, component scores and directions,
coverage, confidence, risk flags, freshness, missing data, and source IDs. Trace
Panda calls, rows, cache/retries, timing, errors, hashes, model tokens/cost, effective
weights, and each conclusion's evidence lineage.

## Research-only safety boundary

This output is a research-only watchlist and is not investment advice or proof of
misconduct. Never place orders, execute portfolios, label an unknown person or entity
as the seller, promise loss avoidance, or issue sell instructions.
