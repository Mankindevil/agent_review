# Agent 评测平台生产部署 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将主评测平台和 Agent Card 测试平台安全、可恢复地部署到单台 Ubuntu 22.04 服务器，并通过公网可信 HTTPS 提供服务。

**Architecture:** Node.js 24 LTS 应用以非特权用户在 `127.0.0.1:4173` 运行，systemd 负责守护，Nginx 负责公网 TLS 和长请求反向代理。代码使用按提交 SHA 命名的版本目录与原子符号链接发布，敏感配置独立存放在 root-only 环境文件中。

**Tech Stack:** Node.js 24 LTS、Ubuntu 22.04、systemd、Nginx、UFW、Certbot 5.4+、Let’s Encrypt IP address certificate、Python 3 venv、PandaAI `panda-data==0.0.12`

## Global Constraints

- 主站 `/` 与测试台 `/agent-check.html` 必须由同一个服务提供。
- Node.js 端口必须只监听 `127.0.0.1:4173`。
- 公网只允许 `22/tcp`、`80/tcp` 和 `443/tcp`。
- 最长 20 分钟 Agent 任务需要至少 21 分钟反向代理读取超时。
- `.env`、平台访问密钥、模型密钥、PandaAI 凭据不得进入 Git、systemd 单元或 Nginx 配置。
- 应用发布目录只读，唯一应用持久写入目录为 `/var/lib/agent-review`。
- SSH 主机密钥必须匹配 `ssh-ed25519 SHA256:b6Lu/i26GlMdm7Ledxi4uMNfHv53z5B4YCRcw2CewCQ`。
- Node.js 使用官方 `v24.18.0` Linux x64 归档，SHA-256 为 `55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742`。
- 任何发布完成声明之前必须重新执行全部本地测试与远端验收。

---

### Task 1: 生产回环监听配置

**Files:**
- Create: `src/server-address.js`
- Create: `test/server-address.test.js`
- Modify: `server.js:172-175`

**Interfaces:**
- Consumes: `process.env.HOST`、`process.env.PORT`
- Produces: `resolveServerAddress(env): { host: string | undefined, port: number }`

- [ ] **Step 1: 写入失败测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveServerAddress } from '../src/server-address.js';

test('uses an explicit production host and numeric port', () => {
  assert.deepEqual(
    resolveServerAddress({ HOST: ' 127.0.0.1 ', PORT: '4173' }),
    { host: '127.0.0.1', port: 4173 }
  );
});

test('preserves the current all-interface default when HOST is absent', () => {
  assert.deepEqual(resolveServerAddress({}), { host: undefined, port: 4173 });
});

test('rejects invalid ports before starting the server', () => {
  assert.throws(() => resolveServerAddress({ PORT: '70000' }), /PORT/);
});
```

- [ ] **Step 2: 验证测试因模块缺失而失败**

Run: `npm test -- test/server-address.test.js`

Expected: FAIL，错误包含 `ERR_MODULE_NOT_FOUND`。

- [ ] **Step 3: 实现最小地址解析模块**

```js
export function resolveServerAddress(env = process.env) {
  const port = Number(env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT 必须是 1 到 65535 之间的整数');
  }
  return {
    host: String(env.HOST || '').trim() || undefined,
    port
  };
}
```

在 `server.js` 顶部导入：

```js
import { resolveServerAddress } from './src/server-address.js';
```

将启动代码替换为：

```js
if (process.env.NODE_ENV !== 'test') {
  const { host, port } = resolveServerAddress();
  server.listen(port, host, () => {
    const displayHost = host || 'localhost';
    console.log(`Agent 锐评系统已启动：http://${displayHost}:${port}`);
  });
}
```

- [ ] **Step 4: 验证单测和完整测试**

Run: `npm test -- test/server-address.test.js`

Expected: 3 tests PASS。

Run: `npm test`

Expected: 全部测试通过，0 failures。

- [ ] **Step 5: 提交回环监听能力**

```bash
git add -- src/server-address.js test/server-address.test.js server.js
git commit -m "feat: support production listen host"
```

### Task 2: 可审计的生产配置文件

**Files:**
- Create: `deploy/agent-review.service`
- Create: `deploy/nginx-bootstrap.conf`
- Create: `deploy/nginx-production.conf`
- Create: `deploy/agent-review-certbot.service`
- Create: `deploy/agent-review-certbot.timer`
- Create: `test/deploy-config.test.js`

**Interfaces:**
- Consumes: `/etc/agent-review/agent-review.env`、`/opt/agent-review/app`、`/var/lib/agent-review`、`/var/www/letsencrypt`
- Produces: systemd 应用服务、Nginx bootstrap/TLS 模板、Certbot 续期 timer

- [ ] **Step 1: 写入配置契约测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (name) => readFile(new URL(`../deploy/${name}`, import.meta.url), 'utf8');

test('systemd runs as the dedicated user with a root-owned environment file', async () => {
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
  assert.match(production, /proxy_read_timeout 1260s/);
  assert.match(production, /ssl_certificate \/etc\/letsencrypt\/live\/__PUBLIC_IP__\/fullchain\.pem/);
});

test('certbot timer renews twice daily and reloads nginx', async () => {
  const service = await read('agent-review-certbot.service');
  const timer = await read('agent-review-certbot.timer');
  assert.match(service, /certbot renew --quiet --deploy-hook/);
  assert.match(timer, /OnUnitActiveSec=12h/);
});
```

