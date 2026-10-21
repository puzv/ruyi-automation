const { sql } = require("kysely");

function getStateRow(db, userId) {
  return db.selectFrom("ruyi_platform_states").selectAll().where("user_id", "=", userId).executeTakeFirst();
}

function saveCapturedState(db, { userId, ciphertext, keyVersion, expiresHintAt, platformAccount }) {
  const values = {
    state_ciphertext: ciphertext,
    key_version: keyVersion,
    expires_hint_at: expiresHintAt ?? null,
    platform_account: platformAccount ?? null,
    captured_at: sql`NOW()`,
    last_verified_at: sql`NOW()`,
    status: "valid",
  };
  return db.insertInto("ruyi_platform_states").values({ user_id: userId, ...values, version: 1 })
    .onDuplicateKeyUpdate({ ...values, version: sql`version + 1` }).executeTakeFirst();
}

async function refreshState(db, { userId, expectedVersion, ciphertext, keyVersion, expiresHintAt }) {
  const result = await db.updateTable("ruyi_platform_states").set({
    state_ciphertext: ciphertext,
    key_version: keyVersion,
    expires_hint_at: expiresHintAt ?? null,
    refreshed_at: sql`NOW()`,
    last_verified_at: sql`NOW()`,
    version: sql`version + 1`,
  }).where("user_id", "=", userId).where("version", "=", expectedVersion).where("status", "=", "valid")
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

async function markExpired(db, { userId, expectedVersion }) {
  const result = await db.updateTable("ruyi_platform_states").set({ status: "expired", version: sql`version + 1` })
    .where("user_id", "=", userId).where("version", "=", expectedVersion).where("status", "=", "valid")
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

function clearState(db, userId) {
  return db.updateTable("ruyi_platform_states").set({
    status: "expired", state_ciphertext: null, version: sql`version + 1`,
  }).where("user_id", "=", userId).executeTakeFirst();
}

module.exports = { getStateRow, saveCapturedState, refreshState, markExpired, clearState };
