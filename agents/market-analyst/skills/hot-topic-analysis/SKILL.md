---
name: hot-topic-analysis
description: Use when a caller asks which A-share industries or concepts are hottest, how themes are rotating, or why current market behavior supports a topic ranking.
allowed-tools: [panda-market-worker, report-renderer, report-validator, narrative-adapter]
financial-data-source: panda_data-only
trading-execution: prohibited
portfolio-execution: prohibited
missing-data-fabrication: prohibited
research-use: only
score-components: [ret1=0.25, ret5=0.20, breadth5=0.20, turnover_heat=0.15, acceleration=0.15, lhb_activity=0.05]
required-components: [ret1, ret5, breadth5, turnover_heat, acceleration]
optional-components: [lhb_activity]
minimum-constituents: 5
minimum-constituent-price-coverage: 0.80
---

# Analyze hot topics

Rank industries and concepts from observable market behavior, not news popularity.

## Input contract

Accept `operation: hot-topic-analysis`, an optional completed Shanghai trading-day
`date`, and bounded `topN`. Reject arbitrary sections, external sources, tool
overrides, open/future sessions, and unsupported fields.

## Deterministic workflow

1. Use `panda-market-worker` to run the internal daily query plan, then project only
   the hot-topic section.
2. Apply exactly `ret1` 0.25, `ret5` 0.20, `breadth5` 0.20,
   `turnover_heat` 0.15, `acceleration` 0.15, and optional `lhb_activity` 0.05.
   Require the five non-LHB components. If LHB is unavailable, redistribute its
   weight across the five required components and record effective weights.
3. Use `report-renderer`, optional evidence-bound `narrative-adapter`, and
   `report-validator` to produce and validate the section projection.

## Panda-only financial data boundary

Use `panda_data` as the only financial-data source. Do not browse for market news or
supplement the rank with another price, flow, fundamentals, or sentiment feed. Never
fabricate observations or reasons for missing data.

## Freshness, coverage, and missing-data rules

Require the configured history window, at least five constituents, and at least 80%
constituent price coverage for each industry/concept. This 80% gate is not
component-weight coverage. Independently require all five non-LHB score components.
Exclude ineligible topics; mark stale, partial, or absent inputs as missing and never
impute them.

## Output schema and trace requirements

Return the requested Markdown hot-topic section plus projected
`evidence-pack.json` and `run-trace.json`. Include ranks, component scores, effective
weights, coverage, confidence, rotation/persistence evidence, source IDs, freshness,
and missing-data disclosures. Record Panda calls, rows, cache/retry state, timing,
errors, hashes, model tokens/cost, and conclusion-to-source lineage.

## Research-only safety boundary

This output is research-only and is not investment advice. A hot topic is not a buy
recommendation. Never place orders, execute portfolios, promise returns, or invent
events to explain market behavior.