- [ ] **Step 2: 验证测试因配置文件缺失而失败**

Run: `npm test -- test/deploy-config.test.js`

Expected: FAIL，错误包含 `ENOENT`。

- [ ] **Step 3: 写入 systemd 应用单元**

`deploy/agent-review.service`：

```ini
[Unit]
Description=Agent Review evaluation and diagnostics platform
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=agent-review
Group=agent-review
WorkingDirectory=/opt/agent-review/app
EnvironmentFile=/etc/agent-review/agent-review.env
ExecStart=/usr/local/bin/node server.js
Restart=on-failure
RestartSec=5s
TimeoutStartSec=30s
TimeoutStopSec=30s
LimitNOFILE=65536
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
ReadWritePaths=/var/lib/agent-review

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 4: 写入 Nginx bootstrap 与生产模板**

`deploy/nginx-bootstrap.conf`：

```nginx
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        default_type text/plain;
    }

    location = /api/health {
        proxy_pass http://127.0.0.1:4173;
        proxy_set_header Host $host;
    }

    location / {
        return 503;
    }
}
```

`deploy/nginx-production.conf`：

```nginx
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name __PUBLIC_IP__;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        default_type text/plain;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2 default_server;
    listen [::]:443 ssl http2 default_server;
    server_name __PUBLIC_IP__;

    ssl_certificate /etc/letsencrypt/live/__PUBLIC_IP__/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/__PUBLIC_IP__/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_timeout 1d;
    ssl_session_cache shared:TLS:10m;

    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header X-Frame-Options "SAMEORIGIN" always;

    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:4173;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_connect_timeout 10s;
        proxy_send_timeout 1260s;
        proxy_read_timeout 1260s;
    }
}
```

- [ ] **Step 5: 写入 Certbot 服务和 timer**

`deploy/agent-review-certbot.service`：

```ini
[Unit]
Description=Renew Agent Review IP certificate
After=network-online.target nginx.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/opt/certbot/bin/certbot renew --quiet --deploy-hook "/usr/sbin/nginx -s reload"
```

`deploy/agent-review-certbot.timer`：

```ini
[Unit]
Description=Twice-daily Agent Review certificate renewal

[Timer]
OnBootSec=15min
OnUnitActiveSec=12h
RandomizedDelaySec=30min
Persistent=true

