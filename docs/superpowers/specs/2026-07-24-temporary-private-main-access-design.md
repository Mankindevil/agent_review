# 临时隐藏正式测评平台设计

日期：2026-07-24

## 目标

公网只允许选手使用 Agent Card 技术预检平台；正式测评页面、历史记录和其他 API 暂时不向公网开放。管理员继续通过既有 SSH 密钥和端口转发访问完整平台，不增加应用登录功能。

## 公网路由

Nginx HTTPS 只放行：

- `GET /agent-check`：内部代理到应用的 Agent Card 技术预检页面；
- `GET /agent-check.js` 与 `GET /agent-check.css`：预检页面静态资源；
- `POST /api/agent-diagnostics`：仍由 `AGENT_DIAGNOSTICS_ACCESS_KEY` 校验；
- `GET /api/health`：保留最小运维健康检查；
- `GET /agent-check.html`：永久重定向到 `/agent-check`。

其他路径统一返回 `404`，不代理到正式测评应用。HTTP 端口继续只处理 ACME challenge，其余请求跳转 HTTPS。

应用自身也把 `/agent-check` 映射到 `public/agent-check.html`，避免无后缀入口只在 Nginx 下有效。旧的 `.html` 路径在生产 Nginx 重定向，兼容已有书签。

## 管理员访问

管理员使用既有 SSH 私钥建立隧道：

```powershell
ssh -N -L 4173:127.0.0.1:4173 root@14.103.143.171
```

随后访问 `http://127.0.0.1:4173/`。该流量直接进入服务器回环地址上的 Node 服务，不经过公网 Nginx 路由。

## 密钥

部署时生成新的高熵 `AGENT_DIAGNOSTICS_ACCESS_KEY`，原子更新 `/etc/agent-review/agent-review.env`，权限保持 `root:root 0600`，并创建同权限备份。密钥只用于测试平台 API，不解锁正式测评平台。

## 验证与回滚

上线前运行全量测试、语法检查和 `nginx -t`。上线后验证：

- `/agent-check`、JS、CSS 返回 `200`；
- `/agent-check.html` 重定向到 `/agent-check`；
- 无密钥诊断请求返回 `401`；
- `/`、`/api/evaluations` 和 `/methodology.html` 返回 `404`；
- SSH 隧道仍可访问完整平台；
- 服务与健康检查正常。

回滚时恢复 Nginx 配置备份和环境文件备份，然后 reload Nginx、restart `agent-review`。
