# Production Operations Guide

Run these commands on the production host as an authorized administrator. Never put credentials in a terminal transcript, ticket, chat, shell history, or this document.

## Panda Market Analyst deployment

Install the application at `/opt/agent-review/app`, install the pinned Python
dependencies in a virtual environment, and put all Panda, A2A, and SMTP
credentials in `/etc/agent-review/agent-review.env` with `root:root` ownership
and mode `0600`. The committed environment example contains placeholders only.
`MARKET_AGENT_PRINCIPAL_ID` is a stable, non-secret owner identifier: keep it
unchanged during access-token rotation so scheduled reports and protected detail
links retain the same owner scope. Changing it intentionally creates a separate
owner scope.

```bash
cd /opt/agent-review/app
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-data.txt
npm install
sudo install -o root -g root -m 0644 deploy/market-analyst.service /etc/systemd/system/
sudo install -o root -g root -m 0644 deploy/market-report.service /etc/systemd/system/
sudo install -o root -g root -m 0644 deploy/market-report.timer /etc/systemd/system/
sudo install -d -o agent-review -g agent-review -m 0700 /var/lib/agent-review/market-analyst
sudo systemctl daemon-reload
sudo systemctl enable --now market-analyst.service
sudo systemctl enable --now market-report.timer
```

The timer runs Monday through Friday at `18:30:00 Asia/Shanghai`, is persistent,
and applies a 0–30 second randomized delay with one-second timer accuracy. Allow
up to 31 seconds after 18:30 for dispatch. This weekday schedule is only a wakeup
mechanism: the CLI checks Panda's China exchange calendar and is the authoritative
holiday gate.

Verify the timer, service, loopback endpoint, and bounded recent logs:

```bash
systemctl list-timers market-report.timer --all
sudo systemctl status market-analyst.service market-report.timer --no-pager
curl --fail --silent --show-error http://127.0.0.1:4190/health
sudo journalctl -u market-analyst.service -u market-report.service -n 200 --no-pager
```

Run the credential-gated acceptance smoke from the protected service
environment. `MARKET_SMOKE_REPORT_DATE` may name a completed historical trading
date. Use the first command for a fresh Panda/A2A-only run: the final
`/usr/bin/env` overrides any recipient from the protected environment, and the
smoke uses disposable state.

```bash
sudo systemd-run --wait --collect --pipe \
  --uid=agent-review \
  --gid=agent-review \
  --property=WorkingDirectory=/opt/agent-review/app \
  --property=EnvironmentFile=/etc/agent-review/agent-review.env \
  /usr/bin/env MARKET_SMOKE_STATE_DIR= MARKET_SMOKE_EMAIL_TO= /usr/bin/npm run market:smoke
```

Use a separate durable directory only for an explicitly approved email smoke.
Replace the quoted placeholder with one controlled test inbox before running:

```bash
sudo install -d -o agent-review -g agent-review -m 0700 /var/lib/agent-review/market-smoke
sudo systemd-run --wait --collect --pipe \
  --uid=agent-review \
  --gid=agent-review \
  --property=WorkingDirectory=/opt/agent-review/app \
  --property=EnvironmentFile=/etc/agent-review/agent-review.env \
  /usr/bin/env MARKET_SMOKE_STATE_DIR=/var/lib/agent-review/market-smoke 'MARKET_SMOKE_EMAIL_TO=<explicit test inbox>' /usr/bin/npm run market:smoke
```

The command prints only bounded, sanitized JSON. A missing Panda enable flag or
credential is a failure, never a mock success. Preserve that sanitized summary
in the approved change record. Confirm the SMTP receipt and inbox out of band;
never copy credentials or raw environment output into the record.

### Credential rotation and SMTP testing

Stage a new root-only environment file, validate that required variable names
occur exactly once without printing values, atomically replace the file, and
restart `market-analyst.service`. The next oneshot reads the new file. Retain
the prior root-only file until health, Panda smoke, and—when explicitly
approved—SMTP smoke succeed; then securely retire it under the organization's
credential policy. Rotate Panda, A2A, model, and SMTP credentials independently
where possible.

For SMTP testing, set `MARKET_SMOKE_EMAIL_TO` to one controlled test inbox and
run the email transient unit above. The smoke first completes and validates a
no-email Panda report, then performs delivery and an idempotent replay against
the durable smoke state. Check the deterministic Message-ID and receipt in the
persisted task state and mail-server logs. A `delivery-unknown` or
`reconciliation-needed` state must be reconciled before any manual resend.
Repeating the same date and inbox intentionally reuses the durable receipt. For
a fresh collection, select a new report date or—only under an approved,
services-stopped procedure—preserve and clear the exact smoke state directory.

The task-store lock is fail-closed. A stale empty legacy lock is recovered
automatically, while a malformed nonempty `state.json.lock` is not guessed away.
If that condition persists, stop both market writers, preserve the exact lock
directory and bounded logs for diagnosis, verify that no recorded owner process
is live, and quarantine only that exact directory under an approved recovery
procedure before restart.

### Market artifact backup, restore, and retention

All mutable market state and cache live below
`/var/lib/agent-review/market-analyst`. Stop both writers before a consistent
backup or restore:

