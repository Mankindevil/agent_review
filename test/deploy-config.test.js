import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (name) => readFile(new URL(`../deploy/${name}`, import.meta.url), 'utf8');
const readDoc = (name) => readFile(new URL(`../docs/${name}`, import.meta.url), 'utf8');

const exactLocation = (config, pathname) => {
  const marker = `location = ${pathname} {`;
  const start = config.indexOf(marker);
  assert.notEqual(start, -1, pathname);
  let depth = 0;
  for (let index = config.indexOf('{', start); index < config.length; index += 1) {
    if (config[index] === '{') depth += 1;
    if (config[index] === '}') depth -= 1;
    if (depth === 0) return config.slice(start, index + 1);
  }
  assert.fail(`unterminated location: ${pathname}`);
};

test('systemd runs as the dedicated user with the root-managed environment-file path', async () => {
  const unit = await read('agent-review.service');
  assert.match(unit, /^User=agent-review$/m);
  assert.match(unit, /^EnvironmentFile=\/etc\/agent-review\/agent-review\.env$/m);
  assert.match(unit, /^ReadWritePaths=\/var\/lib\/agent-review$/m);
  assert.match(unit, /^Restart=on-failure$/m);
});

test('nginx keeps ACME on HTTP and exposes only diagnostics routes through TLS', async () => {
  const bootstrap = await read('nginx-bootstrap.conf');
  const production = await read('nginx-production.conf');
  assert.match(bootstrap, /\/\.well-known\/acme-challenge\//);
  assert.match(production, /listen 443 ssl http2/);
  for (const pathname of [
    '/agent-check',
    '/agent-check.js',
    '/agent-check.css',
    '/api/agent-diagnostics',
    '/api/health'
  ]) {
    assert.match(production, new RegExp(`location = ${pathname.replaceAll('/', '\\/')}\\s*\\{`), pathname);
  }
  assert.match(exactLocation(production, '/agent-check.html'), /return 308 \/agent-check;/);
  assert.match(production, /location \/\s*\{\s*return 404;\s*\}/);
  assert.match(
    exactLocation(production, '/agent-check'),
    /proxy_pass http:\/\/127\.0\.0\.1:4173\/agent-check\.html;/
  );
  assert.match(
    exactLocation(production, '/api/agent-diagnostics'),
    /proxy_pass http:\/\/127\.0\.0\.1:4173;/
  );
  assert.match(production, /proxy_send_timeout 1260s/);
  assert.match(production, /proxy_read_timeout 1260s/);
  assert.match(production, /ssl_certificate \/etc\/letsencrypt\/live\/__PUBLIC_IP__\/fullchain\.pem/);
  assert.match(production, /return 301 https:\/\/__PUBLIC_IP__\$request_uri;/);
});

test('nginx rejects methods outside each public route contract', async () => {
  const production = await read('nginx-production.conf');
  for (const pathname of [
    '/agent-check',
    '/agent-check.html',
    '/agent-check.js',
    '/agent-check.css',
    '/api/health'
  ]) {
    assert.match(
      exactLocation(production, pathname),
      /if \(\$request_method !~ "\^\(GET\|HEAD\)\$"\)\s*\{\s*return 405;/,
      pathname
    );
  }
  assert.match(
    exactLocation(production, '/api/agent-diagnostics'),
    /if \(\$request_method != POST\)\s*\{\s*return 405;/
  );
});

test('certbot timer renews twice daily and reloads nginx', async () => {
  const service = await read('agent-review-certbot.service');
  const timer = await read('agent-review-certbot.timer');
  assert.match(service, /certbot renew --quiet --deploy-hook/);
  assert.match(service, /\/usr\/sbin\/nginx -s reload/);
  assert.match(timer, /OnUnitActiveSec=12h/);
});

test('production operations document the temporary public allowlist and SSH tunnel', async () => {
  const operations = await readDoc('PRODUCTION_OPERATIONS.md');
  assert.match(operations, /Browser diagnostics: <https:\/\/14\.103\.143\.171\/agent-check>/);
  assert.match(operations, /ssh -N -L 4173:127\.0\.0\.1:4173 root@14\.103\.143\.171/);
  assert.match(operations, /require_200 https:\/\/14\.103\.143\.171\/agent-check\.js/);
  assert.match(operations, /require_200 https:\/\/14\.103\.143\.171\/agent-check\.css/);
  assert.match(operations, /require_308 https:\/\/14\.103\.143\.171\/agent-check\.html/);
  assert.match(operations, /require_401_post https:\/\/14\.103\.143\.171\/api\/agent-diagnostics/);
  assert.match(operations, /^require_404 https:\/\/14\.103\.143\.171\/$/m);
  assert.match(operations, /require_404 https:\/\/14\.103\.143\.171\/api\/evaluations/);
  assert.match(operations, /require_404 https:\/\/14\.103\.143\.171\/methodology\.html/);
  assert.match(operations, /\$tunnelStatus[\s\S]*http:\/\/127\.0\.0\.1:4173\/[\s\S]*-ne ['"]200['"]/);
  assert.doesNotMatch(operations, /^require_200 https:\/\/14\.103\.143\.171\/$/m);
});

test('standard release renders, validates, installs, and can roll back nginx', async () => {
  const operations = await readDoc('PRODUCTION_OPERATIONS.md');
  for (const expected of [
    /nginx_template="\$release_dir\/deploy\/nginx-production\.conf"/,
    /sed ['"]s\/__PUBLIC_IP__\/14\.103\.143\.171\/g['"]/,
    /nginx_backup=/,
    /sudo install -o root -g root -m 0644/,
    /sudo nginx -t/,
    /sudo systemctl reload nginx/,
    /if \[ "\$nginx_promoted" -eq 1 \]/,
    /sudo cp -p "\$nginx_backup" "\$nginx_stage"/,
    /sudo mv -Tf "\$nginx_stage" "\$nginx_live"/
  ]) {
    assert.match(operations, expected);
  }
  const render = operations.indexOf('nginx_template="$release_dir/deploy/nginx-production.conf"');
  const backup = operations.indexOf('nginx_backup=');
  const install = operations.indexOf('sudo install -o root -g root -m 0644');
  const validate = operations.indexOf('sudo nginx -t', install);
  const reload = operations.indexOf('sudo systemctl reload nginx', validate);
  assert.ok(render < backup && backup < install && install < validate && validate < reload);
});