[Install]
WantedBy=timers.target
```

- [ ] **Step 6: 验证配置契约和 JavaScript 语法**

Run: `npm test -- test/deploy-config.test.js`

Expected: 3 tests PASS。

Run: `npm run check`

Expected: `Syntax OK`，退出码 0。

- [ ] **Step 7: 提交生产配置**

```bash
git add -- deploy test/deploy-config.test.js
git commit -m "ops: add production service configuration"
```

### Task 3: 远端基础环境与版本发布

**Files:**
- Read: `.env`
- Read: `requirements-data.txt`
- Read: `docs/superpowers/specs/2026-07-24-production-deployment-design.md`
- Remote create: `/opt/agent-review/releases/<COMMIT_SHA>`
- Remote create: `/opt/agent-review/venv`
- Remote create: `/etc/agent-review/agent-review.env`
- Remote create: `/var/lib/agent-review`

**Interfaces:**
- Consumes: 当前 Git 提交归档、本地未提交的 `.env` 密钥值、`requirements-data.txt`
- Produces: Node.js 24、Python 数据 SDK 环境、不可变应用版本、原子 `app` 链接、root-only 生产环境文件

- [ ] **Step 1: 执行本地发布前验证**

Run: `npm test`

Expected: 全部测试通过，0 failures。

Run: `npm run check`

Expected: 退出码 0。

Run: `git status --short --branch`

Expected: 工作区干净，分支为 `codex/finance-roast`。

- [ ] **Step 2: 安装 Ubuntu 基础包**

通过已固定主机指纹的 SSH 会话执行：

```bash
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git nginx python3-venv ufw xz-utils
```

Expected: 所有包安装成功，`nginx -v`、`git --version`、`python3 --version` 可执行。

- [ ] **Step 3: 安装并校验 Node.js 24 LTS**

```bash
install -d -m 0755 /usr/local/lib/nodejs
cd /tmp
curl -fsSLO https://nodejs.org/download/release/v24.18.0/node-v24.18.0-linux-x64.tar.xz
echo '55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742  node-v24.18.0-linux-x64.tar.xz' | sha256sum -c -
tar -xJf node-v24.18.0-linux-x64.tar.xz -C /usr/local/lib/nodejs
ln -sfn /usr/local/lib/nodejs/node-v24.18.0-linux-x64/bin/node /usr/local/bin/node
ln -sfn /usr/local/lib/nodejs/node-v24.18.0-linux-x64/bin/npm /usr/local/bin/npm
ln -sfn /usr/local/lib/nodejs/node-v24.18.0-linux-x64/bin/npx /usr/local/bin/npx
node --version
npm --version
```

Expected: `node --version` 输出 `v24.18.0`，SHA-256 检查返回 `OK`。

- [ ] **Step 4: 创建运行身份和隔离目录**

```bash
getent passwd agent-review >/dev/null || useradd --system --home /var/lib/agent-review --shell /usr/sbin/nologin agent-review
install -d -o root -g agent-review -m 0750 /opt/agent-review /opt/agent-review/releases
install -d -o agent-review -g agent-review -m 0750 /var/lib/agent-review
install -d -o root -g root -m 0700 /etc/agent-review
install -d -o root -g root -m 0755 /var/www/letsencrypt
```

Expected: `agent-review` 没有登录 shell，目录所有者和权限与命令一致。

- [ ] **Step 5: 上传当前提交归档并验证**

本地执行：

```powershell
$sha = git rev-parse HEAD
git archive --format=tar.gz --output="$env:TEMP\agent-review-$sha.tar.gz" HEAD
```

通过 SFTP 上传到 `/tmp/agent-review-<COMMIT_SHA>.tar.gz`，远端执行：

```bash
install -d -o root -g agent-review -m 0750 /opt/agent-review/releases/<COMMIT_SHA>
tar -xzf /tmp/agent-review-<COMMIT_SHA>.tar.gz -C /opt/agent-review/releases/<COMMIT_SHA>
chown -R root:agent-review /opt/agent-review/releases/<COMMIT_SHA>
find /opt/agent-review/releases/<COMMIT_SHA> -type d -exec chmod 0750 {} +
find /opt/agent-review/releases/<COMMIT_SHA> -type f -exec chmod 0640 {} +
chmod 0750 /opt/agent-review/releases/<COMMIT_SHA>/scripts/*.py
sudo -u agent-review /usr/local/bin/npm --prefix /opt/agent-review/releases/<COMMIT_SHA> test
sudo -u agent-review /usr/local/bin/npm --prefix /opt/agent-review/releases/<COMMIT_SHA> run check
ln -sfn /opt/agent-review/releases/<COMMIT_SHA> /opt/agent-review/app.next
mv -Tf /opt/agent-review/app.next /opt/agent-review/app
```

Expected: 远端测试全部通过，`readlink -f /opt/agent-review/app` 指向当前提交目录。

- [ ] **Step 6: 创建 PandaAI Python 运行环境**

```bash
python3 -m venv /opt/agent-review/venv
/opt/agent-review/venv/bin/python -m pip install --upgrade pip
/opt/agent-review/venv/bin/python -m pip install -r /opt/agent-review/app/requirements-data.txt
/opt/agent-review/venv/bin/python /opt/agent-review/app/scripts/panda-data-bridge.py --probe
```

Expected: 最后一条输出包含 `"installed": true`。

- [ ] **Step 7: 安全写入生产环境文件**

使用项目 `src/env.js` 相同的规则从本地 `.env` 内存解析值，覆盖以下生产项并生成 64 位十六进制随机诊断访问密钥：

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=4173
DATA_FILE=/var/lib/agent-review/evaluations.json
ALLOW_PRIVATE_AGENT_URLS=false
PANDA_DATA_PYTHON=/opt/agent-review/venv/bin/python
AGENT_DIAGNOSTICS_ACCESS_KEY=<64-hex-random-value>
```

将每一项编码成 systemd `EnvironmentFile` 格式：`NAME="VALUE"`；值中的反斜线和双引号分别编码为 `\\` 与 `\"`，拒绝包含换行或 NUL 的值。通过 SFTP 写入临时文件 `/etc/agent-review/agent-review.env.new`，随后远端执行：

```bash
chown root:root /etc/agent-review/agent-review.env.new
chmod 0600 /etc/agent-review/agent-review.env.new
mv -f /etc/agent-review/agent-review.env.new /etc/agent-review/agent-review.env
```

Expected: `stat -c '%U:%G %a' /etc/agent-review/agent-review.env` 输出 `root:root 600`；任何命令输出均不包含环境值。

### Task 4: 服务、HTTPS 与防火墙上线

**Files:**
- Remote install: `/etc/systemd/system/agent-review.service`
- Remote install: `/etc/systemd/system/agent-review-certbot.service`
- Remote install: `/etc/systemd/system/agent-review-certbot.timer`
- Remote install: `/etc/nginx/sites-available/agent-review`

**Interfaces:**
- Consumes: Task 2 配置文件、Task 3 应用与环境
- Produces: `https://14.103.143.171/` 和 `https://14.103.143.171/agent-check.html`

- [ ] **Step 1: 安装并启动应用服务**

```bash
install -o root -g root -m 0644 /tmp/deploy/agent-review.service /etc/systemd/system/agent-review.service
systemd-analyze verify /etc/systemd/system/agent-review.service
systemctl daemon-reload
systemctl enable --now agent-review
systemctl is-active agent-review
curl -fsS http://127.0.0.1:4173/api/health
```

Expected: service 为 `active`，健康响应包含 `"ok":true`。

- [ ] **Step 2: 启用 bootstrap Nginx**

```bash
install -o root -g root -m 0644 /tmp/deploy/nginx-bootstrap.conf /etc/nginx/sites-available/agent-review
ln -sfn /etc/nginx/sites-available/agent-review /etc/nginx/sites-enabled/agent-review
if [ -L /etc/nginx/sites-enabled/default ]; then unlink /etc/nginx/sites-enabled/default; fi
nginx -t
systemctl enable --now nginx
systemctl reload nginx
curl -fsS http://127.0.0.1/api/health
```

Expected: `nginx -t` 成功，回环 HTTP 健康检查通过。

- [ ] **Step 3: 安装 Certbot 5.4+**

```bash
python3 -m venv /opt/certbot
/opt/certbot/bin/python -m pip install --upgrade pip
/opt/certbot/bin/python -m pip install 'certbot>=5.4,<6'
/opt/certbot/bin/certbot --version
```

Expected: Certbot 版本不低于 5.4。

- [ ] **Step 4: 配置防火墙且保持 SSH 可达**

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
ufw allow 80/tcp comment 'HTTP ACME'
ufw allow 443/tcp comment 'HTTPS Agent Review'
ufw --force enable
ufw status verbose
```

Expected: UFW active，仅列出 22、80、443 入站允许规则；当前 SSH 会话仍然连接。

- [ ] **Step 5: 从公网验证 80 端口后签发 IP 证书**

本地执行：

```powershell
Invoke-WebRequest -UseBasicParsing http://14.103.143.171/api/health
```

Expected: HTTP 200。

远端执行：

```bash
/opt/certbot/bin/certbot certonly \
  --non-interactive \
  --agree-tos \
  --register-unsafely-without-email \
  --preferred-profile shortlived \
  --webroot \
  --webroot-path /var/www/letsencrypt \
  --ip-address 14.103.143.171
```

Expected: `/etc/letsencrypt/live/14.103.143.171/fullchain.pem` 与 `privkey.pem` 存在。

- [ ] **Step 6: 切换生产 TLS 配置**

将 `nginx-production.conf` 中所有 `__PUBLIC_IP__` 替换为 `14.103.143.171` 后上传并执行：

```bash
install -o root -g root -m 0644 /tmp/deploy/nginx-production.conf /etc/nginx/sites-available/agent-review
nginx -t
systemctl reload nginx
curl -fsS https://14.103.143.171/api/health
```

Expected: HTTPS 健康检查通过，证书由受信任 CA 签发。

- [ ] **Step 7: 启用自动续期**

```bash
install -o root -g root -m 0644 /tmp/deploy/agent-review-certbot.service /etc/systemd/system/agent-review-certbot.service
install -o root -g root -m 0644 /tmp/deploy/agent-review-certbot.timer /etc/systemd/system/agent-review-certbot.timer
systemd-analyze verify /etc/systemd/system/agent-review-certbot.service /etc/systemd/system/agent-review-certbot.timer
systemctl daemon-reload
systemctl enable --now agent-review-certbot.timer
systemctl list-timers agent-review-certbot.timer --no-pager
/opt/certbot/bin/certbot renew --dry-run
```

Expected: timer 有下一次执行时间，dry-run 成功。

- [ ] **Step 8: 执行故障恢复和安全验收**

```bash
systemctl restart agent-review
systemctl is-active agent-review nginx
curl -fsS https://14.103.143.171/
curl -fsS https://14.103.143.171/agent-check.html
curl -fsS https://14.103.143.171/api/health
ss -lntp
ufw status numbered
journalctl -u agent-review --since '-10 minutes' --no-pager
```

Expected:

- 两个服务均为 `active`；
- 首页、测试台、健康接口返回成功；
- `4173` 只绑定 `127.0.0.1`；
- 无应用崩溃循环、权限错误或密钥输出；
- 未授权诊断请求返回 401，错误访问密钥返回 401。

### Task 5: 运维文档、最终验证与发布

**Files:**
- Create: `docs/PRODUCTION_OPERATIONS.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: 实际部署路径、服务名称、HTTPS 地址和验证结果
- Produces: 不含秘密的日常运维、升级、回滚、备份、恢复与密钥轮换手册

- [ ] **Step 1: 编写生产运维手册**

文档必须包含：

- `https://14.103.143.171/` 与 `/agent-check.html` 入口；
- `systemctl status/restart agent-review`；
- `journalctl -u agent-review`；
- `/api/health` 检查；
- 版本目录、`/opt/agent-review/app` 原子链接和回滚命令；
- `/var/lib/agent-review/evaluations.json` 备份与恢复；
- `/etc/agent-review/agent-review.env` 的 root-only 编辑和密钥轮换；
- Certbot timer、证书到期时间和 dry-run 检查；
- UFW 状态检查；
- 云监控代理和控制台字体两个既有失败单元不属于平台服务。

- [ ] **Step 2: 在 README 增加生产运维入口**

在部署/配置区域加入：

```markdown
生产服务器的部署结构、健康检查、升级、回滚、备份和密钥轮换见 [生产运维手册](docs/PRODUCTION_OPERATIONS.md)。
```

- [ ] **Step 3: 执行最终本地验证**

Run: `npm test`

Expected: 全部测试通过，0 failures。

Run: `npm run check`

Expected: 退出码 0。

Run: `git diff --check`

Expected: 无输出，退出码 0。

- [ ] **Step 4: 执行最终公网验证**

Run:

```powershell
$health = Invoke-RestMethod https://14.103.143.171/api/health
if (-not $health.ok) { throw 'Health check failed' }
(Invoke-WebRequest -UseBasicParsing https://14.103.143.171/).StatusCode
(Invoke-WebRequest -UseBasicParsing https://14.103.143.171/agent-check.html).StatusCode
```

Expected: health `ok` 为 true，两个页面状态码均为 200。

- [ ] **Step 5: 提交并推送部署成果**

```bash
git add -- docs/PRODUCTION_OPERATIONS.md README.md
git commit -m "docs: add production operations guide"
git push origin codex/finance-roast
```

Expected: 当前分支与 `origin/codex/finance-roast` 对齐。