```bash
sudo systemctl stop market-report.timer market-report.service market-analyst.service
sudo install -d -o root -g root -m 0700 /var/backups/agent-review
sudo tar --create --gzip \
  --file /var/backups/agent-review/market-analyst-state.tgz \
  --directory /var/lib/agent-review market-analyst
sudo sha256sum /var/backups/agent-review/market-analyst-state.tgz
sudo systemctl start market-analyst.service market-report.timer
```

Restore only an explicitly named, hash-verified archive into a separately
staged directory. Keep the services stopped, preserve the current directory,
set `agent-review:agent-review` ownership and restrictive permissions, then
atomically rename the staged directory into place. Start the A2A service first,
validate `/health` and protected run access, then start the timer. Roll back to
the preserved directory if validation fails.

`MARKET_REPORT_RETENTION_DAYS` is currently parsed but automatic artifact
deletion is not implemented. `MARKET_REPORT_CACHE_DAYS` governs worker cache
retention. Operators must not claim artifact retention enforcement or perform
broad deletion; archive or quarantine explicit dated run directories under an
approved retention procedure.

### Market agent rollback

Before switching `/opt/agent-review/app` to a previous immutable release, stop
the timer and both market services, back up market state, run `npm test` and
`npm run check` in the rollback release, switch the symlink atomically, run
`systemctl daemon-reload`, and restart the A2A service and timer. Validate the
Card and one no-email historical report before re-enabling routine delivery.
Do not downgrade or rewrite persisted state in place.

## Service inventory

- Public full application: <https://14.103.143.171/>
- Browser diagnostics: <https://14.103.143.171/agent-check>
- Private full application: <http://127.0.0.1:4173/> through an SSH tunnel
- Services: `agent-review` (application) and Nginx (TLS reverse proxy)
- Firewall: UFW; certificate timer: `agent-review-certbot.timer`
- Active release when this guide was written: `29324596a665206ff273bdba94e9a98f0a131acd`
- Releases: `/opt/agent-review/releases/<SHA>`; live symlink: `/opt/agent-review/app`
- State: `/var/lib/agent-review/evaluations.json`
- Environment: `/etc/agent-review/agent-review.env`, owned by `root:root`, mode `0600`

Manage the app only through systemd; do not start an additional Node process. Nginx remains the public TLS endpoint and proxies the application, including long-running evaluation and SSE routes, to the loopback-only Node service. The public homepage intake must expose only V1 `live`; V2 and demo APIs/history remain retained backend capabilities and must not be advertised as public intake.

This private deployment intentionally sets `ALLOW_PRIVATE_AGENT_URLS=true`. The setting applies to diagnostics, Agent Card discovery, and formal evaluation A2A calls. Targets are resolved and reached from the production host, so `127.0.0.1` means this server rather than the submitter's browser or workstation. Keep the flag disabled for an untrusted multi-tenant deployment.

## Private administrator access

Run the following command on the administrator workstation, not on the production host:

```powershell
ssh -N -L 4173:127.0.0.1:4173 root@14.103.143.171
```

Keep that session open. In a second PowerShell window, require an exact `200` from the tunneled full application:

```powershell
$tunnelStatus = curl.exe --silent --output NUL --write-out "%{http_code}" --max-redirs 0 --connect-timeout 5 --max-time 15 http://127.0.0.1:4173/
if ($tunnelStatus -ne '200') { throw "SSH tunnel did not reach the full application" }
```

Then visit <http://127.0.0.1:4173/>. This connects directly to the Node service on the production loopback interface and does not pass through the public Nginx allowlist.

## Daily health and logs

```bash
set -euo pipefail
health_ok() {
  curl --fail --silent --show-error --max-redirs 0 --connect-timeout 5 --max-time 15 https://14.103.143.171/api/health |
    python3 -c 'import json, sys; raise SystemExit(0 if json.load(sys.stdin).get("ok") is True else 1)'
}
require_200() {
  local url="$1" status
  status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-redirs 0 --connect-timeout 5 --max-time 15 "$url")"
  test "$status" = '200'
}
require_308() {
  local url="$1" status
  status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-redirs 0 --connect-timeout 5 --max-time 15 "$url")"
  test "$status" = '308'
}
require_401_post() {
  local url="$1" status
  status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-redirs 0 --connect-timeout 5 --max-time 15 --request POST --header 'Content-Type: application/json' --data '{}' "$url")"
  test "$status" = '401'
}
require_404() {
  local url="$1" status
  status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-redirs 0 --connect-timeout 5 --max-time 15 "$url")"
  test "$status" = '404'
}
sudo systemctl status agent-review --no-pager
readlink -f /opt/agent-review/app
health_ok
require_200 https://14.103.143.171/agent-check
require_200 https://14.103.143.171/agent-check.js
require_200 https://14.103.143.171/agent-check.css
require_308 https://14.103.143.171/agent-check.html
require_401_post https://14.103.143.171/api/agent-diagnostics
require_200 https://14.103.143.171/
require_200 https://14.103.143.171/app.js
require_200 https://14.103.143.171/styles.css
require_200 https://14.103.143.171/methodology.html
require_200 https://14.103.143.171/judge.html
require_200 https://14.103.143.171/appeal.html
require_200 https://14.103.143.171/api/evaluations
sudo journalctl -u agent-review --since '24 hours ago' --no-pager
sudo systemctl status nginx --no-pager
sudo journalctl -u nginx --since '24 hours ago' --no-pager
```

