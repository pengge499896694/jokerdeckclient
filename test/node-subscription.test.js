const test = require("node:test");
const assert = require("node:assert/strict");
const YAML = require("yaml");
const { subscriptionUrl, normalizeNodePolicy, parseNodes, buildCoreConfig } = require("../src/node-subscription");

const sample = YAML.stringify({
  proxies: [
    { name: "US-Fast", type: "vless", server: "example.org", port: 443, uuid: "test" },
    { name: "HK-Blocked", type: "http", server: "example.org", port: 443 },
    { name: "JP-Disabled", type: "http", server: "example.org", port: 443 },
  ],
  rules: ["MATCH,DIRECT"],
  "external-controller": "0.0.0.0:9090",
});

test("accepts HTTPS subscriptions without embedded credentials", () => {
  assert.equal(subscriptionUrl(), "https://234.qzz.io/fsllistyaml");
  assert.throws(() => subscriptionUrl("http://example.org/list"));
  assert.throws(() => subscriptionUrl("https://user:pass@example.org/list"));
});

test("normalizes server node policy", () => {
  assert.deepEqual(normalizeNodePolicy({ subscription_url: "https://example.org/list", disabled_nodes: ["US-Slow", 1], pinned_node: "JP-Fast" }), {
    enabled: true,
    subscriptionUrl: "https://example.org/list",
    disabledNodes: ["US-Slow"],
    pinnedNode: "JP-Fast",
  });
  assert.throws(() => normalizeNodePolicy({ subscription_url: "http://example.org/list" }));
});

test("filters disabled and unapproved regions; does not import subscription rules", () => {
  const nodes = parseNodes(sample, { disabled: ["JP-Disabled"] });
  assert.deepEqual(nodes.map((node) => node.name), ["US-Fast"]);
  const config = YAML.parse(buildCoreConfig(nodes, 19077));
  assert.deepEqual(config.rules, ["MATCH,JOKERDECK"]);
  assert.equal(config["external-controller"], undefined);
  assert.equal(config["bind-address"], "127.0.0.1");
  assert.equal(config["proxy-groups"][0].type, "url-test");
});

test("pinning a node fails closed when it is unavailable", () => {
  const nodes = parseNodes(sample);
  assert.throws(() => buildCoreConfig(nodes, 19077, "US-Missing"));
  const config = YAML.parse(buildCoreConfig(nodes, 19077, "US-Fast"));
  assert.deepEqual(config.proxies.map((node) => node.name), ["US-Fast"]);
});
