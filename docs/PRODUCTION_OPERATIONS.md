# Production Operations Guide

Run these commands on the production host as an authorized administrator. Never put credentials in a terminal transcript, ticket, chat, shell history, or this document.

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
  curl --fail --silent --show-error --max-redirs 0 https://14.103.143.171/api/health |
    python3 -c 'import json, sys; raise SystemExit(0 if json.load(sys.stdin).get("ok") is True else 1)'
}
require_200() {
  local url="$1" status
  status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-redirs 0 "$url")"
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
  curl --fail --silent --show-error --max-redirs 0 https://14.103.143.171/api/health |
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
  curl --fail --silent --show-error --max-redirs 0 https://14.103.143.171/api/health |
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
  curl --fail --silent --show-error --max-redirs 0 https://14.103.143.171/api/health |
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
release_dir="/opt/agent-review/releases/$release_sha"
test -d "$release_dir"
test -f "$release_dir/package.json"
release_dir="$(readlink -f "$release_dir")"
stage_link="/opt/agent-review/app.next.$$"
trap 'sudo rm -f -- "$stage_link"' EXIT
sudo ln -s "$release_dir" "$stage_link"
test "$(readlink -f "$stage_link")" = "$release_dir"
sudo mv -Tf "$stage_link" /opt/agent-review/app
trap - EXIT
sudo systemctl restart agent-review
wait_for_health
```

If validation fails, switch only to a known retained directory. The documented active SHA is a rollback target while it remains present:

```bash
set -euo pipefail
health_ok() {
  curl --fail --silent --show-error --max-redirs 0 https://14.103.143.171/api/health |
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
rollback_dir="/opt/agent-review/releases/$rollback_sha"
test -d "$rollback_dir"
test -f "$rollback_dir/package.json"
rollback_dir="$(readlink -f "$rollback_dir")"
stage_link="/opt/agent-review/app.next.$$"
trap 'sudo rm -f -- "$stage_link"' EXIT
sudo ln -s "$rollback_dir" "$stage_link"
test "$(readlink -f "$stage_link")" = "$rollback_dir"
sudo mv -Tf "$stage_link" /opt/agent-review/app
trap - EXIT
sudo systemctl restart agent-review
wait_for_health
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
  curl --fail --silent --show-error --max-redirs 0 https://14.103.143.171/api/health |
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
restore_cleanup() {
  status=$?
  if [ -n "$restore_tmp" ]; then sudo rm -f -- "$restore_tmp" || true; fi
  sudo systemctl start agent-review || true
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
sudo systemctl start agent-review
trap - EXIT
wait_for_health
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
  curl --fail --silent --show-error --max-redirs 0 https://14.103.143.171/api/health |
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
  sudo python3 - "$1" "$key_next" <<'PY'
import hmac, pathlib, re, sys
env_path, key_path = map(pathlib.Path, sys.argv[1:])
key = key_path.read_text(encoding='utf-8').strip()
pattern = re.compile(r'^\s*(?:export\s+)?AGENT_DIAGNOSTICS_ACCESS_KEY\s*=\s*(.*?)\s*$')
values = [match.group(1) for line in env_path.read_text(encoding='utf-8').splitlines() if (match := pattern.match(line))]
raise SystemExit(0 if len(values) == 1 and hmac.compare_digest(values[0], key) else 1)
PY
}
validate_env_key "$env_stage"
sudo cp -p "$env_file" "$env_backup"
sudo cp -p "$key_file" "$key_backup"
live_replacements_started=1
sudo mv -Tf "$env_stage" "$env_file"
sudo mv -Tf "$key_next" "$key_file"
validate_env_key "$env_file"
trap - EXIT
sudo rm -f -- "$env_backup" "$key_backup"
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
