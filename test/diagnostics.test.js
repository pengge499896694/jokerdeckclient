const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  createDiagnostics,
  EVENT_IDS,
  STATUS_VALUES,
} = require("../src/diagnostics");

async function withDirectory(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jokerdeck-diagnostics-"));
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("creates a salted scrypt password record with the default password", () => withDirectory(async (directory) => {
  const diagnostics = createDiagnostics({ directory });
  assert.equal(await diagnostics.verifyPassword("123456"), true);
  assert.equal(await diagnostics.verifyPassword("wrong-password"), false);

  const auth = await fs.readFile(diagnostics.authPath, "utf8");
  const record = JSON.parse(auth);
  assert.equal(record.algorithm, "scrypt");
  assert.equal(typeof record.salt, "string");
  assert.equal(typeof record.hash, "string");
  assert.equal(auth.includes("123456"), false);
  assert.equal((await fs.stat(diagnostics.authPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
}));

test("appends startup diagnostics before any password verification", () => withDirectory(async (directory) => {
  const diagnostics = createDiagnostics({ directory });
  const appended = await diagnostics.append(EVENT_IDS.START, STATUS_VALUES.ACTIVE);
  assert.equal(appended.event, "start");
  assert.equal(appended.status, "active");
  assert.match(appended.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(await diagnostics.entries(), [appended]);
}));

test("only accepts the fixed event and status enums", () => withDirectory(async (directory) => {
  const diagnostics = createDiagnostics({ directory });
  await assert.rejects(diagnostics.append("arbitrary-event", STATUS_VALUES.ACTIVE), TypeError);
  await assert.rejects(diagnostics.append(EVENT_IDS.CHECK, "raw error: api_key=secret"), TypeError);
  assert.deepEqual(await diagnostics.entries(), []);
}));

test("changes password only with the current password and persists the change", () => withDirectory(async (directory) => {
  const diagnostics = createDiagnostics({ directory });
  assert.equal(await diagnostics.changePassword("not-current", "new-pass-123"), false);
  assert.equal(await diagnostics.verifyPassword("123456"), true);

  assert.equal(await diagnostics.changePassword("123456", "new-pass-123"), true);
  assert.equal(await diagnostics.verifyPassword("123456"), false);
  assert.equal(await diagnostics.verifyPassword("new-pass-123"), true);

  const reopened = createDiagnostics({ directory });
  assert.equal(await reopened.verifyPassword("123456"), false);
  assert.equal(await reopened.verifyPassword("new-pass-123"), true);
  const auth = await fs.readFile(diagnostics.authPath, "utf8");
  assert.equal(auth.includes("new-pass-123"), false);
}));

test("rejects invalid new passwords without changing the current password", () => withDirectory(async (directory) => {
  const diagnostics = createDiagnostics({ directory });
  await assert.rejects(diagnostics.changePassword("123456", "short"), TypeError);
  assert.equal(await diagnostics.verifyPassword("123456"), true);
  assert.equal(await diagnostics.verifyPassword("short"), false);
}));

test("bounds persisted entries and keeps the log private", () => withDirectory(async (directory) => {
  const diagnostics = createDiagnostics({ directory, maxEntries: 2 });
  await diagnostics.append(EVENT_IDS.CHECK, STATUS_VALUES.ACTIVE);
  await diagnostics.append(EVENT_IDS.ROUTE, STATUS_VALUES.DONE);
  await diagnostics.append(EVENT_IDS.KEY, STATUS_VALUES.FAILED);
  const entries = await diagnostics.entries();
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(({ event }) => event), ["route", "key"]);
  assert.equal((await fs.stat(diagnostics.logPath)).mode & 0o777, 0o600);

  const persisted = JSON.parse(await fs.readFile(diagnostics.logPath, "utf8"));
  assert.equal(persisted.length, 2);
  assert.deepEqual(Object.keys(persisted[0]).sort(), ["event", "status", "timestamp"]);
}));

test("serializes concurrent appends without losing records", () => withDirectory(async (directory) => {
  const diagnostics = createDiagnostics({ directory });
  await Promise.all([
    diagnostics.append(EVENT_IDS.CHECK, STATUS_VALUES.ACTIVE),
    diagnostics.append(EVENT_IDS.ROUTE, STATUS_VALUES.DONE),
    diagnostics.append(EVENT_IDS.KEY, STATUS_VALUES.FAILED),
  ]);
  assert.equal((await diagnostics.entries()).length, 3);
}));
