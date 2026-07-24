# Agent 评测平台生产部署设计

## 目标

将 Agent 评测平台与 Agent Card 测试平台作为同一个 Node.js 服务部署到一台全新的 Ubuntu 22.04 LTS 主机。部署需要满足：

- 主站 `/` 与测试台 `/agent-check.html` 同时可用；
- 应用进程异常退出、服务器重启后能够自动恢复；
- 公网只暴露 SSH、HTTP 与 HTTPS，不直接暴露 Node.js 端口；
- 平台访问密钥、模型密钥和数据源凭据不进入 Git；
- 使用可信 HTTPS，避免访问密钥在明文 HTTP 中传输；
- 部署步骤、配置和验证命令可重复执行和审计。

## 已确认的服务器基线

目标主机为 Ubuntu 22.04 LTS、x86_64，具备 16 个 CPU、62 GiB 内存和充足磁盘空间。部署前只有 SSH 端口监听，没有安装 Node.js、Git、Nginx、Docker 或 Certbot，也没有现存 Web 站点需要迁移。

服务器当前有两个与应用无关的失败单元：云监控代理和控制台字体初始化。部署不会修改这两个厂商或系统单元，应用验收将单独检查自身服务状态，避免把既有主机告警误判为部署失败。

## 方案选择

### 采用方案：原生 Node.js + systemd + Nginx

使用 Node.js 24 LTS 运行应用，以 systemd 管理进程，以 Nginx 终止 TLS 并反向代理到回环地址。代码部署在 `/opt/agent-review/app`，持久数据放在 `/var/lib/agent-review`，敏感环境变量放在 `/etc/agent-review/agent-review.env`。

选择该方案的原因：

- 项目没有生产依赖，原生 Node.js 部署链路短；
- systemd 与 Ubuntu 原生集成，可提供自动重启、启动顺序和日志；
- Nginx 能处理 TLS、上传大小、长请求和安全响应头；
- 目录、用户、配置与数据边界清晰，便于备份和升级。

### 未采用方案：Docker Compose

容器可增强镜像一致性，但当前服务器没有 Docker，项目也没有既有镜像流水线。为单个无依赖 Node.js 服务引入 Docker daemon、镜像构建和额外网络层，会增加本次部署的运维面。

### 未采用方案：Node.js 直接监听公网

直接暴露应用端口配置最少，但无法提供可靠 TLS、代理超时、安全头和静态入口治理，也会扩大应用进程的公网攻击面。

## 运行架构

请求链路：

1. 公网客户端访问 `https://<PUBLIC_IP>/` 或 `https://<PUBLIC_IP>/agent-check.html`；
2. Nginx 在 443 端口终止 TLS；
3. Nginx 将请求代理到 `127.0.0.1:4173`；
4. systemd 以非特权 `agent-review` 用户运行 Node.js 服务；
5. 应用读取 `/etc/agent-review/agent-review.env`，并将评测状态写入 `/var/lib/agent-review/evaluations.json`。

端口边界：

- `22/tcp`：SSH 运维；
- `80/tcp`：ACME HTTP-01 验证及 HTTPS 跳转；
- `443/tcp`：平台公网入口；
- `4173/tcp`：仅回环监听，不对公网开放。

## 软件和目录

### 软件

- Node.js 24 LTS 官方 Linux x64 二进制，并在安装时校验官方 SHA-256；
- Ubuntu 官方仓库提供的 Nginx、Git、Python 3 venv、UFW 与基础证书工具；
- Certbot 5.4 或更高版本，用于签发和续期裸 IPv4 的短期证书。

### 目录

- `/opt/agent-review/app`：只读应用发布内容；
- `/var/lib/agent-review`：评测持久数据，由运行用户写入；
- `/etc/agent-review/agent-review.env`：生产环境变量，权限 `0600`；
- `/var/www/letsencrypt`：ACME HTTP-01 webroot；
- `/etc/systemd/system/agent-review.service`：进程守护；
- `/etc/nginx/sites-available/agent-review`：反向代理和 TLS 配置。

## 身份与权限

创建无登录 shell 的系统用户 `agent-review`。应用目录归 root 管理，运行用户只读取代码；数据目录归 `agent-review` 管理；环境变量文件只允许 root 读取。systemd 单元启用合理的文件系统与权限沙箱，同时显式允许写入数据目录。

应用新增 `HOST` 配置并在生产环境设置为 `127.0.0.1`。这使端口隔离不只依赖防火墙，减少误配置导致的公网暴露。

