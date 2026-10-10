# Jokerdeck Switch

跨平台 Electron 客户端，用于登录 JokerApi、选择分组、创建专用 API Key、探测线路并启动本机 Codex。

## 开发

```bash
npm install
npm start
```

## 构建

```bash
npm run dist:mac
npm run dist:win
```

发布前更新 `package.json`、`package-lock.json` 与 `CHANGELOG.md`。推送 `vX.Y.Z` tag 后，GitHub Actions 构建 macOS ARM/Intel 和 Windows x64 安装包，生成含 SHA-256 的 `latest.json`，作为 `/client/download/switch-latest.json` 上传官网，同时上传安装包、`site/index.html` 与图标，再创建 GitHub Release。独立路径避免旧客户端覆盖 Switch 更新清单。客户端启动时检查该清单，并可显示更新说明、下载和校验安装包。

仓库需设置 Actions secrets：`CLIENT_DEPLOY_HOST`、`CLIENT_DEPLOY_USER`、`CLIENT_DEPLOY_SSH_KEY`、`CLIENT_DEPLOY_KNOWN_HOSTS`。设置 Actions variables：`CLIENT_SITE_DIR`（官网 `client-site` 的服务器目录）、`CLIENT_DOWNLOAD_DIR`（官网 `/client/download/` 的服务器目录）。`CLIENT_DEPLOY_KNOWN_HOSTS` 填已核验的服务器 SSH host key 行。缺少配置时发布任务会失败，不会创建一个无法从官网下载安装的 Release。

macOS 对外分发建议另设 `MAC_CERTIFICATE_P12`、`MAC_CERTIFICATE_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD` 和 `APPLE_TEAM_ID`，供 electron-builder 使用 Developer ID 签名和公证。未配置证书时 CI 会执行临时签名并验证应用完整性，但 Gatekeeper 仍可能要求用户手动允许首次打开。Windows 代码签名证书尚未配置。

图标源文件是 `assets/icon.svg`，构建使用 `assets/icon.png`。修改 SVG 后可以用 `sharp` 重新生成 PNG。

不勾选“保持登录状态”时，登录令牌只保留在当前进程内；退出账号会清除客户端令牌。已写入 Codex/Claude Code 的 API Key 仍有效，需要在中转站手动撤销。

中文启动由 [codex-desktop-zh](https://github.com/shibaweidu/codex-desktop-zh) v0.7.7 提供；桌面控制 MCP 由 [QwenLM/open-computer-use](https://github.com/QwenLM/open-computer-use) v0.2.3 提供。两套程序随安装包提供，无需额外安装 npm。macOS 首次启用桌面控制时会将组件复制到 `~/Applications/Jokerdeck Computer Use.app`，以固定路径申请辅助功能与屏幕录制权限；无需启用内核扩展或降低启动安全策略。来源、版本和许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

客户端不会修改系统代理，也不会绕过官方账号、地区、插件或安全授权。独立 MCP 提供的是本机桌面控制工具，不能改变官方 Computer Use 插件的账号权限。

## 官方 Computer Use 节点

客户端的“官方 Computer Use 节点”开关从 HTTPS 订阅读取候选节点，逐个测试到 ChatGPT 的延迟，选择最低延迟的候选，并启动只绑定 `127.0.0.1` 的本机 Mihomo 代理。代理只负责网络出口和节点切换，Codex 仍写入 JokerApi 中转地址与 API Key，不会因为启用代理而要求官方登录。使用者仍需在 Codex 官方设置中开启 Computer Use，并自行确认账号可用。代理随客户端常驻运行，不修改系统代理。

客户端登录后请求 `GET /api/v1/client/node-policy`，使用现有 Bearer token。服务端接口尚未部署时节点功能不可用。服务端按登录用户返回如下 `data` 对象，超管操作由服务端鉴权并持久化：

```json
{
  "enabled": true,
  "subscription_url": "https://example.org/nodes.yaml",
  "disabled_nodes": ["US-Slow"],
  "pinned_node": "US-Fast"
}
```

`disabled_nodes` 是全局停用的订阅节点名，`pinned_node` 是当前用户指定节点名，空值表示自动测速。服务端应限制订阅地址的编辑权限，并考虑公共订阅不提供逐用户使用限额，节点配额与稳定性由订阅提供方承担。客户端按节点名称前缀筛选候选地区，节点名不能证明实际出口地区或官方功能资格。
