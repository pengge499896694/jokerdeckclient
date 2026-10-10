const fs = require("node:fs/promises");
const path = require("node:path");
const {
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} = require("node:crypto");

const DEFAULT_PASSWORD = "123456";
const AUTH_VERSION = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_OPTIONS = Object.freeze({ N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 });
const DEFAULT_MAX_ENTRIES = 500;
const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 1024;

// These are intentionally finite. Diagnostics must never become a general-purpose
// data sink for credentials, exception text, or arbitrary IPC payloads.
const EVENT_IDS = Object.freeze({
  CHECK: "check",
  ROUTE: "route",
  KEY: "key",
  WRITE: "write",
  PROXY: "proxy",
  LOCALIZE: "localize",
  START: "start",
  RESTORE: "restore",
  EXIT: "exit",
});

const STATUS_VALUES = Object.freeze({
  ACTIVE: "active",
  DONE: "done",
  FAILED: "failed",
});

const EVENT_SET = new Set(Object.values(EVENT_IDS));
const STATUS_SET = new Set(Object.values(STATUS_VALUES));

function passwordIsValid(password) {
  return typeof password === "string"
    && password.length >= MIN_PASSWORD_LENGTH
    && password.length <= MAX_PASSWORD_LENGTH
    && !password.includes("\0");
}

function deriveKey(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

async function passwordRecord(password) {
  const salt = randomBytes(16);
  const hash = await deriveKey(password, salt);
  return {
    version: AUTH_VERSION,
    algorithm: "scrypt",
    salt: salt.toString("base64"),
    hash: hash.toString("base64"),
    keyLength: SCRYPT_KEY_LENGTH,
  };
}

async function matchesPassword(password, record) {
  if (!passwordIsValid(password) || !record || record.version !== AUTH_VERSION
      || record.algorithm !== "scrypt" || record.keyLength !== SCRYPT_KEY_LENGTH
      || typeof record.salt !== "string" || typeof record.hash !== "string") {
    return false;
  }

  let salt;
  let expected;
  try {
    salt = Buffer.from(record.salt, "base64");
    expected = Buffer.from(record.hash, "base64");
  } catch {
    return false;
  }
  if (salt.length < 16 || expected.length !== SCRYPT_KEY_LENGTH) return false;

  const actual = await deriveKey(password, salt);
  return timingSafeEqual(actual, expected);
}

async function atomicWrite(filePath, content) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, 0o600);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function ensureDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
}

function validateRecord(record) {
  return record && typeof record === "object"
    && typeof record.timestamp === "string"
    && EVENT_SET.has(record.event)
    && STATUS_SET.has(record.status);
}

async function readAuth(authPath) {
  try {
    const raw = await fs.readFile(authPath, "utf8");
    const record = JSON.parse(raw);
    if (!record || record.version !== AUTH_VERSION || record.algorithm !== "scrypt"
        || record.keyLength !== SCRYPT_KEY_LENGTH || typeof record.salt !== "string"
        || typeof record.hash !== "string") {
      throw new Error("Invalid diagnostics authentication file");
    }
    await fs.chmod(authPath, 0o600);
    return record;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const record = await passwordRecord(DEFAULT_PASSWORD);
    await atomicWrite(authPath, `${JSON.stringify(record)}\n`);
    return record;
  }
}

async function readEntries(logPath, maxEntries) {
  try {
    const raw = await fs.readFile(logPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((record) => !validateRecord(record))) {
      throw new Error("Invalid diagnostics log file");
    }
    await fs.chmod(logPath, 0o600);
    return parsed.slice(-maxEntries).map((record) => ({
      timestamp: record.timestamp,
      event: record.event,
      status: record.status,
    }));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function serialized(operation, queue) {
  const result = queue.then(operation);
  return result;
}

/**
 * Create local diagnostics storage for Electron main.
 *
 * Startup code may call append(event, status) before UI unlock. The main process
 * should keep its own verified boolean from verifyPassword() and gate entries()
 * and changePassword() IPC handlers with it; this module only persists records.
 */
function createDiagnostics(options = {}) {
  if (!options || typeof options !== "object" || typeof options.directory !== "string" || !options.directory) {
    throw new TypeError("createDiagnostics requires a directory");
  }

  const directory = path.resolve(options.directory);
  const authPath = path.join(directory, "diagnostics-auth.json");
  const logPath = path.join(directory, "diagnostics.json");
  const requestedMax = options.maxEntries === undefined ? DEFAULT_MAX_ENTRIES : options.maxEntries;
  if (!Number.isInteger(requestedMax) || requestedMax < 1) {
    throw new TypeError("maxEntries must be a positive integer");
  }
  const maxEntries = Math.min(requestedMax, 10_000);

  let authRecord;
  let records;
  let operationQueue = Promise.resolve();
  const ready = (async () => {
    await ensureDirectory(directory);
    authRecord = await readAuth(authPath);
    records = await readEntries(logPath, maxEntries);
  })();

  function runExclusive(operation) {
    const result = serialized(operation, operationQueue);
    operationQueue = result.catch(() => {});
    return result;
  }

  async function verifyPassword(password) {
    await ready;
    return matchesPassword(password, authRecord);
  }

  async function changePassword(currentPassword, newPassword) {
    await ready;
    return runExclusive(async () => {
      if (!(await matchesPassword(currentPassword, authRecord))) return false;
      if (!passwordIsValid(newPassword)) {
        throw new TypeError(`new password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters`);
      }
      const nextRecord = await passwordRecord(newPassword);
      await atomicWrite(authPath, `${JSON.stringify(nextRecord)}\n`);
      authRecord = nextRecord;
      return true;
    });
  }

  async function append(event, status) {
    await ready;
    return runExclusive(async () => {
      if (typeof event !== "string" || !EVENT_SET.has(event)) {
        throw new TypeError("Unsupported diagnostics event");
      }
      if (typeof status !== "string" || !STATUS_SET.has(status)) {
        throw new TypeError("Unsupported diagnostics status");
      }
      const record = {
        timestamp: new Date().toISOString(),
        event,
        status,
      };
      const nextRecords = records.concat(record).slice(-maxEntries);
      await atomicWrite(logPath, `${JSON.stringify(nextRecords)}\n`);
      records = nextRecords;
      return { ...record };
    });
  }

  async function entries() {
    await ready;
    return records.map((record) => ({ ...record }));
  }

  return Object.freeze({
    verifyPassword,
    changePassword,
    append,
    entries,
    authPath,
    logPath,
    maxEntries,
    eventIds: EVENT_IDS,
    statuses: STATUS_VALUES,
  });
}

module.exports = {
  createDiagnostics,
  EVENT_IDS,
  STATUS_VALUES,
  DEFAULT_PASSWORD,
};
