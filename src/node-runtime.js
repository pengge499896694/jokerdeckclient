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
    this.nodes = 0;
    this.officialReachable = false;
  }

  status() {
    return {
      connected: Boolean(this.child && this.child.exitCode === null && this.child.signalCode === null && !this.child.killed),
      port: this.port,
      nodes: this.nodes,
      officialReachable: this.officialReachable,
    };
  }

  setPolicy(policy) {
    if (JSON.stringify(this.policy) !== JSON.stringify(policy)) this.disconnect();
    this.policy = policy;
  }

  async connect() {
    if (this.policy.enabled === false) throw new Error("节点服务已由管理员暂停");
    if (this.status().connected) {
      try {
        await probeOfficialProxy(`127.0.0.1:${this.port}`, 10000);
        this.officialReachable = true;
        return this.status();
      } catch (error) {
        this.officialReachable = false;
        throw error;
      }
    }
    const executable = corePath(this.root, this.packaged);
    await fs.access(executable).catch(() => { throw new Error("节点内核缺失，请重新安装客户端"); });
    const url = subscriptionUrl(this.policy.subscriptionUrl || DEFAULT_SUBSCRIPTION_URL);
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(15000), redirect: "follow" });
    if (!response.ok) throw new Error(`节点订阅读取失败（${response.status}）`);
    if (new URL(response.url).protocol !== "https:") throw new Error("节点订阅发生了非 HTTPS 跳转");
    const source = await response.text();
    const nodes = parseNodes(source, {
      disabled: this.policy.disabledNodes || [],
      countryCodes: this.policy.countryCodes,
    });
    if (!nodes.length) throw new Error("当前订阅没有可用的候选节点");
    const pinnedNode = nodes.some((node) => node.name === this.policy.pinnedNode)
      ? this.policy.pinnedNode : "";
    const port = await freePort();
    const directory = path.join(this.userData, "node-runtime");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const configPath = path.join(directory, "config.yaml");
    await fs.writeFile(configPath, buildCoreConfig(nodes, port, pinnedNode), { mode: 0o600 });
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
    this.nodes = nodes.length;
    try {
      let lastError;
      for (let attempt = 0; attempt < 12; attempt++) {
        if (spawnError || child.exitCode !== null || child.signalCode !== null) break;
        try {
          await checkLocalProxy(`127.0.0.1:${port}`, 3000);
          await probeOfficialProxy(`127.0.0.1:${port}`, 10000);
          this.officialReachable = true;
          return this.status();
        } catch (error) {
          lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error(spawnError?.message || errorOutput.trim() || lastError?.message || "节点无法连接 ChatGPT");
    } catch (error) {
      this.disconnect();
      throw error;
    }
  }

  disconnect() {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
    this.child = null;
    this.port = 0;
    this.nodes = 0;
    this.officialReachable = false;
    return this.status();
  }
}

module.exports = { NodeRuntime, corePath };
