const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const {
  normalizeLocalProxy,
  systemProxySuggestion,
  proxyServerArgument,
  checkLocalProxy,
  probeOfficialProxy,
} = require("../src/startup-proxy");

test("accepts only loopback HTTP proxies with an explicit port", () => {
  assert.equal(normalizeLocalProxy("127.0.0.1:7877"), "http://127.0.0.1:7877");
  assert.equal(normalizeLocalProxy("http://localhost:7890"), "http://localhost:7890");
  for (const input of ["", "example.com:7890", "socks5://127.0.0.1:7890", "127.0.0.1", "http://user:pass@127.0.0.1:7890", "127.0.0.1:7890/path"]) {
    assert.throws(() => normalizeLocalProxy(input));
  }
});

test("uses a local system proxy and builds a Chromium argument", () => {
  assert.equal(systemProxySuggestion("DIRECT; PROXY 127.0.0.1:7877"), "http://127.0.0.1:7877");
  assert.equal(systemProxySuggestion("PROXY proxy.example.com:8080; DIRECT"), "");
  assert.equal(proxyServerArgument("127.0.0.1:7877"), "--proxy-server=http://127.0.0.1:7877");
});

test("checks the proxy CONNECT response before launch", async (context) => {
  const server = net.createServer((socket) => {
    socket.once("data", (request) => {
      assert.match(request.toString(), /^CONNECT chatgpt\.com:443 HTTP\/1\.1/);
      socket.end("HTTP/1.1 200 Connection established\r\n\r\n");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  assert.equal(await checkLocalProxy(`127.0.0.1:${server.address().port}`), true);
});

test("rejects a proxy that refuses CONNECT", async (context) => {
  const server = net.createServer((socket) => {
    socket.once("data", () => socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  await assert.rejects(checkLocalProxy(`127.0.0.1:${server.address().port}`), /407/);
});

test("does not treat a CONNECT response as proof that the official site is reachable", async (context) => {
  const server = net.createServer((socket) => {
    socket.once("data", () => socket.end("HTTP/1.1 200 Connection established\r\n\r\n"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  await assert.rejects(probeOfficialProxy(`127.0.0.1:${server.address().port}`, 1000));
});
