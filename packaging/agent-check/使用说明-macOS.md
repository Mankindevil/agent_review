# Agent Card 自测台（macOS）使用说明

## 快速启动

本安装包同时支持 Apple Silicon 与 Intel Mac，并自动选择对应运行环境。无需安装 Docker，也无需安装 Node.js。

1. 将 ZIP 完整解压到一个普通文件夹。
2. 双击 `start.command`。
3. 等待浏览器自动打开 <http://localhost:4173/agent-check>。
4. 按页面提示上传或粘贴 Agent Card，或填写 Card URL/服务根地址。
5. 停止服务时回到终端窗口，按 `Ctrl+C`，然后关闭窗口。

如果 macOS 阻止运行，先确认安装包来自赛事官方，再打开“系统设置”→“隐私与安全性”允许本次运行。也可在终端中执行：

```bash
xattr -dr com.apple.quarantine "/你的/Agent Card 自测台目录"
chmod +x "/你的/Agent Card 自测台目录/start.command"
```

不要对来源不明的文件执行上述命令。

## 本机 Agent 地址

自测台和选手的 Agent 都运行在同一台电脑时，Agent Card 中可以使用 `localhost` 指向这台 Mac。默认配置允许诊断本机和局域网 Agent，但自测台网页自身只监听本机回环地址，不会对局域网开放。

## 修改端口

用文本编辑器打开 `config.env`，修改：

```dotenv
PORT=4173
```

如果改成其他端口，启动脚本不会自动调整浏览器地址，请手动访问 `http://localhost:新端口/agent-check`。

## 常见问题

- “端口已被占用”：关闭另一个占用 4173 的程序，或修改 `config.env` 中的端口。
- “没有执行权限”：在终端执行上面的 `chmod +x` 命令。
- Card URL 不可达：确认 URL 完整、Agent 服务已经启动，并且本机网络可以访问。
- Agent 超时：先确认 Agent 能正常响应，再在页面选择更长的响应上限。
- Token 错误：确认只填写 Token 本身，不要重复填写 `Bearer ` 前缀。

## 安全提示

只在可信电脑上输入 Agent Token，不要复用生产环境的高权限 Token。不要把 `HOST` 改成局域网或公网地址；本地 HTTP 仅适合 `localhost` 回环访问。本自测台不会保存 Card、Token 或诊断结果。
