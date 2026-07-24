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

- Public application: <https://14.103.143.171/>
- Browser diagnostics: <https://14.103.143.171/agent-check.html>
- Services: `agent-review` (application) and Nginx (TLS reverse proxy)
- Firewall: UFW; certificate timer: `agent-review-certbot.timer`
- Active release when this guide was written: `29324596a665206ff273bdba94e9a98f0a131acd`
- Releases: `/opt/agent-review/releases/<SHA>`; live symlink: `/opt/agent-review/app`
- State: `/var/lib/agent-review/evaluations.json`
- Environment: `/etc/agent-review/agent-review.env`, owned by `root:root`, mode `0600`

Manage the app only through systemd; do not start an additional Node process. Nginx remains the public TLS endpoint.

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
sudo systemctl status agent-review --no-pager
readlink -f /opt/agent-review/app
health_ok
require_200 https://14.103.143.171/
require_200 https://14.103.143.171/agent-check.html
sudo journalctl -u agent-review --since '24 hours ago' --no-pager
sudo systemctl status nginx --no-pager
sudo journalctl -u nginx --since '24 hours ago' --no-pager
```

The health response must contain JSON with `ok: true`; page checks require an exact HTTP 200 and do not follow redirects. The existing failed `cloud-monitor-agent` and `console-setup` units are unrelated to this platform; record and investigate them separately unless evidence links them to the incident.

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
sudo -u agent-review -- sh -c 'cd "$1" && npm test && npm run check' sh "$release_dir"
previous_dir="$(readlink -f /opt/agent-review/app)"
test -d "$previous_dir"
stage_link="/opt/agent-review/app.next.$$"
recovery_link="/opt/agent-review/app.recovery.$$"
release_switched=0
release_cleanup() {
  status=$?
  sudo rm -f -- "$stage_link" "$recovery_link" || true
  if [ "$release_switched" -eq 1 ]; then
    sudo ln -s "$previous_dir" "$recovery_link" || true
    if [ "$(readlink -f "$recovery_link" 2>/dev/null || true)" = "$previous_dir" ]; then
      sudo mv -Tf "$recovery_link" /opt/agent-review/app || true
      sudo systemctl restart agent-review || true
      wait_for_health || true
    fi
  fi
  exit "$status"
}
trap release_cleanup EXIT
sudo ln -s "$release_dir" "$stage_link"
test "$(readlink -f "$stage_link")" = "$release_dir"
sudo mv -Tf "$stage_link" /opt/agent-review/app
release_switched=1
sudo systemctl restart agent-review
wait_for_health
trap - EXIT
```

If validation fails, switch only to a known retained directory. The documented active SHA is a rollback target while it remains present:

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
rollback_sha='29324596a665206ff273bdba94e9a98f0a131acd'
[[ "$rollback_sha" =~ ^[0-9a-fA-F]{40}$ ]]
expected_rollback_dir="/opt/agent-review/releases/$rollback_sha"
rollback_dir="$(readlink -f "$expected_rollback_dir")"
test "$rollback_dir" = "$expected_rollback_dir"
test -d "$rollback_dir"
test -f "$rollback_dir/package.json"
previous_dir="$(readlink -f /opt/agent-review/app)"
test -d "$previous_dir"
stage_link="/opt/agent-review/app.next.$$"
recovery_link="/opt/agent-review/app.recovery.$$"
rollback_switched=0
rollback_cleanup() {
  status=$?
  sudo rm -f -- "$stage_link" "$recovery_link" || true
  if [ "$rollback_switched" -eq 1 ]; then
    sudo ln -s "$previous_dir" "$recovery_link" || true
    if [ "$(readlink -f "$recovery_link" 2>/dev/null || true)" = "$previous_dir" ]; then
      sudo mv -Tf "$recovery_link" /opt/agent-review/app || true
      sudo systemctl restart agent-review || true
      wait_for_health || true
    fi
  fi
  exit "$status"
}
trap rollback_cleanup EXIT
sudo ln -s "$rollback_dir" "$stage_link"
test "$(readlink -f "$stage_link")" = "$rollback_dir"
sudo mv -Tf "$stage_link" /opt/agent-review/app
rollback_switched=1
sudo systemctl restart agent-review
wait_for_health
trap - EXIT
```

If a switch is interrupted, inspect the explicit `app` and uniquely named `app.next.<PID>` paths before acting. Do not remove release directories during an incident.

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

Rotation creates protected staged key and environment files, validates the staged environment without output, then makes exact root-only backups before either live replacement. Its failure trap restores both live files after a failed promotion or post-promotion validation and cleans only the exact generated paths. The old retrieval copy remains intact until the new live environment validates.

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
key_next=/root/agent-review-access-key.next
env_stage="/etc/agent-review/agent-review.env.next.$$"
env_backup="/etc/agent-review/agent-review.env.backup.$$"
key_backup="/root/agent-review-access-key.backup.$$"
live_replacements_started=0
rotation_cleanup() {
  status=$?
  if [ "$live_replacements_started" -eq 1 ]; then
    sudo mv -Tf "$env_backup" "$env_file" || true
    sudo mv -Tf "$key_backup" "$key_file" || true
    sudo systemctl restart agent-review || true
    wait_for_health || true
  fi
  sudo rm -f -- "$env_stage" "$key_next" "$env_backup" "$key_backup" || true
  exit "$status"
}
trap rotation_cleanup EXIT
sudo sh -c 'umask 077; test ! -e "$1"; openssl rand -hex 32 > "$1"' sh "$key_next"
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
sudo cp -p "$key_file" "$key_backup"
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
