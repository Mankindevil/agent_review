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
sudo systemctl status agent-review --no-pager
readlink -f /opt/agent-review/app
curl --fail --silent --show-error https://14.103.143.171/api/health
curl --fail --silent --show-error --output /dev/null https://14.103.143.171/
curl --fail --silent --show-error --output /dev/null https://14.103.143.171/agent-check.html
sudo journalctl -u agent-review --since '24 hours ago' --no-pager
sudo systemctl status nginx --no-pager
sudo journalctl -u nginx --since '24 hours ago' --no-pager
```

The health response must report `ok: true`. The existing failed `cloud-monitor-agent` and `console-setup` units are unrelated to this platform; record and investigate them separately unless evidence links them to the incident.

## Restart and reboot validation

Do not assume a restart is immediately ready. Restart, then condition-poll the health endpoint:

```bash
sudo systemctl restart agent-review
for attempt in $(seq 1 30); do
  curl --fail --silent --show-error https://14.103.143.171/api/health && break
  sleep 2
done
curl --fail --silent --show-error https://14.103.143.171/api/health
```

On failure, collect bounded evidence before retrying:

```bash
sudo systemctl status agent-review --no-pager
sudo journalctl -u agent-review -n 200 --no-pager
sudo nginx -t
```

After a reboot verify application, release target, endpoint, proxy, and firewall:

```bash
sudo systemctl is-active agent-review
readlink -f /opt/agent-review/app
curl --fail --silent --show-error https://14.103.143.171/api/health
sudo systemctl is-active nginx
sudo ufw status verbose
```

## Safe release and rollback

Release directories are immutable and named with a full Git SHA. Validate a candidate before switching. Do not edit files through `/opt/agent-review/app`.

```bash
release_sha='<approved full Git SHA>'
release_dir="/opt/agent-review/releases/$release_sha"
test -d "$release_dir"
test -f "$release_dir/package.json"
readlink -f /opt/agent-review/app
sudo ln -s "$release_dir" /opt/agent-review/app.next
sudo mv -T /opt/agent-review/app.next /opt/agent-review/app
sudo systemctl restart agent-review
for attempt in $(seq 1 30); do
  curl --fail --silent --show-error https://14.103.143.171/api/health && break
  sleep 2
done
curl --fail --silent --show-error https://14.103.143.171/api/health
```

If validation fails, switch only to a known retained directory. The documented active SHA is a rollback target while it remains present:

```bash
rollback_sha='29324596a665206ff273bdba94e9a98f0a131acd'
rollback_dir="/opt/agent-review/releases/$rollback_sha"
test -d "$rollback_dir"
sudo ln -s "$rollback_dir" /opt/agent-review/app.next
sudo mv -T /opt/agent-review/app.next /opt/agent-review/app
sudo systemctl restart agent-review
for attempt in $(seq 1 30); do
  curl --fail --silent --show-error https://14.103.143.171/api/health && break
  sleep 2
done
curl --fail --silent --show-error https://14.103.143.171/api/health
```

If a switch is interrupted, inspect the explicit `app` and `app.next` paths before acting. Do not remove release directories during an incident.

## Backup and restore

Back up state before a release and on the operations schedule. Keep backups outside the state directory with restrictive permissions:

```bash
backup_dir=/var/backups/agent-review
sudo install -d -o root -g root -m 0700 "$backup_dir"
sudo cp -p /var/lib/agent-review/evaluations.json "$backup_dir/evaluations.json.$(date -u +%Y%m%dT%H%M%SZ)"
sudo sha256sum "$backup_dir"/evaluations.json.*
```

Restore only a named backup; first preserve the current state, stop the service, enforce owner and mode, then poll readiness:

```bash
restore_file='/var/backups/agent-review/evaluations.json.<UTC timestamp>'
test -f "$restore_file"
sudo cp -p /var/lib/agent-review/evaluations.json /var/backups/agent-review/evaluations.json.pre-restore
sudo systemctl stop agent-review
sudo cp "$restore_file" /var/lib/agent-review/evaluations.json
sudo chown root:root /var/lib/agent-review/evaluations.json
sudo chmod 0600 /var/lib/agent-review/evaluations.json
sudo systemctl start agent-review
for attempt in $(seq 1 30); do
  curl --fail --silent --show-error https://14.103.143.171/api/health && break
  sleep 2
done
curl --fail --silent --show-error https://14.103.143.171/api/health
```

## Configuration and secret rotation

Check configuration metadata without exposing contents:

```bash
sudo stat -c '%U:%G %a %n' /etc/agent-review/agent-review.env
```

Expected metadata is `root:root 600`. Use `sudoedit /etc/agent-review/agent-review.env` for changes, never commands that print it.

The browser diagnostics retrieval copy is `/root/agent-review-access-key.txt`, also `root:root` mode `0600`. Authorized operators retrieve it only through their approved privileged-access procedure. During rotation, create a replacement without printing it, update `AGENT_DIAGNOSTICS_ACCESS_KEY` in the environment file to the same value, then restart and poll. Updating just one location is invalid.

```bash
sudo sh -c 'umask 077; openssl rand -hex 32 > /root/agent-review-access-key.txt'
sudo chown root:root /root/agent-review-access-key.txt
sudo chmod 0600 /root/agent-review-access-key.txt
sudo stat -c '%U:%G %a %n' /root/agent-review-access-key.txt
sudoedit /etc/agent-review/agent-review.env
sudo systemctl restart agent-review
for attempt in $(seq 1 30); do
  curl --fail --silent --show-error https://14.103.143.171/api/health && break
  sleep 2
done
curl --fail --silent --show-error https://14.103.143.171/api/health
```

`PANDA_DATA_ACCESS_KEY` is absent, so the public Panda query gateway remains closed. Internal auto-verification is configured. Do not open the public gateway as an incident workaround without an approved change and separate access key.

## Certificate and firewall

The IP certificate is a short-lived Let's Encrypt certificate. The `agent-review-certbot.timer` runs every 12 hours. Check it and perform the prescribed dry run:

```bash
sudo systemctl status agent-review-certbot.timer --no-pager
sudo systemctl list-timers agent-review-certbot.timer --all
sudo openssl s_client -connect 14.103.143.171:443 -servername 14.103.143.171 </dev/null 2>/dev/null | openssl x509 -noout -dates -issuer
sudo /opt/certbot/bin/certbot renew --dry-run
```

Test Nginx before any reload:

```bash
sudo nginx -t
sudo systemctl reload nginx
sudo ufw status verbose
sudo ufw status numbered
```

Preserve the approved SSH management path before modifying firewall rules.

## SSH trust boundary and incidents

SSH key access uses a documented, human-accepted trust-on-first-use boundary. The pinned host-key fingerprint is in the deployment record; compare the presented fingerprint before accepting a new or changed host key. Never include or request an SSH password.

For an incident: stabilize with service/Nginx/health checks; record UTC time, symlink target, statuses, and bounded logs with secrets redacted; roll back an implicated release; preserve then restore state only when needed; and escalate any credential exposure for rotation. For certificate issues inspect timer, expiry, renewal logs, and Nginx before changing application or firewall settings. Make one reversible observable change at a time—never use broad deletion, mass release cleanup, or unverified configuration rewrites.
