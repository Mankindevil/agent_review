import test from 'node:test';
import assert from 'node:assert/strict';
import { getPandaDataStatus, pandaDataConfig, queryPandaData } from '../src/panda-data.js';

const configuredEnv = {
  PANDA_DATA_ENABLED: 'true',
  PANDA_DATA_AUTO_VERIFY: 'true',
  PANDA_DATA_USERNAME: '8613800000000',
  PANDA_DATA_PASSWORD: 'test-password',
  PANDA_DATA_ACCESS_KEY: 'gateway-key',
  PANDA_DATA_BASE_URL: 'https://data.example.test',
  PANDA_DATA_MAX_ROWS: '25',
  PANDA_DATA_TIMEOUT_MS: '9000',
  PANDA_DATA_ALLOWED_METHODS: 'get_trade_cal,get_stock_daily'
};

test('reports PandaAI readiness without exposing account credentials', () => {
  const config = pandaDataConfig(configuredEnv);
  assert.equal(config.ready, true);
  assert.equal(config.autoVerify, true);
  assert.equal(config.maxRows, 25);
  assert.equal(config.baseUrl, 'https://data.example.test');
  assert.deepEqual(config.allowedMethods, ['get_trade_cal', 'get_stock_daily']);
  const publicFields = ['provider', 'enabled', 'configured', 'ready', 'accessProtected'];
  assert.deepEqual(publicFields.map((key) => config[key]), ['pandaai', true, true, true, true]);
});

test('normalizes a mainland mobile account to the SDK 86-prefixed format', () => {
  const config = pandaDataConfig({
    ...configuredEnv,
    PANDA_DATA_USERNAME: '13800000000'
  });
  assert.equal(config.username, '8613800000000');
});

test('rejects disabled, incomplete and non-whitelisted Panda Data calls', async () => {
  await assert.rejects(() => queryPandaData('get_trade_cal', {}, { env: {} }), /未启用/);
  await assert.rejects(() => queryPandaData('get_trade_cal', {}, { env: { PANDA_DATA_ENABLED: 'true' } }), /未配置完整/);
  await assert.rejects(() => queryPandaData('eval', {}, { env: configuredEnv }), /不在白名单/);
  await assert.rejects(() => queryPandaData('get_trade_cal', [], { env: configuredEnv }), /params 必须/);
});

test('passes only validated calls to the Panda Data bridge', async () => {
  let received;
  const result = await queryPandaData('get_trade_cal', { start_date: '20250101', end_date: '20250103' }, {
    env: configuredEnv,
    bridgeRunner: async (input) => {
      received = input;
      return { provider: 'pandaai', method: input.method, rowCount: 3, truncated: false, data: [] };
    }
  });
  assert.equal(received.method, 'get_trade_cal');
  assert.equal(received.config.username, configuredEnv.PANDA_DATA_USERNAME);
  assert.equal(result.rowCount, 3);
});

test('supports a non-secret package probe status', async () => {
  const status = await getPandaDataStatus({
    env: configuredEnv,
    probe: true,
    bridgeRunner: async () => ({ installed: true })
  });
  assert.equal(status.installed, true);
  assert.equal(status.ready, true);
  assert.equal('username' in status, false);
  assert.equal('password' in status, false);
});