The health response must contain JSON with `ok: true`; the application, its primary pages, assets, and evaluation collection API must return exactly `200`; the old diagnostics HTML entry must return `308`; and an unauthenticated diagnostics POST must return `401`. These checks do not follow redirects. Inspect the homepage source or rendered controls during release acceptance: it must contain neither a V2 intake switch nor a demo intake switch. Existing V2/demo records may still be opened directly and retain their original type. The existing failed `cloud-monitor-agent` and `console-setup` units are unrelated to this platform; record and investigate them separately unless evidence links them to the incident.

## Restart and reboot validation

Do not assume a restart is immediately ready. Restart, then condition-poll the health endpoint:

```bash
set -euo pipefail
health_ok() {
  curl --fail --silent --show-error --max-redirs 0 --connect-timeout 5 --max-time 15 https://14.103.143.171/api/health |
    python3 -c 'import json, sys; raise SystemExit(0 if json.load(sys.stdin).get("ok") is True else 1)'
}
wait_for_health() {
  for attempt in $(seq 1 30); do
    if health_ok; then return 0; fi
    sleep 2
  done
  return 1
}
sudo systemctl restart agent-review
wait_for_health
```

On failure, collect bounded evidence before retrying:

```bash
sudo systemctl status agent-review --no-pager
sudo journalctl -u agent-review -n 200 --no-pager
sudo nginx -t
```

After a reboot verify application, release target, endpoint, proxy, and firewall:

```bash
set -euo pipefail
health_ok() {
  curl --fail --silent --show-error --max-redirs 0 --connect-timeout 5 --max-time 15 https://14.103.143.171/api/health |
    python3 -c 'import json, sys; raise SystemExit(0 if json.load(sys.stdin).get("ok") is True else 1)'
}
wait_for_health() {
  for attempt in $(seq 1 30); do
    if health_ok; then return 0; fi
    sleep 2
  done
  return 1
}
sudo systemctl is-active --quiet agent-review
readlink -f /opt/agent-review/app
wait_for_health
sudo systemctl is-active --quiet nginx
sudo ufw status verbose
```

## Safe release and rollback

Release directories are immutable and named with a full Git SHA. Validate a candidate before switching. Do not edit files through `/opt/agent-review/app`.

```bash
set -euo pipefail
health_ok() {
  curl --fail --silent --show-error --max-redirs 0 --connect-timeout 5 --max-time 15 https://14.103.143.171/api/health |
    python3 -c 'import json, sys; raise SystemExit(0 if json.load(sys.stdin).get("ok") is True else 1)'
}
wait_for_health() {
  for attempt in $(seq 1 30); do
    if health_ok; then return 0; fi
    sleep 2
  done
  return 1
}
release_sha='<approved full Git SHA>'
[[ "$release_sha" =~ ^[0-9a-fA-F]{40}$ ]]
expected_release_dir="/opt/agent-review/releases/$release_sha"
release_dir="$(readlink -f "$expected_release_dir")"
test "$release_dir" = "$expected_release_dir"
test -d "$release_dir"
test -f "$release_dir/package.json"
sudo -u agent-review -- sh -c 'cd "$1" && npm ci && python3 -m venv .venv && .venv/bin/python -m pip install -r requirements-data.txt && .venv/bin/python -c "import reportlab" && npm test && npm run check' sh "$release_dir"
nginx_template="$release_dir/deploy/nginx-production.conf"
test -f "$nginx_template"
nginx_live=/etc/nginx/sites-available/agent-review
nginx_stage="/etc/nginx/sites-available/agent-review.next.$$"
nginx_backup="/etc/nginx/sites-available/agent-review.backup.$(date -u +%Y%m%dT%H%M%SZ)"
environment_live=/etc/agent-review/agent-review.env
environment_backup="/etc/agent-review/agent-review.env.release-backup.$(date -u +%Y%m%dT%H%M%SZ).$$"
retrieval_key_live=/root/agent-review-access-key.txt
retrieval_key_state=missing
retrieval_key_backup=''
nginx_rendered="$(mktemp)"
sed 's/__PUBLIC_IP__/14.103.143.171/g' "$nginx_template" > "$nginx_rendered"
test -s "$nginx_rendered"
sudo test -f "$nginx_live"
sudo cp -p "$nginx_live" "$nginx_backup"
sudo test -f "$environment_live"
sudo cp -p "$environment_live" "$environment_backup"
sudo chown root:root "$environment_backup"
sudo chmod 0600 "$environment_backup"
if sudo test -e "$retrieval_key_live" || sudo test -L "$retrieval_key_live"; then
  sudo test -f "$retrieval_key_live"
  sudo test ! -L "$retrieval_key_live"
  retrieval_key_backup="/root/agent-review-access-key.txt.release-backup.$(date -u +%Y%m%dT%H%M%SZ).$$"
  sudo cp -p "$retrieval_key_live" "$retrieval_key_backup"
  sudo chown root:root "$retrieval_key_backup"
  sudo chmod 0600 "$retrieval_key_backup"
  retrieval_key_state=present
fi
previous_dir="$(readlink -f /opt/agent-review/app)"
test -d "$previous_dir"
printf 'Record rollback inputs: previous_release=%s nginx_backup=%s environment_backup=%s retrieval_key_state=%s retrieval_key_backup=%s\n' \
  "$previous_dir" "$nginx_backup" "$environment_backup" "$retrieval_key_state" "$retrieval_key_backup"
stage_link="/opt/agent-review/app.next.$$"
recovery_link="/opt/agent-review/app.recovery.$$"
release_switched=0
nginx_promoted=0
release_cleanup() {
  status=$?
  rm -f -- "$nginx_rendered" || true
  sudo rm -f -- "$stage_link" "$recovery_link" "$nginx_stage" || true
  if [ "$release_switched" -eq 1 ]; then
    sudo ln -s "$previous_dir" "$recovery_link" || true
    if [ "$(readlink -f "$recovery_link" 2>/dev/null || true)" = "$previous_dir" ]; then
      sudo mv -Tf "$recovery_link" /opt/agent-review/app || true
      sudo systemctl restart agent-review || true
      wait_for_health || true
    fi
  fi
  if [ "$nginx_promoted" -eq 1 ]; then
    sudo cp -p "$nginx_backup" "$nginx_stage" || true
    sudo mv -Tf "$nginx_stage" "$nginx_live" || true
    sudo nginx -t && sudo systemctl reload nginx || true
  fi
  exit "$status"
}
trap release_cleanup EXIT
sudo install -o root -g root -m 0644 "$nginx_rendered" "$nginx_stage"
sudo mv -Tf "$nginx_stage" "$nginx_live"
nginx_promoted=1
sudo nginx -t
sudo systemctl reload nginx
sudo ln -s "$release_dir" "$stage_link"
test "$(readlink -f "$stage_link")" = "$release_dir"
sudo mv -Tf "$stage_link" /opt/agent-review/app
release_switched=1
sudo systemctl restart agent-review
wait_for_health
rm -f -- "$nginx_rendered"
trap - EXIT
```

