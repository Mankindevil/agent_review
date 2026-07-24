# Task 5 nested metric-array rereview fix

## Scope

This pass closes the remaining Important nested-array finding from the second
Task 5 rereview. It is limited to descriptor-safe snapshots for aggregate
metric `evidenceIds` and `gaps`, focused regressions, and this fix record. It
does not add Task 6 pipeline behavior.

## Root cause

The top-level metric descriptor snapshot copied each field value into a fresh
record, but `evidenceIds` and `gaps` remained references to caller-owned arrays.
Metric validation iterated those arrays once and canonical result construction
iterated them again.

A frozen array can retain an accessor index. Such a getter could return a valid
string during validation and a non-string during result construction. The
aggregate therefore still executed caller code after its declared snapshot and
could return a value that violated the validated contract.

Ordinary iteration also ignored hidden, symbol, and extra array properties, so
the nested containers were not structurally closed.

## Fix

`snapshotMetric()` now sends `evidenceIds` and `gaps` through a descriptor-safe
string-array snapshot during the top-level snapshot:

1. The value must be an actual array.
2. `Reflect.ownKeys()` may contain only the standard own `length` property and
   the complete dense set of canonical decimal index strings.
3. Symbol, hidden-extra, enumerable-extra, non-canonical-index, and sparse
   arrays are rejected.
4. Every index must be an own, enumerable data descriptor. Index accessors are
   rejected without invocation.
5. Every `descriptor.value` must be a primitive string.
6. Evidence values are validated as safe evidence identifiers; gap values use
   the existing string contract.
7. Values are copied into fresh plain arrays, and all later validation,
   deduplication, result construction, and aggregation read only those
   snapshots.

Canonical result construction continues to create its own arrays, so neither
the snapshot nor result aliases caller arrays.

## TDD evidence

Before the production change, the focused objective suite reported 26 passed
and 3 failed:

- the frozen dynamic gap getter was accepted;
- the frozen evidence getter executed twice; and
- non-canonical hidden, symbol, extra, or index structures bypassed closure.

The positive deeply frozen canonical array/no-alias regression passed before
the change, establishing the valid baseline.

After the fix, the objective suite passed 29 of 29:

- both frozen index getters are rejected with read counters exactly zero;
- hidden, symbol, enumerable-extra, non-enumerable-index, and sparse cases are
  rejected for both array fields; and
- deeply frozen canonical arrays are accepted and remain unaliased.

## Verification

Fresh pre-commit verification:

- Task 5 focused suite: 76 passed, 0 failed.
- Full repository suite: 306 passed, 0 failed.
- `npm run check`: syntax passed for all 63 JavaScript files.
- `git diff --check`: passed.
- `npm ls ajv --depth=0`: exact `ajv@8.17.1`.
