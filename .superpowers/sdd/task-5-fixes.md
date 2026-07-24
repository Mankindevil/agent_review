# Task 5 independent-review fixes

## Scope

This pass closes all five Important findings in the Task 5 independent review.
It is limited to acceptance evaluation, objective scoring, confidence
calculation, their focused tests, and this fix record. It does not add the
Task 6 pipeline.

## Fixes

### 1. Descriptor-safe inert JSON candidates

Structured candidate discovery now reads `data`, `artifacts`, `parts`, and Part
discriminators only through own, enumerable data descriptors. Inherited,
accessor-backed, hidden, sparse, symbolic, or otherwise malformed containers
are rejected without reading their property values through normal access.

Before Ajv or numeric evaluation sees a candidate, the value is recursively
cloned through descriptors into inert JSON. The clone accepts only JSON
primitives with finite numbers, dense arrays, and plain or null-prototype
objects. It rejects accessors, non-enumerable or symbol properties, class
instances, cycles, sparse arrays, extra array keys, and non-finite numbers.
Property getters are never invoked during this path.

### 2. Composable confidence results

`computeDimensionConfidence()` now accepts the successful tagged result
returned by `computeSubcriterionConfidence()`. It validates the optional
`components` field but projects the input into a fresh `{ status, value }`
record, so caller-owned component objects are neither rejected nor aliased.

### 3. Deterministic pending-state propagation

Dimension and total confidence use one explicit priority:

```text
pending-model-review
> pending-human-review
> unavailable
> complete
```

All relevant statuses are collected before selection. Missing named dimensions
participate as `unavailable`, so input order and dimension assignment cannot
mask a higher-priority pending state.

### 4. Closed acceptance observation types

Normalized objective observations accept exactly `model`, `contains`, `exact`,
`json-schema`, and `numeric`. Every check must own all four required fields:
`id`, `type`, `required`, and `status`. Unknown and missing types are rejected
before score construction.

### 5. Closed and coherent aggregate metrics

Aggregate inputs must contain exactly the nine canonical metric fields and the
rubric-defined weight for their metric ID. Unknown fields and reweighted inputs
are rejected rather than silently projected.

Arithmetic invariants are enforced:

- a non-applicable metric has exact zero coverage, numerator, and denominator,
  and a null score;
- a zero denominator requires an exact zero numerator and null score;
- a positive denominator requires a finite score;
- efficiency uses `score = numerator / denominator`;
- the other five metrics use `score = numerator / denominator * 100`.

Computed-score comparison uses a relative tolerance of
`1e-12 * max(1, abs(expected))`; exact zero/null rules do not use a tolerance.
The result is rebuilt from the canonical field allowlist and receives fresh
`evidenceIds` and `gaps` arrays, eliminating caller aliases.

## TDD evidence

Each production change followed a focused failing regression:

- Acceptance: 11 passed / 4 failed before the descriptor-safe candidate fix;
  15 passed / 0 failed afterward.
- Confidence: 10 passed / 3 failed before composability and precedence fixes;
  13 passed / 0 failed afterward. The precedence tests cover every relevant
  permutation and dimension assignment.
- Acceptance observation types: 18 passed / 1 failed before the type allowlist;
  19 passed / 0 failed afterward.
- Aggregate contract: 20 passed / 2 failed before closed-field, weight, and
  arithmetic validation; 22 passed / 0 failed afterward. The already-passing
  no-alias regression additionally proves the canonical result is independently
  mutable when the caller input is deeply frozen.

## Verification

Fresh pre-commit verification:

- Task 5 focused suite: 69 passed, 0 failed.
- Full repository suite: 299 passed, 0 failed.
- `npm run check`: syntax passed for all 63 JavaScript files.
- `git diff --check`: passed.
- `npm ls ajv --depth=0`: exact `ajv@8.17.1`.
