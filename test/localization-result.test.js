const test = require("node:test");
const assert = require("node:assert/strict");
const { localizedLaunchResult } = require("../src/localization-result");

test("reports a Chinese UI even when the native menu cannot be localized", () => {
  assert.deepEqual(localizedLaunchResult({ ok: false, code: 2, output: "pid=123; renderer_port=1; inspector_port=2\nlocale=true; menu=false" }), {
    started: true,
    localized: true,
    warning: "Codex 中文界面已生效，但原生菜单未能汉化",
  });
});

test("does not report localization when only the native menu succeeds", () => {
  const result = localizedLaunchResult({ ok: false, code: 2, output: "pid=123\nlocale=false; menu=true" });
  assert.equal(result.started, true);
  assert.equal(result.localized, false);
  assert.match(result.warning, /中文界面未验证/);
});

test("does not mistake an unknown launcher failure for a launched app", () => {
  assert.throws(() => localizedLaunchResult({ ok: false, code: 1, output: "launch failed" }), /launch failed/);
  assert.throws(() => localizedLaunchResult({ ok: true, code: 0, output: "" }), /未返回 Codex 启动状态/);
});
