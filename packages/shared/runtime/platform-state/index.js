const states = require("../repos/platform-states");
const { encryptState, decryptState, estimateExpiry } = require("./crypto");

function isExpired(row) {
  return row.status === "expired" || (row.expires_hint_at != null && row.expires_hint_at.getTime() <= Date.now());
}

function timestamps(row) {
  return {
    capturedAt: row?.captured_at ?? null,
    refreshedAt: row?.refreshed_at ?? null,
    lastVerifiedAt: row?.last_verified_at ?? null,
    expiresHintAt: row?.expires_hint_at ?? null,
  };
}

async function loadUserState(db, userId, keys) {
  const row = await states.getStateRow(db, userId);
  // 估算过期时间只用于提醒，实际失效以平台验证后写入的状态为准。
  if (!row || row.status !== "valid" || !row.state_ciphertext?.length) return null;
  return {
    state: decryptState(row.state_ciphertext, row.key_version, userId, keys),
    version: row.version,
    ...timestamps(row),
  };
}

function storeCapturedState(db, userId, state, keys, { platformAccount } = {}) {
  return states.saveCapturedState(db, {
    userId, ...encryptState(state, userId, keys), expiresHintAt: estimateExpiry(state), platformAccount,
  });
}

function storeRefreshedState(db, userId, expectedVersion, state, keys) {
  return states.refreshState(db, {
    userId, expectedVersion, ...encryptState(state, userId, keys), expiresHintAt: estimateExpiry(state),
  });
}

async function getStatusSummary(db, userId) {
  const row = await states.getStateRow(db, userId);
  const status = !row ? "none" : isExpired(row) || !row.state_ciphertext?.length ? "expired" : "valid";
  return { status, ...timestamps(row) };
}

module.exports = { loadUserState, storeCapturedState, storeRefreshedState, getStatusSummary };
