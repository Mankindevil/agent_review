---
name: hot-topic-analysis
description: Use when a caller asks which A-share industries or concepts are hottest, how themes are rotating, or why current market behavior supports a topic ranking.
allowed-tools: [panda-market-worker, report-renderer, report-validator, narrative-adapter]
financial-data-source: panda_data-only
trading: prohibited
---

# Analyze hot topics

Rank industries and concepts from observable market behavior, not news popularity.

## Input contract

Accept `operation: hot-topic-analysis`, an optional completed Shanghai trading-day
`date`, and bounded `topN`. Reject arbitrary sections, external sources, tool
overrides, open/future sessions, and unsupported fields.

## Workflow

1. Use `panda-market-worker` to run the internal daily query plan, then project only
   the hot-topic section.
2. Score price change, breadth, turnover/volume expansion, persistence, and Panda
   capital-flow evidence with the fixed weights. Treat LHB activity as optional and
   record any effective-weight redistribution.
3. Require the configured history window and at least 80% required-component
   coverage. Exclude under-covered topics. Mark stale, partial, or absent inputs as
   missing; never impute them.
4. Use `report-renderer`, optional evidence-bound `narrative-adapter`, and
   `report-validator` to produce and validate the section projection.

## Panda-only financial data boundary

Use `panda_data` as the only financial-data source. Do not browse for market news or
supplement the rank with another price, flow, fundamentals, or sentiment feed. Never
fabricate observations or reasons for missing data.

## Output and trace contract

Return the requested Markdown hot-topic section plus projected
`evidence-pack.json` and `run-trace.json`. Include ranks, component scores, effective
weights, coverage, confidence, rotation/persistence evidence, source IDs, freshness,
and missing-data disclosures. Record Panda calls, rows, cache/retry state, timing,
errors, hashes, model tokens/cost, and conclusion-to-source lineage.

## Safety

This output is research-only and is not investment advice. A hot topic is not a buy
recommendation. Never place orders, execute portfolios, promise returns, or invent
events to explain market behavior.
