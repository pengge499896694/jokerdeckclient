const test = require("node:test");
const assert = require("node:assert/strict");
const { isRetryableNetworkError, nodeConnectionError, retryingFetch } = require("../src/network-fetch");

test("recognizes transient closed network connections", () => {
  assert.equal(isRetryableNetworkError({ code: "ERR_CONNECTION_CLOSED" }), true);
  assert.equal(isRetryableNetworkError(new Error("net::ERR_CONNECTION_RESET")), true);
  assert.equal(isRetryableNetworkError({ code: "ERR_FAILED" }), false);
});

test("retries a transient network failure before succeeding", async () => {
  let attempts = 0;
  const response = { ok: true, status: 200 };
  const result = await retryingFetch(async () => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error("closed"), { code: "ERR_CONNECTION_CLOSED" });
    return response;
  }, "https://example.com", {}, { retries: 2, backoff: 1 });
  assert.equal(result, response);
  assert.equal(attempts, 3);
});

test("does not retry an aborted request", async () => {
  const controller = new AbortController();
  controller.abort();
  let attempts = 0;
  await assert.rejects(
    retryingFetch(async () => {
      attempts += 1;
      throw Object.assign(new Error("closed"), { code: "ERR_CONNECTION_CLOSED" });
    }, "https://example.com", { signal: controller.signal }, { backoff: 1 }),
    /closed/,
  );
  assert.equal(attempts, 1);
});

test("converts a final connection failure to a user-safe message", () => {
  assert.equal(
    nodeConnectionError(Object.assign(new Error("net::ERR_CONNECTION_CLOSED"), { code: "ERR_CONNECTION_CLOSED" })).message,
    "节点连接被远端关闭，请稍后重试；如果持续失败，请检查节点订阅或中转站服务",
  );
  const original = new Error("节点订阅格式无效");
  assert.equal(nodeConnectionError(original), original);
});
