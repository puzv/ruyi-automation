const { sql } = require("kysely");

function findByUsername(db, username) {
  return db.selectFrom("ruyi_users").selectAll().where("username", "=", username).executeTakeFirst();
}

function findById(db, id) {
  return db.selectFrom("ruyi_users").selectAll().where("id", "=", id).executeTakeFirst();
}

async function createUser(db, { username, displayName, passwordHash, role = "user", mustChangePassword = true, createdBy = null }) {
  const result = await db.insertInto("ruyi_users").values({
    username, display_name: displayName, password_hash: passwordHash, role,
    must_change_password: mustChangePassword ? 1 : 0, created_by: createdBy,
  }).executeTakeFirstOrThrow();
  return Number(result.insertId);
}

function listUsers(db) {
  return db.selectFrom("ruyi_users").select([
    "id", "username", "display_name", "role", "status", "must_change_password",
    "password_changed_at", "failed_login_count", "locked_until", "last_login_at",
    "last_login_ip", "created_by", "created_at", "updated_at",
  ]).orderBy("id").execute();
}

function updatePassword(db, id, passwordHash, { mustChangePassword }) {
  return db.updateTable("ruyi_users").set({
    password_hash: passwordHash, must_change_password: mustChangePassword ? 1 : 0,
    password_changed_at: sql`NOW()`,
  }).where("id", "=", id).executeTakeFirst();
}

function setStatus(db, id, status) {
  return db.updateTable("ruyi_users").set({ status }).where("id", "=", id).executeTakeFirst();
}

function recordLoginFailure(db, id, { maxFailures, lockMinutes }) {
  // MySQL 按顺序计算单表 UPDATE 的赋值，必须先用原始计数判断锁定时间。
  return db.updateTable("ruyi_users").set({
    locked_until: sql`CASE WHEN failed_login_count + 1 >= ${maxFailures}
      THEN DATE_ADD(NOW(), INTERVAL ${lockMinutes} MINUTE) ELSE locked_until END`,
    failed_login_count: sql`CASE WHEN failed_login_count + 1 >= ${maxFailures}
      THEN 0 ELSE failed_login_count + 1 END`,
  }).where("id", "=", id).executeTakeFirst();
}

function recordLoginSuccess(db, id, ip) {
  return db.updateTable("ruyi_users").set({
    failed_login_count: 0, locked_until: null, last_login_at: sql`NOW()`, last_login_ip: ip,
  }).where("id", "=", id).executeTakeFirst();
}

module.exports = { findByUsername, findById, createUser, listUsers, updatePassword, setStatus, recordLoginFailure, recordLoginSuccess };
