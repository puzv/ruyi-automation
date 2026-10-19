const { sql } = require("kysely");

function createSession(db, { tokenHash, userId, ip = null, userAgent = null, expiresAt }) {
  return db.insertInto("ruyi_user_sessions").values({
    id: tokenHash, user_id: userId, ip, user_agent: userAgent, expires_at: expiresAt,
  }).executeTakeFirst();
}

async function findActiveSession(db, tokenHash, { idleMinutes = 480 } = {}) {
  const row = await db.selectFrom("ruyi_user_sessions as s")
    .innerJoin("ruyi_users as u", "u.id", "s.user_id")
    .selectAll("s").select([
      "u.username as username", "u.display_name as display_name", "u.role as role",
      "u.status as status", "u.must_change_password as must_change_password",
    ])
    .where("s.id", "=", tokenHash).where("s.revoked_at", "is", null)
    .where("s.expires_at", ">", sql`NOW()`).where("u.status", "=", "active")
    .where("s.last_seen_at", ">", sql`DATE_SUB(NOW(), INTERVAL ${idleMinutes} MINUTE)`)
    .executeTakeFirst();
  if (!row) return undefined;
  const { username, display_name, role, status, must_change_password, ...session } = row;
  return { ...session, user: { id: row.user_id, username, display_name, role, status, must_change_password } };
}

function touchSession(db, tokenHash) {
  return db.updateTable("ruyi_user_sessions").set({ last_seen_at: sql`NOW()` })
    .where("id", "=", tokenHash)
    .where("last_seen_at", "<", sql`DATE_SUB(NOW(), INTERVAL 1 MINUTE)`).executeTakeFirst();
}

function revokeSession(db, tokenHash) {
  return db.updateTable("ruyi_user_sessions").set({ revoked_at: sql`NOW()` })
    .where("id", "=", tokenHash).where("revoked_at", "is", null).executeTakeFirst();
}

function revokeUserSessions(db, userId, { exceptTokenHash } = {}) {
  let query = db.updateTable("ruyi_user_sessions").set({ revoked_at: sql`NOW()` })
    .where("user_id", "=", userId).where("revoked_at", "is", null);
  if (exceptTokenHash !== undefined) query = query.where("id", "!=", exceptTokenHash);
  return query.executeTakeFirst();
}

function deleteExpiredSessions(db, olderThanDays) {
  return db.deleteFrom("ruyi_user_sessions")
    .where("expires_at", "<", sql`DATE_SUB(NOW(), INTERVAL ${olderThanDays} DAY)`).executeTakeFirst();
}

module.exports = { createSession, findActiveSession, touchSession, revokeSession, revokeUserSessions, deleteExpiredSessions };
