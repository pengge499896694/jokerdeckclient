const fs = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DEFAULT_SUBSCRIPTION_URL, subscriptionUrl, parseNodes, buildCoreConfig } = require("./node-subscription");
const { checkLocalProxy, probeOfficialProxy } = require("./startup-proxy");

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function corePath(root, packaged, platform = process.platform, arch = process.arch) {
  const folder = platform === "win32" ? "win" : "mac";
  const executable = platform === "win32" ? "mihomo.exe" : "mihomo";
  return packaged
    ? path.join(root, "core", arch, executable)
    : path.join(root, "vendor", "core", folder, arch, executable);
}

class NodeRuntime {
  constructor({ root, packaged, userData, policy = {}, fetchImpl = fetch }) {
    this.root = root;
    this.packaged = packaged;
    this.userData = userData;
    this.policy = policy;
    this.fetchImpl = fetchImpl;
    this.child = null;
    this.port = 0;
    this.controllerPort = 0;
    this.nodes = 0;
    this.officialReachable = false;
    this.selectedNode = "";
    this.selectedLatency = null;
    this.latencies = [];
    this.nodeList = [];
    this.pinnedNode = "";
    this.connectPromise = null;
    this.preferredPort = 0;
    this.generation = 0;
  }

  status() {
    return {
      connected: Boolean(this.child && this.child.exitCode === null && this.child.signalCode === null && !this.child.killed),
      port: this.port,
      controllerPort: this.controllerPort,
      nodes: this.nodes,
      officialReachable: this.officialReachable,
      selectedNode: this.selectedNode,
      selectedLatency: this.selectedLatency,
      latencies: this.latencies,
    };
  }

  setPolicy(policy) {
    if (JSON.stringify(this.policy) !== JSON.stringify(policy)) this.disconnect();
    this.policy = policy;
  }

