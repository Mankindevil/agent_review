import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('live smoke fails closed until Panda is explicitly enabled with credentials', async () => {
  const {
    validateSmokeEnvironment
  } = await import('../scripts/market-agent-live-smoke.js');
  assert.throws(
    () => validateSmokeEnvironment({}),
    (error) => error?.code === 'SMOKE_NOT_CONFIGURED'
  );
  assert.throws(
    () => validateSmokeEnvironment({
      PANDA_DATA_ENABLED: 'true',
      PANDA_DATA_USERNAME: 'configured'
    }),
    (error) => error?.code === 'SMOKE_NOT_CONFIGURED'
  );
});

test('live smoke summary is bounded and redacts credential-shaped data', async () => {
  const {
    sanitizeSmokeSummary
  } = await import('../scripts/market-agent-live-smoke.js');
  const secret = 'never-print-this-credential';
  const summary = sanitizeSmokeSummary({
    status: 'COMPLETE',
    authorization: `Bearer ${secret}`,
    password: secret,
    error: new Error(secret),
    huge: 'x'.repeat(50_000),
    nested: { token: secret }
  });
  const output = JSON.stringify(summary);
  assert.ok(Buffer.byteLength(output) <= 16 * 1024);
  assert.doesNotMatch(output, new RegExp(secret));
  assert.doesNotMatch(output, /Bearer/i);
});

test('live smoke contract uses bounded Panda, ephemeral loopback A2A, and opt-in email', async () => {
  const source = await readFile(
    new URL('../scripts/market-agent-live-smoke.js', import.meta.url),
    'utf8'
  );
  assert.match(source, /topN:\s*3/);
  assert.match(source, /host:\s*'127\.0\.0\.1'/);
  assert.match(source, /port:\s*0/);
  assert.match(source, /MARKET_SMOKE_EMAIL_TO/);
  assert.match(source, /daily-market-report/);
  assert.match(source, /validateEvidencePack/);
  assert.match(source, /version\(['"]panda-data['"]\)/);
  assert.match(source, /['"]0\.0\.12['"]/);
  assert.doesNotMatch(source, /console\.(?:log|error)\(\s*process\.env/);
});