The rendered Nginx configuration is installed only after the existing file is backed up. Any failure after promotion restores that backup, validates it with `nginx -t`, reloads Nginx, and restores the previous application symlink if it had already moved. Record every printed rollback input with the release: the previous release, Nginx backup, root-only environment backup, retrieval-key state, and retrieval-key backup path when the state is `present`. A `missing` state is deliberate and must also be recorded. Both root-only backups must survive until the release is accepted.

### Completed V1 PDF acceptance

After health is green, select a known completed `schemaVersion: 1` V1 evaluation ID from the release state; do not use a V2, running, demo-only fixture, or a guessed ID. The report is generated on demand, so this also verifies the release virtual environment rather than a cached static file.

```bash
set -euo pipefail
evaluation_id='<completed V1 evaluation id>'
case "$evaluation_id" in ''|*[^A-Za-z0-9_-]*) echo 'set one completed V1 evaluation id' >&2; exit 1;; esac
report_headers="$(mktemp)"
report_pdf="$(mktemp --suffix=.pdf)"
trap 'rm -f -- "$report_headers" "$report_pdf"' EXIT
curl --fail --silent --show-error --max-redirs 0 \
  --dump-header "$report_headers" \
  --output "$report_pdf" \
  "https://14.103.143.171/api/evaluations/${evaluation_id}/report.pdf"
grep -qi '^Content-Type: application/pdf' "$report_headers"
grep -qi '^Cache-Control: no-store' "$report_headers"
pdfinfo "$report_pdf"
test -s "$report_pdf"
```

The endpoint is only valid for a completed V1 record: missing IDs return `404`; V2 and non-completed records return `409`. If the request is not `200`, lacks `Content-Type: application/pdf`, or `pdfinfo` cannot parse it, treat the release as failed and run the recorded rollback before attempting another PDF request. The report route must never stream a partial PDF on renderer failure.

If post-deployment acceptance fails, use the exact paths and retrieval-key state recorded by the release command. Do not guess a SHA or select the newest backup:

