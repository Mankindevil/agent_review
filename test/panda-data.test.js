import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPandaDataStatus, pandaDataConfig, queryPandaData } from '../src/panda-data.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridgeFile = path.join(repositoryRoot, 'scripts', 'panda-data-bridge.py');

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

test('isolates Panda SDK user.json from the immutable application directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'panda-bridge-auth-'));
  const appRoot = path.join(root, 'app');
  const packageRoot = path.join(root, 'packages');
  const pandaPackage = path.join(packageRoot, 'panda_data');
  await mkdir(appRoot, { recursive: true });
  await mkdir(pandaPackage, { recursive: true });
  await writeFile(path.join(pandaPackage, 'auth_manager.py'), [
    '_user_json_dir = None',
    'written_path = None',
    ''
  ].join('\n'));
  await writeFile(path.join(pandaPackage, '__init__.py'), [
    'import json',
    'import os',
    'from . import auth_manager',
    '',
    'def init_token(**_kwargs):',
    '    target = auth_manager._user_json_dir or os.getcwd()',
    '    os.makedirs(target, exist_ok=True)',
    '    auth_manager.written_path = os.path.join(target, "user.json")',
    '    with open(auth_manager.written_path, "w", encoding="utf-8") as handle:',
    '        json.dump({"encrypted_credentials": "test-only"}, handle)',
    '    return "test-token"',
    '',
    'def get_trade_cal(**_params):',
    '    return {"auth_path": auth_manager.written_path}',
    ''
  ].join('\n'));

  try {
    const result = await runBridge({
      cwd: appRoot,
      env: {
        PYTHONPATH: packageRoot,
        PANDA_DATA_USERNAME: '8613800000000',
        PANDA_DATA_PASSWORD: 'test-password',
        PANDA_DATA_BASE_URL: 'https://data.example.test',
        PANDA_DATA_ALLOWED_METHODS: 'get_trade_cal',
        PANDA_DATA_MAX_ROWS: '10'
      },
      input: { method: 'get_trade_cal', params: {} }
    });

    assert.equal(result.code, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    const authPath = payload.data.auth_path;
    assert.notEqual(path.dirname(authPath), appRoot);
    assert.equal(existsSync(path.join(appRoot, 'user.json')), false);
    assert.equal(existsSync(authPath), false, 'ephemeral auth directory must be removed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function runBridge({ cwd, env, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PANDA_DATA_PYTHON || 'python3', [bridgeFile], {
      cwd,
      env: {
        PATH: process.env.PATH,
        LANG: 'C.UTF-8',
        PYTHONIOENCODING: 'utf-8',
        ...env
      }
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8')
    }));
    child.stdin.end(JSON.stringify(input));
  });
}
