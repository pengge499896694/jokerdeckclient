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

发布前更新 `package.json`、`package-lock.json` 与 `CHANGELOG.md`。推送 `vX.Y.Z` tag 后，GitHub Actions 构建 macOS ARM/Intel 和 Windows x64 安装包，生成含 SHA-256 的 `latest.json`，上传官网，再创建 GitHub Release。客户端启动时检查该清单，并可显示更新说明、下载和校验安装包。

仓库需设置 Actions secrets：`CLIENT_DEPLOY_HOST`、`CLIENT_DEPLOY_USER`、`CLIENT_DEPLOY_SSH_KEY`、`CLIENT_DEPLOY_KNOWN_HOSTS`。设置 Actions variables：`CLIENT_SITE_DIR`（官网 `client-site` 的服务器目录）、`CLIENT_DOWNLOAD_DIR`（官网 `/client/download/` 的服务器目录）。`CLIENT_DEPLOY_KNOWN_HOSTS` 填已核验的服务器 SSH host key 行。缺少配置时发布任务会失败，不会创建一个无法从官网下载安装的 Release。

macOS 对外分发建议另设 `MAC_CERTIFICATE_P12`、`MAC_CERTIFICATE_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD` 和 `APPLE_TEAM_ID`，供 electron-builder 签名和公证。当前本机构建未签名，首次打开可能被 Gatekeeper 拦截。Windows 代码签名证书尚未配置。

图标源文件是 `assets/icon.svg`，构建使用 `assets/icon.png`。修改 SVG 后可以用 `sharp` 重新生成 PNG。

不勾选“保持登录状态”时，登录令牌只保留在当前进程内；退出账号会清除客户端令牌。已写入 Codex/Claude Code 的 API Key 仍有效，需要在中转站手动撤销。

客户端不会修改系统代理，也不会绕过官方账号、地区、插件或安全授权。Computer Use 状态只做本机能力检测，最终权限由官方应用和系统授权决定。