```bash
set -euo pipefail
health_ok() {
  curl --fail --silent --show-error --max-redirs 0 --connect-timeout 5 --max-time 15 https://14.103.143.171/api/health |
    python3 -c 'import json, sys; raise SystemExit(0 if json.load(sys.stdin).get("ok") is True else 1)'
}
wait_for_health() {
  for attempt in $(seq 1 30); do
    if health_ok; then return 0; fi
    sleep 2
  done
  return 1
}
validate_env_key() {
  sudo python3 - "$1" "$2" <<'PY'
import hmac, pathlib, re, sys
env_path, key_path = map(pathlib.Path, sys.argv[1:])
key = key_path.read_text(encoding='utf-8').strip()
pattern = re.compile(r'^\s*(?:export\s+)?AGENT_DIAGNOSTICS_ACCESS_KEY\s*=\s*(.*?)\s*$')
values = [match.group(1) for line in env_path.read_text(encoding='utf-8').splitlines() if (match := pattern.match(line))]
raise SystemExit(0 if len(values) == 1 and hmac.compare_digest(values[0], key) else 1)
PY
}
previous_release='<recorded previous release directory>'
nginx_backup='<recorded nginx backup>'
environment_backup='<recorded environment backup>'
retrieval_key_state='<recorded retrieval key state: present or missing>'
retrieval_key_backup='<recorded retrieval key backup; empty if missing>'
app_live=/opt/agent-review/app
app_stage="/opt/agent-review/app.rollback.$$"
nginx_live=/etc/nginx/sites-available/agent-review
nginx_stage="/etc/nginx/sites-available/agent-review.rollback.$$"
environment_live=/etc/agent-review/agent-review.env
environment_stage="/etc/agent-review/agent-review.env.rollback.$$"
retrieval_key_live=/root/agent-review-access-key.txt
retrieval_key_stage="/root/agent-review-access-key.txt.rollback.$$"
service_stopped=0
rollback_credentials_ready=0

test "$(readlink -f "$previous_release")" = "$previous_release"
test -d "$previous_release"
test -f "$previous_release/package.json"
sudo test -f "$nginx_backup"
sudo test -f "$environment_backup"
case "$retrieval_key_state" in
  present)
    sudo test -f "$retrieval_key_backup"
    validate_env_key "$environment_backup" "$retrieval_key_backup"
    ;;
  missing)
    test -z "$retrieval_key_backup"
    ;;
  *)
    echo 'retrieval_key_state must be present or missing' >&2
    exit 1
    ;;
esac
sudo ln -s "$previous_release" "$app_stage"
test "$(readlink -f "$app_stage")" = "$previous_release"

rollback_cleanup() {
  status=$?
  sudo rm -f -- "$app_stage" "$nginx_stage" "$environment_stage" "$retrieval_key_stage" || true
  if [ "$status" -ne 0 ] && [ "$service_stopped" -eq 1 ]; then
    if [ "$rollback_credentials_ready" -eq 1 ]; then
      sudo systemctl start agent-review || true
    else
      sudo systemctl stop agent-review || true
      echo 'Rollback failed before credential consistency was verified; agent-review remains stopped.' >&2
    fi
  fi
  exit "$status"
}
trap rollback_cleanup EXIT

sudo systemctl stop agent-review
service_stopped=1
sudo mv -Tf "$app_stage" "$app_live"
sudo cp -p "$nginx_backup" "$nginx_stage"
sudo mv -Tf "$nginx_stage" "$nginx_live"
sudo nginx -t
sudo systemctl reload nginx
sudo install -o root -g root -m 0600 "$environment_backup" "$environment_stage"
sudo mv -Tf "$environment_stage" "$environment_live"
sudo chown root:root "$environment_live"
sudo chmod 0600 "$environment_live"
test "$(sudo stat -c '%U:%G %a' "$environment_live")" = 'root:root 600'
if [ "$retrieval_key_state" = present ]; then
  sudo install -o root -g root -m 0600 "$retrieval_key_backup" "$retrieval_key_stage"
  sudo mv -Tf "$retrieval_key_stage" "$retrieval_key_live"
  sudo chown root:root "$retrieval_key_live"
  sudo chmod 0600 "$retrieval_key_live"
  test "$(sudo stat -c '%U:%G %a' "$retrieval_key_live")" = 'root:root 600'
  validate_env_key "$environment_live" "$retrieval_key_live"
  rollback_credentials_ready=1
else
  sudo rm -f -- "$retrieval_key_live"
  if sudo test -e "$retrieval_key_live" || sudo test -L "$retrieval_key_live"; then
    echo 'retrieval key removal failed' >&2
    exit 1
  fi
  rollback_credentials_ready=1
fi
sudo systemctl restart agent-review
wait_for_health
service_stopped=0
trap - EXIT
```

This restores the application release, public routing, environment key, and operator retrieval copy as one rollback procedure. When the retrieval copy existed before release, rollback verifies that its backup matches the environment backup before stopping the service, restores both through protected staged files, and verifies them again before restart. When it was absent, rollback removes the newly created retrieval copy before restart. If a switch is interrupted, inspect only the explicit live and `.rollback.<PID>` paths before acting. Do not remove release directories or backups during an incident.

## Backup and restore

Back up state before a release and on the operations schedule. Keep backups outside the state directory with restrictive permissions:

```bash
set -euo pipefail
backup_dir=/var/backups/agent-review
sudo install -d -o root -g root -m 0700 "$backup_dir"
sudo cp -p /var/lib/agent-review/evaluations.json "$backup_dir/evaluations.json.$(date -u +%Y%m%dT%H%M%SZ)"
sudo sha256sum "$backup_dir"/evaluations.json.*
```

Restore only an explicit, named backup. Validate it first, then stop the service before preserving live state or creating a state-directory temporary file. The failure trap removes only its exact temporary file and restarts the service. The temporary restored state is owned by the service account and atomically renamed while the service remains stopped:

