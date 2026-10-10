const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { backupOriginalCodexConfig, hasOriginalCodexBackup, restoreOriginalCodexConfig } = require("../src/codex-config-backup");

async function withConfig(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jokerdeck-codex-restore-"));
  try {
    await run(path.join(dir, "config.toml"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("restores exact original bytes and retains edited configuration separately", () => withConfig(async (file) => {
  const original = Buffer.from('model_provider = "openai"\n# personal setting\n');
  await fs.writeFile(file, original);
  await backupOriginalCodexConfig(file);
  await fs.writeFile(file, 'model_provider = "custom"\n');
  await backupOriginalCodexConfig(file);
  const { restored, savedPath } = await restoreOriginalCodexConfig(file);
  assert.equal(restored, true);
  assert.deepEqual(await fs.readFile(file), original);
  assert.equal(await fs.readFile(savedPath, "utf8"), 'model_provider = "custom"\n');
  assert.equal(await hasOriginalCodexBackup(file), false);
  await fs.writeFile(file, 'model_provider = "new-personal"\n');
  await backupOriginalCodexConfig(file);
  await fs.writeFile(file, 'model_provider = "custom"\n');
  await restoreOriginalCodexConfig(file);
  assert.equal(await fs.readFile(file, "utf8"), 'model_provider = "new-personal"\n');
}));

test("removes only Jokerdeck-created config when none existed before", () => withConfig(async (file) => {
  await backupOriginalCodexConfig(file);
  await fs.writeFile(file, 'model_provider = "custom"\n');
  await backupOriginalCodexConfig(file);
  const { restored, savedPath } = await restoreOriginalCodexConfig(file);
  assert.equal(restored, true);
  assert.equal(await fs.readFile(savedPath, "utf8"), 'model_provider = "custom"\n');
  await assert.rejects(fs.access(file), { code: "ENOENT" });
  assert.equal(await hasOriginalCodexBackup(file), false);
}));

test("never infers an original config from an overwritten legacy backup", () => withConfig(async (file) => {
  await fs.writeFile(file, 'model_provider = "custom"\n');
  await fs.writeFile(`${file}.jokerdeck.bak`, "stale\n");
  assert.deepEqual(await restoreOriginalCodexConfig(file), { restored: false });
  assert.equal(await fs.readFile(file, "utf8"), 'model_provider = "custom"\n');
}));
