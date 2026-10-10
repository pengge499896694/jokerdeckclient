function localizedLaunchResult({ ok, code, output }) {
  if (!ok && code !== 2) throw new Error(output || "中文启动失败，请检查 Codex 安装状态");
  const report = String(output || "").match(/(?:^|\n)locale=(true|false); menu=(true|false)(?:\n|$)/);
  if (!report) throw new Error("汉化启动器未返回 Codex 启动状态");
  const localized = report[1] === "true";
  const menu = report[2] === "true";
  return {
    started: true,
    localized,
    warning: localized
      ? (menu ? "" : "Codex 中文界面已生效，但原生菜单未能汉化")
      : "Codex 已启动，但中文界面未验证成功；请查看汉化启动器日志",
  };
}

module.exports = { localizedLaunchResult };