```bash
set -euo pipefail
health_ok() {
  curl --fail --silent --show-error --max-redirs 0 --connect-timeout 5 --max-time 15 https://14.103.143.171/api/health |
    python3 -c 'import json, sys; raise SystemExit(0 if json.load(sys.stdin).get("ok") is True else 1)'
}
wait_for_health() {
  for attempt in $(seq 1 30); do
    if health_ok; then return 0; fi
    sleep 2
  done
  return 1
}
restore_file='/var/backups/agent-review/evaluations.json.<UTC timestamp>'
test -f "$restore_file"
sudo python3 - "$restore_file" <<'PY'
import json, pathlib, sys
json.load(pathlib.Path(sys.argv[1]).open(encoding='utf-8'))
PY
sudo systemctl stop agent-review
restore_tmp=''
recovery_tmp=''
preserved_file=''
restore_applied=0
restore_cleanup() {
  status=$?
  if [ -n "$restore_tmp" ]; then sudo rm -f -- "$restore_tmp" || true; fi
  if [ "$restore_applied" -eq 1 ] && [ -n "$preserved_file" ]; then
    sudo systemctl stop agent-review || true
    recovery_tmp="$(sudo mktemp -p /var/lib/agent-review 'evaluations.json.recovery.XXXXXXXX')" || true
    if [ -n "$recovery_tmp" ]; then
      if sudo cp -- "$preserved_file" "$recovery_tmp" && sudo python3 - "$recovery_tmp" <<'PY'
import json, pathlib, sys
json.load(pathlib.Path(sys.argv[1]).open(encoding='utf-8'))
PY
      then
        sudo chown agent-review:agent-review "$recovery_tmp" || true
        sudo chmod 0600 "$recovery_tmp" || true
        sudo mv -Tf "$recovery_tmp" /var/lib/agent-review/evaluations.json || true
      fi
    fi
  fi
  if [ -n "$recovery_tmp" ]; then sudo rm -f -- "$recovery_tmp" || true; fi
  sudo systemctl start agent-review || true
  wait_for_health || true
  exit "$status"
}
trap restore_cleanup EXIT
preserved_file="/var/backups/agent-review/evaluations.json.pre-restore.$(date -u +%Y%m%dT%H%M%SZ)"
preserved_hash="$preserved_file.sha256"
sudo cp -p /var/lib/agent-review/evaluations.json "$preserved_file"
sudo test -s "$preserved_file"
sudo python3 - "$preserved_file" <<'PY'
import json, pathlib, sys
json.load(pathlib.Path(sys.argv[1]).open(encoding='utf-8'))
PY
sudo sh -c 'sha256sum "$1" > "$2"; sha256sum -c "$2" >/dev/null' sh "$preserved_file" "$preserved_hash"
restore_tmp="$(sudo mktemp -p /var/lib/agent-review 'evaluations.json.restore.XXXXXXXX')"
sudo cp -- "$restore_file" "$restore_tmp"
sudo python3 - "$restore_tmp" <<'PY'
import json, pathlib, sys
json.load(pathlib.Path(sys.argv[1]).open(encoding='utf-8'))
PY
sudo chown agent-review:agent-review "$restore_tmp"
sudo chmod 0600 "$restore_tmp"
sudo mv -Tf "$restore_tmp" /var/lib/agent-review/evaluations.json
restore_tmp=''
restore_applied=1
sudo systemctl start agent-review
wait_for_health
sudo -u agent-review -- python3 - /var/lib/agent-review/evaluations.json <<'PY'
import json, pathlib, sys
json.load(pathlib.Path(sys.argv[1]).open(encoding='utf-8'))
PY
trap - EXIT
```

## Configuration and secret rotation

Check configuration metadata without exposing contents:

```bash
sudo stat -c '%U:%G %a %n' /etc/agent-review/agent-review.env
```

Expected metadata is `root:root 600`. The browser diagnostics retrieval copy is `/root/agent-review-access-key.txt`, also `root:root` mode `0600`. Authorized operators retrieve it only through their approved privileged-access procedure.

Rotation creates a unique protected key file and a protected staged environment from that same key, validates the pair without output, then makes exact root-only backups before either live replacement. Each live file is replaced with an atomic rename. Its failure trap verifies ownership, mode, and credential consistency before restarting with restored files; if restoration cannot be verified, it stops the service and leaves an explicit error instead of starting with mismatched credentials.

