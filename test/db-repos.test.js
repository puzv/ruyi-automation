const assert = require("assert");
const path = require("path");
const { spawnSync } = require("child_process");
const { sql } = require("kysely");
const bcrypt = require("bcryptjs");
const { createDb, readDbConfig } = require("../db");
const users = require("../server/repos/users");
const sessions = require("../server/repos/sessions");
const { hashPassword, verifyPassword, validatePasswordStrength, validateUsername } = require("../server/auth/password");

async function clearTestData(db) {
  // 任务明确要求的测试库清理；业务代码中的操作记录仍然只追加。
  for (const table of ["ruyi_user_sessions", "ruyi_platform_states", "ruyi_operation_logs", "ruyi_users"]) {
    await db.deleteFrom(table).execute();
  }
}

async function main() {
  if (process.env.RUYI_DB_NAME !== "ruyi_test") throw new Error("数据库测试只允许使用 ruyi_test 库。");
  const config = readDbConfig();
  if (config.host !== "127.0.0.1" || config.port !== 3306 || config.user !== "ruyi" || config.password !== "ruyi") {
    throw new Error("数据库测试只允许连接本机 Docker 的测试数据库。");
  }
  const db = createDb(config);
  try {
    await clearTestData(db);

    const passwordHash = await hashPassword("Test12345");
    assert.strictEqual(bcrypt.getRounds(passwordHash), 12);
    assert.notStrictEqual(passwordHash, "Test12345");
    assert.strictEqual(await verifyPassword("Test12345", passwordHash), true);
    assert.strictEqual(await verifyPassword("wrong123", passwordHash), false);
    for (const value of ["12345678", "abcdefgh", "中文密码至少八个"]) assert.strictEqual(validatePasswordStrength(value), null);
    for (const value of ["", "1234567", null, 12345678]) assert.strictEqual(typeof validatePasswordStrength(value), "string");
    for (const value of ["a".repeat(72), "中".repeat(24)]) assert.strictEqual(validatePasswordStrength(value), null);
    for (const value of ["a".repeat(73), "中".repeat(25), "😀".repeat(19)]) {
      assert.strictEqual(validatePasswordStrength(value), "密码不能超过 72 个字节");
    }
    for (const value of ["abc", "a_1", "a".repeat(12)]) assert.strictEqual(validateUsername(value), null);
    for (const value of ["ab", "a".repeat(13), "a".repeat(33), "ABC", "a-b", "中文名", "abc\n", null, 123]) {
      assert.strictEqual(validateUsername(value), "用户名需为 3 至 12 位小写字母、数字或下划线");
    }

    const id = await users.createUser(db, { username: "repo_test", displayName: "中文测试用户", passwordHash });
    assert.ok(id > 0);
    assert.strictEqual((await users.findByUsername(db, "repo_test")).id, id);
    assert.strictEqual((await users.findById(db, id)).display_name, "中文测试用户");
    assert.strictEqual((await users.findById(db, id)).must_change_password, 1);
    assert.strictEqual(await users.findByUsername(db, "missing"), undefined);
    assert.strictEqual(await users.findById(db, 0), undefined);
    await assert.rejects(users.createUser(db, { username: "repo_test", displayName: "重复", passwordHash }),
      (error) => error.code === "ER_DUP_ENTRY");
    const listed = await users.listUsers(db);
    assert.strictEqual(listed.length, 1);
    assert.strictEqual(Object.hasOwn(listed[0], "password_hash"), false);

    await users.updatePassword(db, id, passwordHash, { mustChangePassword: false });
    let user = await users.findById(db, id);
    assert.strictEqual(user.must_change_password, 0);
    assert.strictEqual(user.password_hash, passwordHash);
    assert.ok(user.password_changed_at instanceof Date);

    for (let count = 1; count <= 5; count++) {
      await users.recordLoginFailure(db, id, { maxFailures: 5, lockMinutes: 15 });
      user = await users.findById(db, id);
      assert.strictEqual(user.failed_login_count, count === 5 ? 0 : count);
      if (count < 5) assert.strictEqual(user.locked_until, null);
    }
    const lock = (await sql`SELECT TIMESTAMPDIFF(SECOND, NOW(), locked_until) AS remaining
      FROM ruyi_users WHERE id = ${id}`.execute(db)).rows[0];
    assert.ok(lock.remaining >= 895 && lock.remaining <= 900);
    await users.recordLoginSuccess(db, id, "127.0.0.1");
    user = await users.findById(db, id);
    assert.strictEqual(user.failed_login_count, 0);
    assert.strictEqual(user.locked_until, null);
    assert.strictEqual(user.last_login_ip, "127.0.0.1");
    assert.ok(user.last_login_at instanceof Date);
    await Promise.all(Array.from({ length: 5 }, () => users.recordLoginFailure(db, id, { maxFailures: 5, lockMinutes: 15 })));
    user = await users.findById(db, id);
    assert.strictEqual(user.failed_login_count, 0);
    assert.ok(user.locked_until instanceof Date);
    await users.recordLoginSuccess(db, id, "::1");

    const times = (await sql`SELECT DATE_ADD(NOW(), INTERVAL 1 DAY) AS future,
      DATE_SUB(NOW(), INTERVAL 1 SECOND) AS past`.execute(db)).rows[0];
    const token = (n) => String(n).padStart(64, "0");
    const addSession = (n, userId = id, expiresAt = times.future) => sessions.createSession(db, {
      tokenHash: token(n), userId, ip: "127.0.0.1", userAgent: "测试浏览器", expiresAt,
    });
    await addSession(1);
    const active = await sessions.findActiveSession(db, token(1));
    assert.strictEqual(active.id, token(1));
    assert.strictEqual(active.user.id, id);
    assert.strictEqual(active.user.username, "repo_test");
    assert.strictEqual(active.user.display_name, "中文测试用户");
    assert.strictEqual(active.user_agent, "测试浏览器");
    assert.strictEqual(Object.hasOwn(active.user, "password_hash"), false);
    assert.strictEqual(await sessions.findActiveSession(db, token(99)), undefined);
    await db.updateTable("ruyi_user_sessions").set({ last_seen_at: sql`DATE_SUB(NOW(), INTERVAL 1 HOUR)` })
      .where("id", "=", token(1)).execute();
    assert.strictEqual(await sessions.findActiveSession(db, token(1), { idleMinutes: 30 }), undefined);
    assert.ok(await sessions.findActiveSession(db, token(1), { idleMinutes: 120 }));
    await sessions.touchSession(db, token(1));
    const touched = (await sql`SELECT TIMESTAMPDIFF(SECOND, last_seen_at, NOW()) AS age
      FROM ruyi_user_sessions WHERE id = ${token(1)}`.execute(db)).rows[0];
    assert.ok(touched.age >= 0 && touched.age <= 5);
    await db.updateTable("ruyi_user_sessions").set({ last_seen_at: sql`DATE_SUB(NOW(), INTERVAL 30 SECOND)` })
      .where("id", "=", token(1)).execute();
    const beforeTouch = await db.selectFrom("ruyi_user_sessions").select("last_seen_at").where("id", "=", token(1)).executeTakeFirstOrThrow();
    await sessions.touchSession(db, token(1));
    const afterTouch = await db.selectFrom("ruyi_user_sessions").select("last_seen_at").where("id", "=", token(1)).executeTakeFirstOrThrow();
    assert.strictEqual(afterTouch.last_seen_at.getTime(), beforeTouch.last_seen_at.getTime());
    await addSession(2, id, times.past);
    assert.strictEqual(await sessions.findActiveSession(db, token(2)), undefined);
    await sessions.revokeSession(db, token(1));
    assert.strictEqual(await sessions.findActiveSession(db, token(1)), undefined);
    await addSession(3);
    await users.setStatus(db, id, "disabled");
    assert.strictEqual(await sessions.findActiveSession(db, token(3)), undefined);
    await users.setStatus(db, id, "active");
    assert.ok(await sessions.findActiveSession(db, token(3)));
    await addSession(4);
    const secondId = await users.createUser(db, { username: "other_user", displayName: "另一用户", passwordHash, createdBy: id });
    assert.strictEqual((await users.findById(db, secondId)).created_by, id);
    await addSession(5, secondId);
    await sessions.revokeUserSessions(db, id, { exceptTokenHash: token(3) });
    assert.ok(await sessions.findActiveSession(db, token(3)));
    assert.strictEqual(await sessions.findActiveSession(db, token(4)), undefined);
    assert.ok(await sessions.findActiveSession(db, token(5)));
    await sessions.revokeUserSessions(db, id);
    assert.strictEqual(await sessions.findActiveSession(db, token(3)), undefined);
    await addSession(6);
    await db.updateTable("ruyi_user_sessions").set({ expires_at: sql`DATE_SUB(NOW(), INTERVAL 3 DAY)` })
      .where("id", "=", token(6)).execute();
    await sessions.deleteExpiredSessions(db, 2);
    assert.strictEqual(await db.selectFrom("ruyi_user_sessions").selectAll().where("id", "=", token(6)).executeTakeFirst(), undefined);
    assert.ok(await db.selectFrom("ruyi_user_sessions").selectAll().where("id", "=", token(2)).executeTakeFirst());
    assert.ok(await sessions.findActiveSession(db, token(5)));

    const cli = (password, username = "tester") => {
      const env = { ...process.env };
      if (password === undefined) delete env.RUYI_ADMIN_PASSWORD;
      else env.RUYI_ADMIN_PASSWORD = password;
      return spawnSync(process.execPath, [path.join(__dirname, "../scripts/create-admin.js"), username, "测试管理员"], {
        env, input: "", encoding: "utf8", timeout: 15000,
      });
    };
    const created = cli("Test12345");
    assert.strictEqual(created.status, 0, created.stderr);
    const admin = await users.findByUsername(db, "tester");
    assert.strictEqual(admin.role, "admin");
    assert.strictEqual(admin.display_name, "测试管理员");
    assert.strictEqual(admin.must_change_password, 0);
    assert.strictEqual(await verifyPassword("Test12345", admin.password_hash), true);
    const logs = await db.selectFrom("ruyi_operation_logs").selectAll().execute();
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0].action, "admin.user_create");
    assert.strictEqual(logs[0].target_type, "user");
    assert.strictEqual(logs[0].target_id, "tester");
    assert.strictEqual(logs[0].result, "success");
    assert.strictEqual(logs[0].username, "cli");
    assert.strictEqual(logs[0].user_id, null);
    const duplicate = cli("Test12345");
    assert.strictEqual(duplicate.status, 1);
    assert.match(duplicate.stderr, /用户名已存在/);
    const weak = cli("short", "weak_user");
    assert.strictEqual(weak.status, 1);
    assert.match(weak.stderr, /密码至少/);
    const longUsername = "a".repeat(13);
    const tooLong = cli("Test12345", longUsername);
    assert.strictEqual(tooLong.status, 1);
    assert.match(tooLong.stderr, /用户名需为 3 至 12 位小写字母、数字或下划线/);
    assert.strictEqual(await users.findByUsername(db, longUsername), undefined);
    assert.strictEqual(cli(undefined, "no_password").status, 1);
    assert.strictEqual(await users.findByUsername(db, "weak_user"), undefined);
    assert.strictEqual((await db.selectFrom("ruyi_operation_logs").selectAll().execute()).length, 1);
    console.log("数据库仓库、密码工具与管理员命令测试通过。");
  } finally {
    try { await clearTestData(db); } finally { await db.destroy(); }
  }
}

main().catch((error) => {
  console.error("数据库测试失败：", error);
  process.exitCode = 1;
});
