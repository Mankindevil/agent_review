# Task 6 Report: Orchestrator, SMTP delivery, and one-shot CLI

## Status

Implemented the shared report orchestrator, idempotent SMTP adapter, one-shot CLI,
and the Panda-authoritative non-trading-day `skipped` contract.

## TDD evidence

### RED

1. `node --test test/market-analyst-email.test.js test/market-analyst-integration.test.js`
   failed with `ERR_MODULE_NOT_FOUND` for `smtp-mailer.js` and `orchestrator.js`.
2. The targeted Panda holiday test failed because the worker raised
   `ValueError: 报告日期不是已完成交易日` instead of returning a skipped Evidence Pack.
3. The SMTP receipt-persistence regression failed because an accepted message was
   surfaced as the raw callback error, allowing it to enter SMTP retry handling.
4. The caller-boundary regression failed because `smtpHost` was ignored instead of
   rejected as an SMTP override.

### GREEN

- Focused Task 6 tests:
  `node --test test/market-analyst-email.test.js test/market-analyst-integration.test.js`
  — 14 passed, 0 failed.
- Panda worker tests:
  `C:\Users\Jinting\AppData\Local\Programs\Python\Python310\python.exe test/market-worker/test_market_worker.py`
  — 60 passed, 0 failed.
- Syntax:
  `npm run check`
  — `Syntax OK · 63 JavaScript files`.
- Full repository:
  `PANDA_DATA_PYTHON=C:\Users\Jinting\AppData\Local\Programs\Python\Python310\python.exe npm test`
  — 173 Node tests and 60 Python tests passed.
- `git diff --check` passed.

## Idempotency and failure matrix

| Condition | Report work | Email behavior | Persisted outcome |
|---|---|---|---|
| Complete, first delivery | Worker/model/render once | Up to 3 transient attempts | Complete + sanitized receipt |
| Confirmed repeat | No worker/model/render | No send | `already-sent` |
| Forced repeat | Reuse bounded persisted artifacts | Send with deterministic Message-ID | Updated receipt |
| Report complete, email failed | Reuse persisted report/HTML/trace | Retry email only | Every attempt and final receipt |
| SMTP accepted, receipt callback failed | No in-call resend | Surface sent receipt with persistence error | Prevents SMTP retry duplication |
| Panda holiday | Worker returns `skipped` | No email | Evidence and trace only |
| Optional data failure | Deterministic degraded report | Subject starts `[数据降级]` | Completed task, degraded outcome |
| Core data/invariant failure | No report conclusions | One best-effort operational alert | Failed task + trace |
| Model absent/fails | Deterministic renderer | Normal report delivery | Complete/degraded with fallback evidence |
| Cancellation | Stop current work | No alert/report email | Canceled task |
| Invalid/override input | No lock/worker | No email | Rejected task |

## Security and bounds

- A2A-triggered runs are hard-forced to no email even if a caller supplies
  `deliverEmail=true`.
- Recipient, SMTP, state/cache directory, file, and artifact path override keys are
  rejected recursively. Recipients and SMTP settings come only from trusted config.
- Full recipient addresses and SMTP secrets are absent from task state, traces,
  receipts, CLI output, and errors. Only recipient count/hash and masked error values
  persist.
- The deterministic Message-ID contains only a SHA-256 value and the fixed
  `market-analyst.local` domain.
- SMTP uses verified TLS, fixed timeouts, bounded bodies, and maximum three attempts.
- Artifacts use fixed filenames, a derived state-root path, size checks, mode `0600`,
  fsync, and atomic rename.
- Existing artifacts are size-checked before email-only reuse.
- `接口文档.md` was not modified.

## Files

- `agents/market-analyst/orchestrator.js`
- `agents/market-analyst/smtp-mailer.js`
- `agents/market-analyst/cli.js`
- `agents/market-analyst/run-trace.js`
- `agents/market-analyst/tools/panda_market_worker.py`
- `test/market-analyst-email.test.js`
- `test/market-analyst-integration.test.js`
- `test/market-worker/test_market_worker.py`
- `.superpowers/sdd/task-6-report.md`

## Concerns

- No credentialed live Panda or SMTP delivery was performed; those remain deployment
  smoke-test responsibilities.
- The CLI is intentionally one-shot. The external 18:30 Asia/Shanghai timer wiring is
  a later deployment task; the CLI and orchestrator use the configured Shanghai
  timezone and Panda’s exchange calendar.