```bash
set -euo pipefail
health_ok() {
  curl --fail --silent --show-error --max-redirs 0 --connect-timeout 5 --max-time 15 https://14.103.143.171/api/health |
    python3 -c 'import json, sys; raise SystemExit(0 if json.load(sys.stdin).get("ok") is True else 1)'
}
wait_for_health() {
  for attempt in $(seq 1 30); do
    if health_ok; then return 0; fi
    sleep 2
  done
  return 1
}
env_file=/etc/agent-review/agent-review.env
key_file=/root/agent-review-access-key.txt
key_next=''
env_stage="/etc/agent-review/agent-review.env.next.$$"
env_backup="/etc/agent-review/agent-review.env.backup.$$"
key_backup="/root/agent-review-access-key.backup.$$"
live_replacements_started=0
key_had_live=0
preserve_recovery_backups=0
rotation_cleanup() {
  status=$?
  if [ "$live_replacements_started" -eq 1 ]; then
    restoration_ok=1
    if ! sudo mv -Tf "$env_backup" "$env_file"; then restoration_ok=0; fi
    if ! sudo chown root:root "$env_file"; then restoration_ok=0; fi
    if ! sudo chmod 0600 "$env_file"; then restoration_ok=0; fi
    if [ "$(sudo stat -c '%U:%G %a' "$env_file" 2>/dev/null || true)" != 'root:root 600' ]; then
      restoration_ok=0
    fi
    if [ "$key_had_live" -eq 1 ]; then
      if ! sudo mv -Tf "$key_backup" "$key_file"; then restoration_ok=0; fi
      if ! sudo chown root:root "$key_file"; then restoration_ok=0; fi
      if ! sudo chmod 0600 "$key_file"; then restoration_ok=0; fi
      if [ "$(sudo stat -c '%U:%G %a' "$key_file" 2>/dev/null || true)" != 'root:root 600' ]; then
        restoration_ok=0
      fi
      if ! validate_env_key "$env_file" "$key_file"; then restoration_ok=0; fi
    else
      if ! sudo rm -f -- "$key_file"; then restoration_ok=0; fi
      if sudo test -e "$key_file" || sudo test -L "$key_file"; then restoration_ok=0; fi
    fi
    if [ "$restoration_ok" -eq 1 ]; then
      sudo systemctl restart agent-review || true
      wait_for_health || true
    else
      preserve_recovery_backups=1
      sudo systemctl stop agent-review || true
      echo 'Rotation recovery could not verify credential consistency; agent-review remains stopped.' >&2
    fi
  fi
  if [ "$preserve_recovery_backups" -eq 0 ]; then
    sudo rm -f -- "$env_stage" "$env_backup" "$key_backup" || true
    if [ -n "$key_next" ]; then sudo rm -f -- "$key_next" || true; fi
  fi
  exit "$status"
}
trap rotation_cleanup EXIT
key_next="$(sudo mktemp /root/agent-review-access-key.next.XXXXXX)"
sudo sh -c 'umask 077; openssl rand -hex 32 > "$1"' sh "$key_next"
sudo chown root:root "$key_next"
sudo chmod 0600 "$key_next"
sudo python3 - "$env_file" "$key_next" "$env_stage" <<'PY'
import os, pathlib, re, sys
env_path, key_path, staged_path = map(pathlib.Path, sys.argv[1:])
key = key_path.read_text(encoding='utf-8').strip()
if not key:
    raise SystemExit('replacement key is empty')
lines = env_path.read_text(encoding='utf-8').splitlines(keepends=True)
pattern = re.compile(r'^(\s*(?:export\s+)?AGENT_DIAGNOSTICS_ACCESS_KEY\s*=).*$')
matches = [index for index, line in enumerate(lines) if pattern.match(line)]
if len(matches) != 1:
    raise SystemExit('expected exactly one AGENT_DIAGNOSTICS_ACCESS_KEY entry')
index = matches[0]
prefix = pattern.match(lines[index]).group(1)
lines[index] = f'{prefix}{key}\n'
fd = os.open(staged_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w', encoding='utf-8') as handle:
    handle.writelines(lines)
    handle.flush()
    os.fsync(handle.fileno())
os.chown(staged_path, 0, 0)
os.chmod(staged_path, 0o600)
PY
validate_env_key() {
  sudo python3 - "$1" "$2" <<'PY'
import hmac, pathlib, re, sys
env_path, key_path = map(pathlib.Path, sys.argv[1:])
key = key_path.read_text(encoding='utf-8').strip()
pattern = re.compile(r'^\s*(?:export\s+)?AGENT_DIAGNOSTICS_ACCESS_KEY\s*=\s*(.*?)\s*$')
values = [match.group(1) for line in env_path.read_text(encoding='utf-8').splitlines() if (match := pattern.match(line))]
raise SystemExit(0 if len(values) == 1 and hmac.compare_digest(values[0], key) else 1)
PY
}
validate_env_key "$env_stage" "$key_next"
sudo cp -p "$env_file" "$env_backup"
sudo chown root:root "$env_backup"
sudo chmod 0600 "$env_backup"
if sudo test -e "$key_file" || sudo test -L "$key_file"; then
  sudo test -f "$key_file"
  sudo test ! -L "$key_file"
  sudo cp -p "$key_file" "$key_backup"
  sudo chown root:root "$key_backup"
  sudo chmod 0600 "$key_backup"
  validate_env_key "$env_backup" "$key_backup"
  key_had_live=1
fi
live_replacements_started=1
sudo mv -Tf "$env_stage" "$env_file"
sudo mv -Tf "$key_next" "$key_file"
validate_env_key "$env_file" "$key_file"
sudo systemctl restart agent-review
wait_for_health
sudo python3 - "$key_file" <<'PY'
import pathlib, sys, urllib.error, urllib.request
key = pathlib.Path(sys.argv[1]).read_text(encoding='utf-8').strip()
request = urllib.request.Request(
    'https://14.103.143.171/api/agent-diagnostics', data=b'{}', method='POST',
    headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'},
)
try:
    urllib.request.urlopen(request, timeout=15)
except urllib.error.HTTPError as error:
    raise SystemExit(0 if error.code == 400 else 1)
raise SystemExit(1)
PY
trap - EXIT
sudo rm -f -- "$env_backup" "$key_backup"
```

