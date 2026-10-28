// 自动推进偏好的数据库测试：只连本机 Docker 的 ruyi_test，且只清理自己造的用户。
const assert = require("assert");
const { randomUUID } = require("crypto");
const { sql } = require("kysely");
const { createDb, readDbConfig } = require("../db");
const users = require("@ruyi/shared/runtime/repos/users");
const jobs = require("@ruyi/shared/runtime/repos/jobs");
const autoAdvance = require("@ruyi/shared/runtime/repos/auto-advance");

const usernames = ["auto_advance_a", "auto_advance_b"];

async function clearTestData(db) {
  const rows = await db.selectFrom("ruyi_users").select("id").where("username", "in", usernames).execute();
  if (!rows.length) return;
  const ids = rows.map((row) => row.id);
  // 自动推进偏好表有外键指向 ruyi_users，必须先删偏好再删用户。
  await db.deleteFrom("ruyi_auto_advance").where("user_id", "in", ids).execute();
  await db.deleteFrom("ruyi_jobs").where("user_id", "in", ids).execute();
  await db.deleteFrom("ruyi_users").where("id", "in", ids).execute();
}

async function testRepo(db, userA, userB) {
  // 没有记录时按开启处理，避免老用户升级后自动推进默认关闭。
  assert.equal(await autoAdvance.isEnabled(db, userA), true);
  assert.deepEqual(await db.selectFrom("ruyi_auto_advance").selectAll().where("user_id", "=", userA).execute(), []);

  await autoAdvance.setEnabled(db, userA, false);
  assert.equal(await autoAdvance.isEnabled(db, userA), false);
  const closed = await db.selectFrom("ruyi_auto_advance").selectAll().where("user_id", "=", userA).executeTakeFirstOrThrow();
  assert.equal(Number(closed.enabled), 0);
  assert.ok(closed.updated_at instanceof Date);
  assert.deepEqual([...await autoAdvance.listDisabled(db)], [Number(userA)]);

  // 重复写入走 onDuplicateKeyUpdate，不得因主键冲突报错。
  await autoAdvance.setEnabled(db, userA, false);
  assert.equal(await autoAdvance.isEnabled(db, userA), false);
  assert.equal((await db.selectFrom("ruyi_auto_advance").selectAll().where("user_id", "=", userA).execute()).length, 1);

  await autoAdvance.setEnabled(db, userA, true);
  assert.equal(await autoAdvance.isEnabled(db, userA), true);
  assert.equal(Number((await db.selectFrom("ruyi_auto_advance").select("enabled")
    .where("user_id", "=", userA).executeTakeFirstOrThrow()).enabled), 1);
  assert.deepEqual([...await autoAdvance.listDisabled(db)], []);

  await autoAdvance.setEnabled(db, userB, false);
  assert.deepEqual([...await autoAdvance.listDisabled(db)], [Number(userB)]);
  await autoAdvance.setEnabled(db, userB, true);

  // 近期任务活动窗口：刚入队的任务算活动，窗口之前的不算。
  assert.equal(await jobs.hasJobSince(db, userA, 12), false);
  const recentId = randomUUID();
  assert.deepEqual(await jobs.enqueueJob(db, {
    id: recentId, userId: userA, username: "自动推进甲", task: "upload",
  }), { ok: true });
  assert.equal(await jobs.hasJobSince(db, userA, 12), true);
  assert.equal(await jobs.hasJobSince(db, userA, 12, ['upload', 'create']), true);
  assert.equal(await jobs.hasJobSince(db, userA, 12, ['create', 'analyse']), false);
  assert.equal(await jobs.hasJobSince(db, userA, 12, ['analyse', 'download']), false);
  assert.equal(await jobs.hasJobSince(db, userA, 12, []), false);
  assert.equal(await jobs.hasJobSince(db, userB, 12), false, "其他用户的任务不算当前用户的活动");

  await db.updateTable("ruyi_jobs").set({ queued_at: sql`DATE_SUB(NOW(3), INTERVAL 13 HOUR)` })
    .where("id", "=", recentId).execute();
  assert.equal(await jobs.hasJobSince(db, userA, 12), false);
  assert.equal(await jobs.hasJobSince(db, userA, 24), true);
  const unrelatedId = randomUUID();
  await jobs.enqueueJob(db, { id: unrelatedId, userId: userA, username: "自动推进甲", task: "download" });
  assert.equal(await jobs.hasJobSince(db, userA, 12, ['upload', 'create']), false,
    "近期下载不能解锁旧上传/创建待办");
  assert.equal(await jobs.hasJobSince(db, userA, 12, ['create', 'analyse']), false,
    "近期下载不能解锁旧洞悉待办");
  assert.equal(await jobs.hasJobSince(db, userA, 12, ['analyse', 'download']), true);
  await db.deleteFrom("ruyi_jobs").where("id", "in", [recentId, unrelatedId]).execute();

  const accepted = {
    create: ['upload', 'create'], analyse: ['create', 'analyse'], results: ['analyse', 'download'],
  };
  for (const task of ['upload', 'create', 'analyse', 'download']) {
    const id = randomUUID();
    await jobs.enqueueJob(db, { id, userId: userA, username: "自动推进甲", task });
    for (const [stage, types] of Object.entries(accepted)) {
      assert.equal(await jobs.hasJobSince(db, userA, 12, types), types.includes(task),
        `${stage} 阶段应仅接受关联的近期任务类型：${task}`);
    }
    await db.deleteFrom("ruyi_jobs").where("id", "=", id).execute();
  }

  // 删除用户时外键必须拦住残留偏好，证明约束确实生效。
  await autoAdvance.setEnabled(db, userA, false);
  await assert.rejects(db.deleteFrom("ruyi_users").where("id", "=", userA).execute(), /foreign key/i);
  await autoAdvance.setEnabled(db, userA, true);
}

async function main() {
  const config = readDbConfig();
  if (config.database !== "ruyi_test" || config.host !== "127.0.0.1" || config.port !== 3306 ||
    config.user !== "ruyi" || config.password !== "ruyi") {
    throw new Error("数据库测试只允许连接本机 Docker 的 ruyi_test 测试数据库。");
  }
  const db = createDb(config);
  try {
    await clearTestData(db);
    const ids = [];
    for (const username of usernames) {
      ids.push(await users.createUser(db, {
        username, displayName: "自动推进测试用户", passwordHash: "伪造密码摘要", mustChangePassword: false,
      }));
    }
    await testRepo(db, ...ids);
    console.log("自动推进开关持久化、默认开启、关闭集合与活动窗口数据库测试通过。");
  } finally {
    try { await clearTestData(db); } finally { await db.destroy(); }
  }
}

main().catch((error) => { console.error("自动推进仓库数据库测试失败：", error); process.exitCode = 1; });
