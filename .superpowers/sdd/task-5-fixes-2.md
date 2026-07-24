# Task 5 metric snapshot rereview fix

## Scope

This pass closes the one remaining Important finding from the Task 5 fix
rereview. It is limited to the objective metric aggregation boundary, focused
regressions, and this fix record. It does not add Task 6 pipeline behavior.

## Root cause

The prior aggregate closure used `Object.keys()`, which omitted symbol and
non-enumerable properties. It then repeatedly read the caller's metric fields
during ID, weight, coherence, result, and aggregate calculations.

An enumerable `score` getter could therefore return coherent values during
validation and a different value during result construction. Freezing the
caller object did not convert the accessor to a data property. The aggregate
both executed caller code and could return a score inconsistent with its
numerator and denominator.

## Fix

Every metric now crosses one descriptor-snapshot boundary before any metric
field is read or validated:

1. `Reflect.ownKeys()` must return exactly the nine canonical string fields:
   `id`, `weight`, `applicable`, `coverage`, `score`, `numerator`,
   `denominator`, `evidenceIds`, and `gaps`.
2. Symbols, hidden or extra fields, and missing fields are rejected.
3. Each canonical field must have an own, enumerable data descriptor.
   Accessor and inherited fields are rejected.
4. Each `descriptor.value` is copied once into a fresh record.
5. ID, weight, arithmetic, evidence, status, result construction, and aggregate
   calculations read only that snapshot.

The existing per-item validation for `evidenceIds` and `gaps` remains in place,
and result construction still creates fresh arrays.

## TDD evidence

Before the production change, the focused objective suite reported 23 passed
and 2 failed:

- the frozen dynamic `score` getter was accepted rather than rejected; and
- hidden and symbol extras were accepted.

The canonical deeply frozen data-descriptor regression already passed, proving
the desired valid baseline.

After the descriptor snapshot:

- the dynamic getter is rejected with its read counter exactly zero;
- hidden and symbol extras are rejected; and
- canonical deeply frozen metrics still aggregate to the expected complete
  result.

The focused objective suite then passed 25 of 25 tests.

## Verification

Fresh pre-commit verification:

- Task 5 focused suite: 72 passed, 0 failed.
- Full repository suite: 302 passed, 0 failed.
- `npm run check`: syntax passed for all 63 JavaScript files.
- `git diff --check`: passed.
- `npm ls ajv --depth=0`: exact `ajv@8.17.1`.