`PANDA_DATA_ACCESS_KEY` is absent, so the public Panda query gateway remains closed. Internal auto-verification is configured. Do not open the public gateway as an incident workaround without an approved change and separate access key.

## Certificate and firewall

The IP certificate is a short-lived Let's Encrypt certificate. The `agent-review-certbot.timer` runs every 12 hours. Check it and perform the prescribed dry run:

```bash
set -euo pipefail
sudo systemctl status agent-review-certbot.timer --no-pager
sudo systemctl list-timers agent-review-certbot.timer --all
sudo openssl s_client -connect 14.103.143.171:443 -servername 14.103.143.171 </dev/null 2>/dev/null | openssl x509 -noout -dates -issuer
sudo /opt/certbot/bin/certbot renew --dry-run
```

Test Nginx before any reload:

```bash
set -euo pipefail
sudo nginx -t
sudo systemctl reload nginx
sudo ufw status verbose
sudo ufw status numbered
```

Preserve the approved SSH management path before modifying firewall rules.

## SSH trust boundary and incidents

SSH key access uses a documented, human-accepted trust-on-first-use boundary. The pinned host-key fingerprint is in the deployment record; compare the presented fingerprint before accepting a new or changed host key. Never include or request an SSH password.

For an incident: stabilize with service/Nginx/health checks; record UTC time, symlink target, statuses, and bounded logs with secrets redacted; roll back an implicated release; preserve then restore state only when needed; and escalate any credential exposure for rotation. For certificate issues inspect timer, expiry, renewal logs, and Nginx before changing application or firewall settings. Make one reversible, observable change at a time. Never use broad deletion, mass release cleanup, or unverified configuration rewrites.

## Governed black-box V2 operations

### Real rollout controls

The committed `.env.example` defines exactly these V2 rollout controls:

```text
A2A_BLACK_BOX_V1_ENABLED=false
REVIEW_GOVERNANCE_ENABLED=false
APPEAL_WINDOW_HOURS=72
```

`A2A_BLACK_BOX_V1_ENABLED=true` enables V2 submission and its encrypted evidence
pipeline. `REVIEW_GOVERNANCE_ENABLED=true` enables judge/admin roles and review
routes. `APPEAL_WINDOW_HOURS` controls the post-finalization participant appeal
window. Replica release and public evidence projection are implemented by the
governance state and role projection; there is no
`ENABLE_REPLICA_ARENA_V2` or `PUBLIC_EVIDENCE_ENABLED` environment flag. Do not
document or deploy nonexistent flags.

Roll out in three reversible stages: shadow V2 submissions while preserving the
legacy path, a limited judge pilot with configured hashed principals, then V2 as
the default submission experience. `schemaVersion: 1` records remain legacy and
are never silently rescored. Before each promotion, run `node --test
test/api.test.js`, `npm run check`, and a role-projection smoke covering public,
participant, judge, and admin responses.

### Keys, tokens, and evidence

Set `EVIDENCE_ENCRYPTION_KEY` to one canonical base64-encoded 32-byte key in the
root-only environment file. Rotate it by stopping writers, backing up the
evaluation file and evidence root, decrypting/re-encrypting records through an
approved migration, validating record hashes, then atomically promoting the new
environment and state. The current implementation does not provide an automatic
key-rotation command; do not change the key in place and strand existing
evidence.

`REVIEW_PRINCIPALS_JSON` contains only `principalId`, display metadata, role, and
SHA-256 token hashes. Generate plaintext judge/admin tokens out of band, store
them in an approved secret manager, and rotate the hash configuration atomically.
Never put a plaintext token in `.env.example`, request bodies, SSE, shell
history, tickets, or logs. Participant tokens are one-time create receipts:
there is no recovery endpoint. A participant who loses one must create a new
evaluation rather than request a token reset.

Evidence manifests and item reads are role-projected and redacted. Treat all
raw Vault payloads as sensitive: redact PII, credentials, signed URLs, and
hidden test material before any operator export. Access reads append hash-chained
events under `ACCESS_AUDIT_ROOT`; retain those events and encrypted evidence
according to the organization-approved retention schedule. Automatic deletion
for governed evidence is not implemented, so do not claim that a local cleanup
job enforces retention.

### Governance incidents and recovery

For a judge draft `409`, reload the assignment and resubmit from the returned
assignment revision; never overwrite a newer draft. Submitted reviews and an
absolute locked result are immutable. To validate an audit chain, parse each
daily NDJSON record in order, recompute the canonical event hash with its prior
hash, and stop investigation on the first mismatch; preserve the original files.

If Replica information appears before absolute lock, immediately disable
`REVIEW_GOVERNANCE_ENABLED`, preserve bounded HTTP/SSE/audit evidence, revoke
affected judge tokens, and assess the affected evaluation as compromised. Do not
attempt to “re-hide” leaked data by editing projections or logs. Start a new
evaluation/result version under an approved incident decision.

Back up `DATA_FILE`, `EVIDENCE_ROOT`, and `ACCESS_AUDIT_ROOT` together while the
service is stopped. On restoration, verify JSON validity, file ownership and
mode, evidence ciphertext authentication, referenced record hashes, and audit
chains before restart. Restore to a staged directory and atomically promote only
the verified set; never mix an evaluation snapshot with a different evidence or
audit snapshot.