  async connect() {
    if (this.connectPromise) return this.connectPromise;
    const promise = this.connectInternal(this.generation);
    this.connectPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.connectPromise === promise) this.connectPromise = null;
    }
  }

  assertActive(generation) {
    if (generation !== this.generation) throw new Error("节点连接已取消");
  }

  async connectInternal(generation) {
    if (this.policy.enabled === false) throw new Error("节点服务已由管理员暂停");
    if (this.status().connected) {
      try {
        await this.measureAndSelectNode(this.nodeList, this.pinnedNode, this.controllerPort, this.port);
        this.assertActive(generation);
        this.officialReachable = true;
        return this.status();
      } catch (error) {
        if (generation === this.generation) this.officialReachable = false;
        throw error;
      }
    }
    const executable = corePath(this.root, this.packaged);
    await fs.access(executable).catch(() => { throw new Error("节点内核缺失，请重新安装客户端"); });
    const url = subscriptionUrl(this.policy.subscriptionUrl || DEFAULT_SUBSCRIPTION_URL);
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(15000), redirect: "follow" });
    if (!response.ok) throw new Error(`节点订阅读取失败（${response.status}）`);
    let responseUrl;
    try {
      responseUrl = new URL(response.url || url);
    } catch {
      throw new Error("节点订阅返回地址无效");
    }
    if (responseUrl.protocol !== "https:") throw new Error("节点订阅发生了非 HTTPS 跳转");
    const source = await response.text();
    this.assertActive(generation);
    const nodes = parseNodes(source, {
      disabled: this.policy.disabledNodes || [],
      countryCodes: this.policy.countryCodes,
    });
    if (!nodes.length) throw new Error("当前订阅没有可用的候选节点");
    const pinnedNode = nodes.some((node) => node.name === this.policy.pinnedNode)
      ? this.policy.pinnedNode : "";
    const directory = path.join(this.userData, "node-runtime");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (!this.preferredPort) {
      const saved = Number(await fs.readFile(path.join(directory, "port"), "utf8").catch(() => ""));
      if (Number.isInteger(saved) && saved >= 1024 && saved <= 65535) this.preferredPort = saved;
    }
    this.assertActive(generation);
    const port = this.preferredPort || await freePort();
    const controllerPort = await freePort();
    const configPath = path.join(directory, "config.yaml");
    await fs.writeFile(configPath, buildCoreConfig(nodes, port, pinnedNode, controllerPort), { mode: 0o600 });
    this.assertActive(generation);
    const child = spawn(executable, ["-d", directory, "-f", configPath], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let errorOutput = "";
    let spawnError = null;
    child.once("error", (error) => { spawnError = error; });
    child.stderr.on("data", (chunk) => { errorOutput = `${errorOutput}${chunk}`.slice(-2000); });
    this.child = child;
    this.port = port;
    child.once("exit", () => {
      if (this.child !== child) return;
      this.officialReachable = false;
    });
    this.controllerPort = controllerPort;
    this.nodes = nodes.length;
    this.nodeList = nodes;
    this.pinnedNode = pinnedNode;
    try {
      let lastError;
      for (let attempt = 0; attempt < 12; attempt++) {
        this.assertActive(generation);
        if (spawnError || child.exitCode !== null || child.signalCode !== null) break;
        try {
          await checkLocalProxy(`127.0.0.1:${port}`, 3000);
          this.assertActive(generation);
          await this.measureAndSelectNode(nodes, pinnedNode, controllerPort, port);
          this.assertActive(generation);
          this.officialReachable = true;
          this.preferredPort = port;
          await fs.writeFile(path.join(directory, "port"), String(port), { mode: 0o600 });
          this.assertActive(generation);
          return this.status();
        } catch (error) {
          this.assertActive(generation);
          lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error(spawnError?.message || errorOutput.trim() || lastError?.message || "节点无法连接 ChatGPT");
    } catch (error) {
      if (generation === this.generation) this.disconnect();
      throw error;
    }
  }

  disconnect() {
    this.generation += 1;
    this.connectPromise = null;
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
    this.child = null;
    this.port = 0;
    this.controllerPort = 0;
    this.nodes = 0;
    this.officialReachable = false;
    this.selectedNode = "";
    this.selectedLatency = null;
    this.latencies = [];
    this.nodeList = [];
    this.pinnedNode = "";
    return this.status();
  }

  async controllerRequest(pathname, options = {}) {
    const response = await this.fetchImpl(`http://127.0.0.1:${this.controllerPort}${pathname}`, {
      ...options,
      signal: options.signal || AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`节点控制器返回 ${response.status}`);
    return response;
  }

  async measureAndSelectNode(nodes, pinnedNode, controllerPort, proxyPort) {
    const candidates = pinnedNode ? nodes.filter((node) => node.name === pinnedNode) : nodes;
    const target = encodeURIComponent("https://chatgpt.com/cdn-cgi/trace");
    const results = await Promise.all(candidates.map(async (node) => {
      const started = Date.now();
      try {
        const response = await this.controllerRequest(
          `/proxies/${encodeURIComponent(node.name)}/delay?url=${target}&timeout=3000`,
          { signal: AbortSignal.timeout(5000) },
        );
        const body = await response.json();
        const delay = Number(body.delay);
        if (!Number.isFinite(delay) || delay <= 0) throw new Error("延迟无效");
        return { name: node.name, latency: delay, ok: true };
      } catch (error) {
        return { name: node.name, latency: null, ok: false, error: error.message || "测速失败", elapsed: Date.now() - started };
      }
    }));
    results.sort((a, b) => (a.latency ?? Number.POSITIVE_INFINITY) - (b.latency ?? Number.POSITIVE_INFINITY));
    this.latencies = results;
    for (const candidate of results.filter((entry) => entry.ok)) {
      await this.controllerRequest("/proxies/JOKERDECK", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: candidate.name }),
      });
      try {
        await probeOfficialProxy(`127.0.0.1:${proxyPort}`, 3500);
        this.selectedNode = candidate.name;
        this.selectedLatency = candidate.latency;
        return;
      } catch (error) {
        candidate.ok = false;
        candidate.error = error.message || "官方站点验证失败";
      }
    }
    this.latencies = results;
    if (this.selectedNode && this.status().connected) {
      await this.controllerRequest("/proxies/JOKERDECK", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: this.selectedNode }),
      });
    }
    throw new Error("没有节点能访问官方站点，请更换订阅或稍后重试");
  }
}

module.exports = { NodeRuntime, corePath };
