const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { constants } = require("node:fs");

function backupPaths(configPath) {
  return {
    original: `${configPath}.jokerdeck.official.bak`,
    absent: `${configPath}.jokerdeck.official.absent`,
  };
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function backupOriginalCodexConfig(configPath) {
  const { original, absent } = backupPaths(configPath);
  if (await exists(original) || await exists(absent)) return;
  try {
    await fs.copyFile(configPath, original, constants.COPYFILE_EXCL);
    await fs.chmod(original, 0o600);
  } catch (error) {
    if (error.code === "EEXIST") return;
    if (error.code !== "ENOENT") throw error;
    const marker = await fs.open(absent, "wx", 0o600);
    await marker.close();
  }
}

async function hasOriginalCodexBackup(configPath) {
  const { original, absent } = backupPaths(configPath);
  return (await exists(original)) || (await exists(absent));
}

async function restoreOriginalCodexConfig(configPath) {
  const { original, absent } = backupPaths(configPath);
  const hadOriginal = await exists(original);
  if (!hadOriginal && !(await exists(absent))) return { restored: false };
  const currentExists = await exists(configPath);
  const savedPath = currentExists ? `${configPath}.jokerdeck.before-restore.${randomUUID()}.bak` : "";
  const temporaryPath = `${configPath}.jokerdeck.restore.${randomUUID()}.tmp`;
  if (currentExists) {
    await fs.copyFile(configPath, savedPath, constants.COPYFILE_EXCL);
    await fs.chmod(savedPath, 0o600);
  }
  try {
    if (hadOriginal) {
      await fs.copyFile(original, temporaryPath, constants.COPYFILE_EXCL);
      await fs.chmod(temporaryPath, 0o600);
      await fs.rename(temporaryPath, configPath);
      await fs.unlink(original);
    } else {
      if (currentExists) await fs.unlink(configPath);
      await fs.unlink(absent);
    }
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
  return { restored: true, savedPath };
}

module.exports = { backupOriginalCodexConfig, hasOriginalCodexBackup, restoreOriginalCodexConfig };
