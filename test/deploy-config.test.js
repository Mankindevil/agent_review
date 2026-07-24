import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (name) => readFile(new URL(`../deploy/${name}`, import.meta.url), 'utf8');

test('systemd runs as the dedicated user with the root-managed environment-file path', async () => {
  const unit = await read('agent-review.service');
  assert.match(unit, /^User=agent-review$/m);
  assert.match(unit, /^EnvironmentFile=\/etc\/agent-review\/agent-review\.env$/m);
  assert.match(unit, /^ReadWritePaths=\/var\/lib\/agent-review$/m);
  assert.match(unit, /^Restart=on-failure$/m);
});

test('nginx keeps ACME on HTTP and proxies production through TLS', async () => {
  const bootstrap = await read('nginx-bootstrap.conf');
  const production = await read('nginx-production.conf');
  assert.match(bootstrap, /\/\.well-known\/acme-challenge\//);
  assert.match(production, /listen 443 ssl http2/);
  assert.match(production, /proxy_pass http:\/\/127\.0\.0\.1:4173/);
  assert.match(production, /proxy_send_timeout 1260s/);
  assert.match(production, /proxy_read_timeout 1260s/);
  assert.match(production, /ssl_certificate \/etc\/letsencrypt\/live\/__PUBLIC_IP__\/fullchain\.pem/);
  assert.match(production, /return 301 https:\/\/__PUBLIC_IP__\$request_uri;/);
});

test('certbot timer renews twice daily and reloads nginx', async () => {
  const service = await read('agent-review-certbot.service');
  const timer = await read('agent-review-certbot.timer');
  assert.match(service, /certbot renew --quiet --deploy-hook/);
  assert.match(service, /\/usr\/sbin\/nginx -s reload/);
  assert.match(timer, /OnUnitActiveSec=12h/);
});

test('market analyst service is hardened and writes only under managed state', async () => {
  const unit = await read('market-analyst.service');
  assert.match(unit, /^Type=simple$/m);
  assert.match(unit, /^User=agent-review$/m);
  assert.match(unit, /^Group=agent-review$/m);
  assert.match(unit, /^WorkingDirectory=\/opt\/agent-review\/app$/m);
  assert.match(unit, /^EnvironmentFile=\/etc\/agent-review\/agent-review\.env$/m);
  assert.match(
    unit,
    /^ExecStart=\/usr\/bin\/env MARKET_REPORT_STATE_DIR=\/var\/lib\/agent-review\/market-analyst \/usr\/bin\/npm run market-agent$/m
  );
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^ReadWritePaths=\/var\/lib\/agent-review$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^NoNewPrivileges=true$/m);
});

test('market report oneshot and timer preserve Shanghai trading-day semantics', async () => {
  const service = await read('market-report.service');
  const timer = await read('market-report.timer');
  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /^User=agent-review$/m);
  assert.match(service, /^WorkingDirectory=\/opt\/agent-review\/app$/m);
  assert.match(service, /^EnvironmentFile=\/etc\/agent-review\/agent-review\.env$/m);
  assert.match(
    service,
    /^ExecStart=\/usr\/bin\/env MARKET_REPORT_STATE_DIR=\/var\/lib\/agent-review\/market-analyst \/usr\/bin\/npm run market-report$/m
  );
  assert.match(service, /^ReadWritePaths=\/var\/lib\/agent-review$/m);
  assert.match(timer, /^OnCalendar=Mon\.\.Fri \*-\*-\* 18:30:00 Asia\/Shanghai$/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.match(timer, /^RandomizedDelaySec=30$/m);
  assert.match(timer, /^AccuracySec=1s$/m);
  assert.match(timer, /^Unit=market-report\.service$/m);
});

test('market deployment units contain no embedded credential values', async () => {
  const units = await Promise.all([
    read('market-analyst.service'),
    read('market-report.service'),
    read('market-report.timer')
  ]);
  const combined = units.join('\n');
  assert.doesNotMatch(
    combined,
    /(?:PANDA_DATA_(?:USERNAME|PASSWORD)|MARKET_AGENT_ACCESS_TOKEN|MARKET_REPORT_SMTP_PASSWORD)=\S+/i
  );
  assert.doesNotMatch(combined, /Authorization:\s*Bearer/i);
});

test('production operations never shell-source the protected systemd environment', async () => {
  const guide = await readFile(
    new URL('../docs/PRODUCTION_OPERATIONS.md', import.meta.url),
    'utf8'
  );
  assert.doesNotMatch(guide, /(?:^|[;&|]\s*)(?:source|\.)\s+\/etc\/agent-review\/agent-review\.env/m);
  assert.match(guide, /systemd-run/);
  assert.match(guide, /EnvironmentFile=\/etc\/agent-review\/agent-review\.env/);
  assert.doesNotMatch(guide, /--setenv=MARKET_SMOKE_(?:STATE_DIR|EMAIL_TO)/);
  assert.match(
    guide,
    /\/usr\/bin\/env MARKET_SMOKE_STATE_DIR= MARKET_SMOKE_EMAIL_TO= \/usr\/bin\/npm run market:smoke/
  );
  assert.match(
    guide,
    /\/usr\/bin\/env MARKET_SMOKE_STATE_DIR=\/var\/lib\/agent-review\/market-smoke 'MARKET_SMOKE_EMAIL_TO=<explicit test inbox>' \/usr\/bin\/npm run market:smoke/
  );
});
