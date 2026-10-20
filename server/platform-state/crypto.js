const crypto = require("node:crypto");

function readKey(env, name) {
  const value = env[name];
  if (typeof value !== "string" || !value) throw new Error(`缺少登录态加密密钥：${name}`);
  // Buffer.from 会宽松忽略非法字符，需额外检查标准 base64 编码。
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`登录态加密密钥 ${name} 必须为有效的 base64`);
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) {
    throw new Error(`登录态加密密钥 ${name} 必须为 32 字节的标准 base64`);
  }
  return key;
}

function readVersion(value, fallback, name) {
  const version = value === undefined ? fallback : Number(value);
  if ((value !== undefined && !/^\d+$/.test(String(value))) || !Number.isInteger(version) || version < 0 || version > 65535) {
    throw new Error(`登录态密钥版本 ${name} 必须为 0 至 65535 的整数`);
  }
  return version;
}

function loadKeys(env = process.env) {
  const current = {
    version: readVersion(env.RUYI_STATE_KEY_VERSION, 1, "RUYI_STATE_KEY_VERSION"),
    key: readKey(env, "RUYI_STATE_KEY"),
  };
  const keys = { current };
  if (env.RUYI_STATE_KEY_PREVIOUS !== undefined) {
    keys.previous = {
      version: readVersion(env.RUYI_STATE_KEY_PREVIOUS_VERSION, current.version - 1, "RUYI_STATE_KEY_PREVIOUS_VERSION"),
      key: readKey(env, "RUYI_STATE_KEY_PREVIOUS"),
    };
    if (keys.previous.version === current.version) throw new Error("登录态新旧密钥版本不能相同");
  }
  return keys;
}

function aad(userId) {
  return Buffer.from(`ruyi-platform-state:v1:user:${userId}`);
}

function encryptState(stateObject, userId, keys) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keys.current.key, iv, { authTagLength: 16 });
  cipher.setAAD(aad(userId));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(stateObject), "utf8"), cipher.final()]);
  return { ciphertext: Buffer.concat([iv, cipher.getAuthTag(), encrypted]), keyVersion: keys.current.version };
}

function decryptState(ciphertext, keyVersion, userId, keys) {
  try {
    const selected = [keys.current, keys.previous].find((item) => item && item.version === keyVersion);
    if (!selected || !Buffer.isBuffer(ciphertext) || ciphertext.length <= 28) throw new Error();
    const decipher = crypto.createDecipheriv("aes-256-gcm", selected.key, ciphertext.subarray(0, 12), { authTagLength: 16 });
    decipher.setAAD(aad(userId));
    decipher.setAuthTag(ciphertext.subarray(12, 28));
    const plaintext = Buffer.concat([decipher.update(ciphertext.subarray(28)), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch (_) {
    throw new Error("登录态解密失败");
  }
}

function estimateExpiry(stateObject) {
  const names = new Set(["dn_token", "gdt_token", "ndmp_token", "SSO_SESSION_ID"]);
  let earliest = Infinity;
  for (const cookie of stateObject?.cookies || []) {
    if (names.has(cookie.name) && Number.isFinite(cookie.expires) && cookie.expires >= 0) {
      earliest = Math.min(earliest, cookie.expires);
    }
  }
  const date = new Date(earliest * 1000);
  return Number.isFinite(date.getTime()) ? date : null;
}

module.exports = { loadKeys, encryptState, decryptState, estimateExpiry };
