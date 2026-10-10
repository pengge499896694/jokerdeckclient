const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const { corePath, NodeRuntime } = require("../src/node-runtime");

test("resolves each packaged proxy core from app resources", () => {
  assert.equal(corePath("/app/resources", true, "darwin", "arm64"), path.join("/app/resources", "core", "arm64", "mihomo"));
  assert.equal(corePath("C:\\resources", true, "win32", "x64"), path.join("C:\\resources", "core", "x64", "mihomo.exe"));
});

test("disconnect cancels a pending subscription fetch before starting the proxy", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jokerdeck-runtime-test-"));
  const executable = corePath(root, false);
  let finishFetch;
  try {
    await fs.mkdir(path.dirname(executable), { recursive: true });
    await fs.writeFile(executable, "");
    const runtime = new NodeRuntime({
      root,
      userData: root,
      fetchImpl: () => new Promise((resolve) => { finishFetch = resolve; }),
    });
    const pending = runtime.connect();
    while (!finishFetch) await new Promise((resolve) => setImmediate(resolve));
    runtime.disconnect();
    finishFetch({ ok: true, url: "https://example.com/sub", text: async () => "proxies: []" });
    await assert.rejects(pending, /节点连接已取消/);
    assert.equal(runtime.status().connected, false);
    assert.equal(runtime.child, null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("disconnect prevents an in-flight refresh from restoring reachable status", async () => {
  const runtime = new NodeRuntime({ root: "/unused", userData: "/unused", packaged: false });
  runtime.child = { exitCode: null, signalCode: null, killed: false, kill() { this.killed = true; } };
  let finishProbe;
  runtime.measureAndSelectNode = () => new Promise((resolve) => { finishProbe = resolve; });
  const pending = runtime.connect();
  runtime.disconnect();
  finishProbe();
  await assert.rejects(pending, /节点连接已取消/);
  assert.equal(runtime.status().officialReachable, false);
  assert.equal(runtime.status().connected, false);
});

test("failed refresh restores the last verified proxy route", async () => {
  const runtime = new NodeRuntime({ root: "/unused", userData: "/unused", packaged: false });
  runtime.selectedNode = "previous";
  runtime.status = () => ({ connected: true });
  const calls = [];
  runtime.controllerRequest = async (route, options) => {
    calls.push({ route, options });
    if (route.includes("/delay?")) throw new Error("probe failed");
    return { ok: true };
  };
  await assert.rejects(runtime.measureAndSelectNode([{ name: "candidate" }], "", 1234, 5678), /没有节点能访问/);
  assert.equal(calls.at(-1).route, "/proxies/JOKERDECK");
  assert.equal(JSON.parse(calls.at(-1).options.body).name, "previous");
});
