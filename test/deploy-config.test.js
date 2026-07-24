import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (name) => readFile(new URL(`../deploy/${name}`, import.meta.url), 'utf8');
const readDoc = (name) => readFile(new URL(`../docs/${name}`, import.meta.url), 'utf8');

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
  assert.match(production, /location = \/agent-check\.html\s*\{\s*return 308 \/agent-check;\s*\}/);
  assert.match(production, /location \/\s*\{\s*return 404;\s*\}/);
  assert.match(production, /location = \/agent-check\s*\{[^}]*proxy_pass http:\/\/127\.0\.0\.1:4173\/agent-check\.html;/s);
  assert.match(production, /location = \/api\/agent-diagnostics\s*\{[^}]*proxy_pass http:\/\/127\.0\.0\.1:4173;/s);
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

test('production operations document the temporary public allowlist and SSH tunnel', async () => {
  const operations = await readDoc('PRODUCTION_OPERATIONS.md');
  assert.match(operations, /Browser diagnostics: <https:\/\/14\.103\.143\.171\/agent-check>/);
  assert.match(operations, /ssh -N -L 4173:127\.0\.0\.1:4173 root@14\.103\.143\.171/);
  assert.match(operations, /^require_404 https:\/\/14\.103\.143\.171\/$/m);
  assert.match(operations, /require_404 https:\/\/14\.103\.143\.171\/api\/evaluations/);
  assert.match(operations, /require_404 https:\/\/14\.103\.143\.171\/methodology\.html/);
  assert.doesNotMatch(operations, /^require_200 https:\/\/14\.103\.143\.171\/$/m);
});
