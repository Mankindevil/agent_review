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

test('nginx keeps ACME on HTTP and exposes only the allowlisted public V1 surface through TLS', async () => {
  const bootstrap = await read('nginx-bootstrap.conf');
  const production = await read('nginx-production.conf');
  assert.match(bootstrap, /\/\.well-known\/acme-challenge\//);
  assert.match(production, /listen 443 ssl http2/);
  assert.match(production, /client_max_body_size 4m;/);
  for (const pathname of [
    '/',
    '/agent-check',
    '/agent-check.js',
    '/agent-check-helpers.js',
    '/example-import.js',
    '/agent-check.css',
    '/favicon.svg',
    '/assets/pandaai-logo.svg',
    '/assets/pandaai-mark.svg',
    '/api/agent-cards/resolve',
    '/api/agent-diagnostics',
    '/api/health'
  ]) {
    assert.match(production, new RegExp(`location = ${pathname.replaceAll('/', '\\/')}\\s*\\{`), pathname);
  }
  assert.match(exactLocation(production, '/agent-check.html'), /return 308 \/agent-check;/);
  for (const pathname of [
    '/app.js',
    '/styles.css',
    '/a2a-ui-helpers.js',
    '/evaluation-actions.js',
    '/example-import.js',
    '/result-v2.js',
    '/rubric-labels.js',
    '/evaluation-version-ui.js',
    '/methodology.html',
    '/methodology.css'
  ]) {
    assert.match(production, new RegExp(`location = ${pathname.replaceAll('/', '\\/')}\\s*\\{`), pathname);
  }
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

test('nginx allows only the public evaluation methods, then rejects destructive and unmatched routes', async () => {
  const production = await read('nginx-production.conf');
  const evaluationCollection = exactLocation(production, '/api/evaluations');
  assert.match(evaluationCollection, /\^\(GET\|HEAD\|POST\)\$/);
  for (const route of [
    String.raw`location ~ ^/api/evaluations/[^/]+$`,
    String.raw`location ~ ^/api/evaluations/[^/]+/(?:events|report\.pdf)$`,
    String.raw`location ~ ^/api/evaluations/[^/]+/builds/[^/]+/skill$`
  ]) {
    assert.match(production, new RegExp(`${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?\\^\\(GET\\|HEAD\\)\\$`), route);
  }
  assert.match(
    production,
    /location ~ \^\/api\/evaluations\/\[\^\/\]\+\$\s*\{\s*if \(\$request_method !~ "\^\(GET\|HEAD\)\$"\) \{ return 405; \}/,
    'DELETE /api/evaluations/:id is rejected by the GET/HEAD-only detail contract'
  );
  for (const route of [
    String.raw`location ~ ^/api/evaluations/[^/]+/(?:cancel|retry)$`
  ]) {
    assert.match(production, new RegExp(`${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?\\$request_method != POST`), route);
  }
  for (const pathname of ['/api/agent-cards/resolve', '/api/agent-diagnostics']) {
    assert.match(exactLocation(production, pathname), /\$request_method != POST/, pathname);
  }
  assert.match(production, /location ~ \^\/api\/\(\?:admin\|internal\|appeals\)\(\?:\/\|\$\)\s*\{\s*return 404;/);
  assert.match(production, /location ~ \^\/api\/evaluations\/\[\^\/\]\+\/\(\?:appeals\|evidence\(\?:-manifest\)\?\)\(\?:\/\|\$\)\s*\{\s*return 404;/);
  assert.match(production, /location \/\s*\{\s*return 404;\s*\}/);
  const tlsFallback = production.slice(production.lastIndexOf('location / {'));
  assert.doesNotMatch(tlsFallback, /proxy_pass http:\/\/127\.0\.0\.1:4173;/);
});

test('nginx rejects methods outside each public route contract', async () => {
  const production = await read('nginx-production.conf');
  for (const pathname of [
    '/agent-check',
    '/agent-check.html',
    '/agent-check.js',
    '/agent-check-helpers.js',
    '/example-import.js',
    '/agent-check.css',
    '/favicon.svg',
    '/assets/pandaai-logo.svg',
    '/assets/pandaai-mark.svg',
    '/api/health'
  ]) {
    assert.match(
      exactLocation(production, pathname),
      /if \(\$request_method !~ "\^\(GET\|HEAD\)\$"\)\s*\{\s*return 405;/,
      pathname
    );
  }
  assert.match(
    exactLocation(production, '/api/agent-cards/resolve'),
    /if \(\$request_method != POST\)\s*\{\s*return 405;/
  );
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

test('production operations document the public V1 allowlist and private V2 access tunnel', async () => {
  const operations = await readDoc('PRODUCTION_OPERATIONS.md');
  assert.match(operations, /Public V1 application: <https:\/\/14\.103\.143\.171\/>/);
  assert.match(operations, /Browser diagnostics: <https:\/\/14\.103\.143\.171\/agent-check>/);
  assert.match(operations, /ssh -N -L 4173:127\.0\.0\.1:4173 root@14\.103\.143\.171/);
  assert.match(operations, /does not pass through the public Nginx allowlist/);
  assert.match(operations, /^require_200 https:\/\/14\.103\.143\.171\/$/m);
  assert.match(operations, /require_200 https:\/\/14\.103\.143\.171\/app\.js/);
  assert.match(operations, /require_200 https:\/\/14\.103\.143\.171\/api\/evaluations/);
  assert.match(operations, /require_200 https:\/\/14\.103\.143\.171\/agent-check\.js/);
  assert.match(operations, /require_200 https:\/\/14\.103\.143\.171\/agent-check\.css/);
  assert.match(operations, /require_308 https:\/\/14\.103\.143\.171\/agent-check\.html/);
  assert.match(operations, /require_401_post https:\/\/14\.103\.143\.171\/api\/agent-diagnostics/);
  assert.match(operations, /require_404 https:\/\/14\.103\.143\.171\/judge\.html/);
  assert.match(operations, /require_404 https:\/\/14\.103\.143\.171\/appeal\.html/);
  assert.match(operations, /require_405_delete https:\/\/14\.103\.143\.171\/api\/evaluations\/release-route-contract/);
  assert.match(operations, /\$tunnelStatus[\s\S]*http:\/\/127\.0\.0\.1:4173\/[\s\S]*-ne ['"]200['"]/);
});

test('standard release renders, validates, installs, and can roll back nginx', async () => {
  const operations = await readDoc('PRODUCTION_OPERATIONS.md');
  for (const expected of [
    /nginx_template="\$release_dir\/deploy\/nginx-production\.conf"/,
    /sed ['"]s\/__PUBLIC_IP__\/14\.103\.143\.171\/g['"]/,
    /nginx_backup=/,
    /environment_backup=/,
    /sudo cp -p "\$environment_live" "\$environment_backup"/,
    /sudo chmod 0600 "\$environment_backup"/,
    /retrieval_key_live=\/root\/agent-review-access-key\.txt/,
    /retrieval_key_state=missing/,
    /if sudo test -e "\$retrieval_key_live" \|\| sudo test -L "\$retrieval_key_live"; then/,
    /sudo test ! -L "\$retrieval_key_live"/,
    /sudo cp -p "\$retrieval_key_live" "\$retrieval_key_backup"/,
    /sudo chown root:root "\$retrieval_key_backup"/,
    /sudo chmod 0600 "\$retrieval_key_backup"/,
    /retrieval_key_state=present/,
    /Record rollback inputs/,
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
  const install = operations.indexOf('sudo install -o root -g root -m 0644', backup);
  const validate = operations.indexOf('sudo nginx -t', install);
  const reload = operations.indexOf('sudo systemctl reload nginx', validate);
  assert.ok(render < backup && backup < install && install < validate && validate < reload);
});

test('explicit rollback restores the recorded release, nginx, and environment in order', async () => {
  const operations = await readDoc('PRODUCTION_OPERATIONS.md');
  const start = operations.indexOf('If post-deployment acceptance fails');
  const end = operations.indexOf('If a switch is interrupted', start);
  assert.ok(start >= 0 && end > start);
  const rollback = operations.slice(start, end);
  for (const expected of [
    /previous_release='<recorded previous release directory>'/,
    /nginx_backup='<recorded nginx backup>'/,
    /environment_backup='<recorded environment backup>'/,
    /retrieval_key_state='<recorded retrieval key state: present or missing>'/,
    /retrieval_key_backup='<recorded retrieval key backup; empty if missing>'/,
    /retrieval_key_live=\/root\/agent-review-access-key\.txt/,
    /validate_env_key "\$environment_backup" "\$retrieval_key_backup"/,
    /sudo ln -s "\$previous_release" "\$app_stage"/,
    /sudo mv -Tf "\$app_stage" "\$app_live"/,
    /sudo cp -p "\$nginx_backup" "\$nginx_stage"/,
    /sudo mv -Tf "\$nginx_stage" "\$nginx_live"/,
    /sudo nginx -t/,
    /sudo systemctl reload nginx/,
    /sudo install -o root -g root -m 0600 "\$environment_backup" "\$environment_stage"/,
    /sudo mv -Tf "\$environment_stage" "\$environment_live"/,
    /sudo chown root:root "\$environment_live"/,
    /sudo chmod 0600 "\$environment_live"/,
    /sudo install -o root -g root -m 0600 "\$retrieval_key_backup" "\$retrieval_key_stage"/,
    /sudo mv -Tf "\$retrieval_key_stage" "\$retrieval_key_live"/,
    /sudo chmod 0600 "\$retrieval_key_live"/,
    /validate_env_key "\$environment_live" "\$retrieval_key_live"/,
    /sudo rm -f -- "\$retrieval_key_live"/,
    /rollback_credentials_ready=1/,
    /sudo systemctl restart agent-review/,
    /wait_for_health/
  ]) {
    assert.match(rollback, expected);
  }
  const orderedCommands = [
    'sudo mv -Tf "$app_stage" "$app_live"',
    'sudo cp -p "$nginx_backup" "$nginx_stage"',
    'sudo mv -Tf "$nginx_stage" "$nginx_live"',
    'sudo nginx -t',
    'sudo systemctl reload nginx',
    'sudo install -o root -g root -m 0600 "$environment_backup" "$environment_stage"',
    'sudo mv -Tf "$environment_stage" "$environment_live"',
    'sudo chmod 0600 "$environment_live"',
    'sudo install -o root -g root -m 0600 "$retrieval_key_backup" "$retrieval_key_stage"',
    'sudo mv -Tf "$retrieval_key_stage" "$retrieval_key_live"',
    'sudo chmod 0600 "$retrieval_key_live"',
    'validate_env_key "$environment_live" "$retrieval_key_live"',
    'sudo systemctl restart agent-review'
  ].map((step) => rollback.indexOf(step));
  const steps = [...orderedCommands, rollback.lastIndexOf('wait_for_health')];
  assert.ok(steps.every((index) => index >= 0));
  assert.deepEqual([...steps].sort((left, right) => left - right), steps);
  const missingStateDeletion = rollback.indexOf('sudo rm -f -- "$retrieval_key_live"');
  const restart = rollback.indexOf('sudo systemctl restart agent-review');
  assert.ok(rollback.indexOf('sudo chmod 0600 "$environment_live"') < missingStateDeletion);
  assert.ok(missingStateDeletion < restart);
  assert.match(
    rollback,
    /if \[ "\$rollback_credentials_ready" -eq 1 \]; then[\s\S]*sudo systemctl start agent-review[\s\S]*else[\s\S]*sudo systemctl stop agent-review/
  );
});

test('diagnostics key rotation atomically keeps the environment and retrieval copy in sync without printing it', async () => {
  const operations = await readDoc('PRODUCTION_OPERATIONS.md');
  const start = operations.indexOf('Rotation creates a unique protected key');
  const end = operations.indexOf('`PANDA_DATA_ACCESS_KEY` is absent', start);
  assert.ok(start >= 0 && end > start);
  const rotation = operations.slice(start, end);
  for (const expected of [
    /key_next="\$\(sudo mktemp \/root\/agent-review-access-key\.next\.XXXXXX\)"/,
    /openssl rand -hex 32 > "\$1"/,
    /key = key_path\.read_text\(encoding='utf-8'\)\.strip\(\)/,
    /validate_env_key "\$env_stage" "\$key_next"/,
    /sudo mv -Tf "\$env_stage" "\$env_file"/,
    /sudo mv -Tf "\$key_next" "\$key_file"/,
    /validate_env_key "\$env_file" "\$key_file"/,
    /if sudo test -e "\$key_file" \|\| sudo test -L "\$key_file"; then/,
    /sudo test ! -L "\$key_file"/,
    /sudo chown root:root "\$key_backup"/,
    /sudo chmod 0600 "\$key_backup"/,
    /sudo rm -f -- "\$key_file"/,
    /validate_env_key "\$env_file" "\$key_file"/,
    /sudo systemctl stop agent-review/,
    /preserve_recovery_backups=1/,
    /if \[ "\$preserve_recovery_backups" -eq 0 \]; then\s+sudo rm -f -- "\$env_stage" "\$env_backup" "\$key_backup"/
  ]) {
    assert.match(rotation, expected);
  }
  assert.doesNotMatch(rotation, /^\s*set\s+-[^\n]*x/m);
  assert.doesNotMatch(
    rotation,
    /^\s*(?:(?:sudo\s+)?(?:cat|head|tail|less|more|tee|awk|sed)|(?:echo|printf))\b[^\n]*(?:key|AGENT_DIAGNOSTICS_ACCESS_KEY)/mi
  );
  assert.doesNotMatch(rotation, /\bprint\s*\(/);
  assert.doesNotMatch(rotation, /(?:sys\.)?(?:stdout|stderr)\.write/);
  const stageValidation = rotation.indexOf('validate_env_key "$env_stage" "$key_next"');
  const envPromotion = rotation.indexOf('sudo mv -Tf "$env_stage" "$env_file"');
  const keyPromotion = rotation.indexOf('sudo mv -Tf "$key_next" "$key_file"');
  const liveValidation = rotation.lastIndexOf('validate_env_key "$env_file" "$key_file"');
  assert.ok(stageValidation < envPromotion && envPromotion < keyPromotion && keyPromotion < liveValidation);
  const restoredEnv = rotation.indexOf('sudo mv -Tf "$env_backup" "$env_file"');
  const restoredKey = rotation.indexOf('sudo mv -Tf "$key_backup" "$key_file"');
  const restoredValidation = rotation.indexOf('validate_env_key "$env_file" "$key_file"');
  const guardedRestart = rotation.indexOf('if [ "$restoration_ok" -eq 1 ]; then');
  assert.ok(restoredEnv < restoredKey && restoredKey < restoredValidation && restoredValidation < guardedRestart);
});

test('V1 release runbook installs and smoke-tests the complete PDF report path', async () => {
  const [operations, environment] = await Promise.all([
    readDoc('PRODUCTION_OPERATIONS.md'),
    readFile(new URL('../.env.example', import.meta.url), 'utf8')
  ]);
  assert.match(environment, /^REPORT_PDF_PYTHON=\.venv\/bin\/python$/m);
  assert.match(environment, /^MODEL_CONTEXT_MAX_BYTES=1500000$/m);
  assert.match(environment, /^MODEL_CONTEXT_WARN_RATIO=0\.8$/m);
  assert.match(operations, /\.venv\/bin\/python -m pip install -r requirements-data\.txt/);
  assert.match(operations, /\.venv\/bin\/python -c ['"]import reportlab['"]/);
  assert.match(operations, /apt-get install -y poppler-utils/);
  assert.match(operations, /command -v pdfinfo/);
  assert.match(operations, /\/api\/evaluations\/\$\{?evaluation_id\}?\/report\.pdf/);
  assert.match(operations, /Content-Type:\s*application\/pdf/i);
  assert.match(operations, /pdfinfo/);
  assert.match(operations, /completed V1/i);
  assert.match(operations, /V1 Panda Runtime 查询桥/);
  assert.match(operations, /invalid output is `502`/);
  assert.match(operations, /renderer is `503`/);
  assert.match(operations, /timeout is `504`/);
  assert.match(operations, /rollback/i);

  const releaseStart = operations.indexOf('## Safe release and rollback');
  const releaseEnd = operations.indexOf('The rendered Nginx configuration', releaseStart);
  const release = operations.slice(releaseStart, releaseEnd);
  const evaluationId = release.indexOf("evaluation_id='<completed V1 evaluation id>'");
  const promotion = release.indexOf('release_switched=1');
  const trap = release.indexOf('trap release_cleanup EXIT');
  const reportSmoke = release.indexOf('/api/evaluations/${evaluation_id}/report.pdf');
  const disarm = release.lastIndexOf('trap - EXIT');
  assert.ok(evaluationId >= 0 && evaluationId < promotion);
  assert.ok(trap >= 0 && trap < reportSmoke && reportSmoke < disarm);
});
