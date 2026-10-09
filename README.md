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

发布前更新 `package.json`、`package-lock.json` 与 `CHANGELOG.md`。推送 `vX.Y.Z` tag 后，GitHub Actions 构建 macOS ARM/Intel 和 Windows x64 安装包，生成含 SHA-256 的 `latest.json`，作为 `/client-site/switch-latest.json` 上传官网，同时上传安装包、`site/index.html` 与图标，再创建 GitHub Release。独立路径避免旧客户端覆盖 Switch 更新清单。客户端启动时检查该清单，并可显示更新说明、下载和校验安装包。

仓库需设置 Actions secrets：`CLIENT_DEPLOY_HOST`、`CLIENT_DEPLOY_USER`、`CLIENT_DEPLOY_SSH_KEY`、`CLIENT_DEPLOY_KNOWN_HOSTS`。设置 Actions variables：`CLIENT_SITE_DIR`（官网 `client-site` 的服务器目录）、`CLIENT_DOWNLOAD_DIR`（官网 `/client/download/` 的服务器目录）。`CLIENT_DEPLOY_KNOWN_HOSTS` 填已核验的服务器 SSH host key 行。缺少配置时发布任务会失败，不会创建一个无法从官网下载安装的 Release。

macOS 对外分发建议另设 `MAC_CERTIFICATE_P12`、`MAC_CERTIFICATE_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD` 和 `APPLE_TEAM_ID`，供 electron-builder 使用 Developer ID 签名和公证。未配置证书时 CI 会执行临时签名并验证应用完整性，但 Gatekeeper 仍可能要求用户手动允许首次打开。Windows 代码签名证书尚未配置。

图标源文件是 `assets/icon.svg`，构建使用 `assets/icon.png`。修改 SVG 后可以用 `sharp` 重新生成 PNG。

不勾选“保持登录状态”时，登录令牌只保留在当前进程内；退出账号会清除客户端令牌。已写入 Codex/Claude Code 的 API Key 仍有效，需要在中转站手动撤销。

中文启动由 [codex-desktop-zh](https://github.com/shibaweidu/codex-desktop-zh) v0.7.7 提供；桌面控制 MCP 由 [QwenLM/open-computer-use](https://github.com/QwenLM/open-computer-use) v0.2.3 提供。两套程序随安装包提供，无需额外安装 npm。macOS 使用桌面控制时需在系统设置为 Open Computer Use 授予辅助功能与屏幕录制权限，无需启用内核扩展或降低启动安全策略。来源、版本和许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

客户端不会修改系统代理，也不会绕过官方账号、地区、插件或安全授权。独立 MCP 提供的是本机桌面控制工具，不能改变官方 Computer Use 插件的账号权限。