## 配置与密钥

生产环境变量由本地已存在的 `.env` 生成，但部署时只传入服务器所需值，并补充：

- `NODE_ENV=production`
- `HOST=127.0.0.1`
- `PORT=4173`
- `DATA_FILE=/var/lib/agent-review/evaluations.json`
- `AGENT_DIAGNOSTICS_ACCESS_KEY=<随机高强度访问密钥>`
- `ALLOW_PRIVATE_AGENT_URLS=true`（当前私人部署需要让测试入口和正式测评访问服务器可达的内网/本机 Agent；公开多租户部署应恢复为 `false`）

任何密码、API key、Agent token 或访问密钥都不得写入文档、Git diff、systemd 单元或 Nginx 配置。环境变量文件通过受保护的传输会话写入，并设置为 root 专属。

## HTTPS

裸 IP 使用 Let’s Encrypt 的短期 IP 地址证书。证书有效期约六天，因此必须配置定时续期和 Nginx reload 部署钩子。流程为：

1. 先启用 80 端口的 ACME webroot 和临时 HTTP 站点；
2. 使用 Certbot 的 `shortlived` profile 和 `--ip-address` 请求证书；
3. 切换到 TLS 配置，并把 80 端口普通请求重定向到 HTTPS；
4. 创建 systemd timer 定期执行 `certbot renew`；
5. 通过 deploy hook 在证书更新后执行 `nginx -s reload`。

若证书签发因上游 CA 或云防火墙失败，应用仍保持仅回环监听，不会在明文 HTTP 下开放需要访问密钥的诊断调用；先修复证书链路，再开放正式入口。

## Nginx 行为

- 请求体上限略高于 Agent Card 上传接口上限；
- 代理读取超时覆盖最长 20 分钟评测，并保留少量网络余量；
- 禁用代理缓冲用于 SSE 事件流；
- 转发 `Host`、客户端地址和原始协议；
- 添加 HSTS、`X-Content-Type-Options`、`Referrer-Policy` 等响应头；
- ACME challenge 不重定向，其他 HTTP 请求跳转到 HTTPS。

## systemd 行为

- `Restart=on-failure` 并设置重启退避；
- 在网络就绪后启动，在 Nginx 之前或之后均可独立恢复；
- 使用 `EnvironmentFile` 注入密钥；
- 将 stdout/stderr 写入 journal；
- 设置启动超时、停止超时和文件描述符上限；
- 对 `/var/lib/agent-review` 提供写权限，对系统其他关键路径保持只读或不可访问。

## 防火墙

启用 UFW 前先显式允许现有 SSH 端口，随后允许 80 和 443。默认拒绝入站、允许出站。启用后在当前 SSH 会话内再次确认 22 端口规则和服务可达，避免锁定管理员。

## 发布与回滚

首次发布通过本地已验证提交生成归档并上传，不把本地 `.env` 或 `.git` 目录包含在归档中。发布前记录提交 SHA。

后续发布使用版本目录和原子符号链接：

- 发布到 `/opt/agent-review/releases/<COMMIT_SHA>`；
- 完成语法检查和测试后，将 `/opt/agent-review/app` 原子切换到该版本；
- 重启 systemd 服务并执行健康检查；
- 若健康检查失败，恢复前一个符号链接并重启。

首次部署也保留相同目录结构，避免下一次升级改变运维模型。

## 验收

部署完成必须执行以下新鲜验证：

1. 本地 `npm test` 与 `npm run check`；
2. 远端 Node.js 版本和发布 SHA；
3. `nginx -t` 与 systemd 单元验证；
4. `systemctl is-active agent-review nginx`；
5. 回环 `/api/health` 返回 `ok: true`；
6. 公网 HTTPS `/api/health`、`/`、`/agent-check.html` 可访问；
7. 错误的平台访问密钥返回 401，正确密钥能通过鉴权边界；
8. `ss` 证明 4173 只监听回环地址；
9. UFW 只开放 22、80、443；
10. 主动重启应用服务后再次通过健康检查；
11. Certbot renewal dry-run 或等价的续期配置检查；
12. 检查 journal 中没有持续崩溃、密钥泄漏或权限错误。

## 运维文档

部署完成后新增一份不包含秘密的生产运维文档，记录：

- 公网入口与两个平台页面；
- 服务状态、日志、重启和健康检查命令；
- 发布、回滚、数据备份和恢复；
- 证书续期检查；
- 密钥轮换方式；
- 已知的主机既有失败单元及其与平台的边界。
